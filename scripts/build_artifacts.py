"""Build the small artifacts the backend serves from.

Run once (takes a few minutes, needs a few GB of RAM):
    python scripts/build_artifacts.py

Outputs in artifacts/:
    drugs.parquet, genes.parquet, diseases.parquet
    drug_gene.parquet       drug -> gene edges with relation + source url (path labels)
    drug_disease.parquet    INDICATION / CONTRAINDICATION / OFF_LABEL_USE with phase + status
    T.npz  drugs x genes     binary
    M.npz  genes x diseases  evidence_score (>= threshold)
    H.npz  diseases x diseases  H[parent, child] = 1
    I.npz  drugs x diseases  approved + trial indications
    meta.json
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
import time
from pathlib import Path

import numpy as np
import polars as pl
import scipy.sparse as sp

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_graph import ROOT, scan_graph  # noqa: E402

OUT = ROOT / "artifacts"


def jp(path: str, name: str, dtype=None) -> pl.Expr:
    e = pl.col("properties").str.json_path_match(path)
    if dtype is not None:
        e = e.cast(dtype, strict=False)
    return e.alias(name)


def as_bool(name: str) -> pl.Expr:
    return (pl.col(name).str.to_lowercase() == "true").fill_null(False).alias(name)


def py_list(s: str | None) -> list:
    if not s or s == "None":
        return []
    try:
        v = ast.literal_eval(s)
        return v if isinstance(v, list) else []
    except (ValueError, SyntaxError):
        return []


def first_swissprot(s: str | None) -> str | None:
    for item in py_list(s):
        if isinstance(item, dict) and item.get("source") == "uniprot_swissprot":
            return item.get("id")
    return None


def orient(df: pl.DataFrame, left_ids: set[str]) -> pl.DataFrame:
    """Make sure `from` holds the left-hand entity (drug or disease)."""
    swap = ~pl.col("from").is_in(list(left_ids))
    return df.with_columns(
        pl.when(swap).then(pl.col("to")).otherwise(pl.col("from")).alias("from"),
        pl.when(swap).then(pl.col("from")).otherwise(pl.col("to")).alias("to"),
    )


def index_map(ids: list[str]) -> dict[str, int]:
    return {x: i for i, x in enumerate(ids)}


def matrix(rows, cols, data, shape) -> sp.csr_matrix:
    m = sp.coo_matrix(
        (np.asarray(data, dtype=np.float32), (np.asarray(rows), np.asarray(cols))),
        shape=shape,
    ).tocsr()
    m.sum_duplicates()
    return m


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-evidence", type=float, default=0.1,
                    help="keep DIS-GEN edges with evidence_score >= this")
    args = ap.parse_args()

    t0 = time.time()
    OUT.mkdir(exist_ok=True)
    nodes, edges = scan_graph()

    # ---------------- nodes ----------------
    drugs = (
        nodes.filter(pl.col("label") == "DRG")
        .select(
            pl.col("id").alias("drug_id"),
            jp("$.name", "name"),
            jp("$.synonyms", "synonyms_raw"),
            jp("$.canonical_smiles", "smiles"),
            jp("$.inchi_key", "inchi_key"),
            jp("$.is_approved", "is_approved"),
            jp("$.maximum_clinical_trial_phase", "max_phase", pl.Float64),
            jp("$.year_of_first_approval", "year_approved", pl.Float64),
            jp("$.black_box_warning", "black_box"),
            jp("$.has_been_withdrawn", "withdrawn"),
            jp("$.mrdef", "mrdef"),
            jp("$.type", "type"),
            jp("$.cd_formula", "formula"),
            jp("$.cd_mol_weight", "mol_weight", pl.Float64),
        )
        .collect()
        .with_columns(as_bool("is_approved"), as_bool("black_box"), as_bool("withdrawn"),
                      pl.col("year_approved").cast(pl.Int32, strict=False))
        .sort("drug_id")
    )
    drugs = drugs.with_columns(
        pl.col("synonyms_raw").map_elements(lambda s: [str(x) for x in py_list(s)],
                                            return_dtype=pl.List(pl.String)).alias("synonyms")
    ).drop("synonyms_raw")

    # Salt forms (METFORMIN HYDROCHLORIDE) are separate nodes linked by DRG-DRG PARENT
    # (from = parent, to = salt). Merge each salt into its parent so one drug = one row.
    salt_edges = (
        edges.filter((pl.col("label") == "DRG-DRG") & (pl.col("relation") == "PARENT"))
        .select(pl.col("from").alias("parent"), pl.col("to").alias("child"))
        .collect()
        .unique(subset="child", keep="first")
    )
    to_parent = dict(zip(salt_edges["child"].to_list(), salt_edges["parent"].to_list()))
    canon = pl.col("drug_id").replace(to_parent).alias("canon_id")
    salts = drugs.with_columns(canon).group_by("canon_id").agg(
        pl.col("is_approved").any(),
        pl.col("black_box").any(),
        pl.col("max_phase").max().alias("max_phase_all"),
        pl.col("year_approved").min().alias("year_all"),
        pl.col("name").filter(pl.col("drug_id") != pl.col("canon_id")).alias("salt_names"),
        pl.col("synonyms").list.explode(keep_nulls=False, empty_as_null=False).unique().alias("syn_all"),
    )
    drugs = (
        drugs.filter(~pl.col("drug_id").is_in(list(to_parent)))
        .join(salts.rename({"canon_id": "drug_id"}), on="drug_id", how="left", suffix="_any")
        .with_columns(
            pl.col("is_approved_any").fill_null(pl.col("is_approved")).alias("is_approved"),
            pl.col("black_box_any").fill_null(pl.col("black_box")).alias("black_box"),
            pl.max_horizontal("max_phase", "max_phase_all").alias("max_phase"),
            pl.min_horizontal("year_approved", "year_all").alias("year_approved"),
            pl.col("syn_all").fill_null(pl.col("synonyms")).alias("synonyms"),
            pl.col("salt_names").fill_null([]),
        )
        .drop("is_approved_any", "black_box_any", "max_phase_all", "year_all", "syn_all")
        .sort("drug_id")
        .with_row_index("idx")
    )
    print(f"drugs: {drugs.height} after merging {len(to_parent)} salt forms "
          f"({drugs['is_approved'].sum()} approved)")

    diseases = (
        nodes.filter(pl.col("label") == "DIS")
        .select(
            pl.col("id").alias("disease_id"),
            jp("$.name", "name"),
            jp("$.description", "description"),
            jp("$.exact_synonyms", "exact_raw"),
            jp("$.related_synonyms", "related_raw"),
            jp("$.therapeutic_areas", "areas_raw"),
        )
        .collect()
        .sort("disease_id")
    )
    diseases = diseases.with_columns(
        pl.struct("exact_raw", "related_raw").map_elements(
            lambda r: sorted({str(x) for x in py_list(r["exact_raw"]) + py_list(r["related_raw"])}),
            return_dtype=pl.List(pl.String)).alias("synonyms"),
        pl.col("areas_raw").map_elements(lambda s: [str(x) for x in py_list(s)],
                                         return_dtype=pl.List(pl.String)).alias("therapeutic_areas"),
    ).drop("exact_raw", "related_raw", "areas_raw").with_row_index("idx")
    print(f"diseases: {diseases.height}")

    drug_ids = set(drugs["drug_id"].to_list()) | set(to_parent)
    to_canon = pl.col("drug_id").replace(to_parent)
    disease_ids = set(diseases["disease_id"].to_list())

    # ---------------- edges ----------------
    dg = (
        edges.filter(pl.col("label") == "DRG-GEN")
        .select("from", "to", "relation", jp("$.source_urls[0]", "source_url"))
        .collect()
    )
    dg = orient(dg, drug_ids).rename({"from": "drug_id", "to": "gene_id"}).with_columns(to_canon)
    print(f"drug-gene edges: {dg.height}")

    dis_gen = (
        edges.filter(pl.col("label") == "DIS-GEN")
        .select("from", "to", jp("$.evidence_score", "score", pl.Float64))
        .filter(pl.col("score") >= args.min_evidence)
        .collect()
    )
    dis_gen = orient(dis_gen, disease_ids).rename({"from": "disease_id", "to": "gene_id"})
    print(f"disease-gene edges (score >= {args.min_evidence}): {dis_gen.height}")

    dd = (
        edges.filter(pl.col("label") == "DRG-DIS")
        .select(
            "from", "to", "relation",
            jp("$.highest_clinical_trial_phase", "phase", pl.Float64),
            jp("$.sources.direct", "direct_sources"),
            jp("$.reference_ids", "reference_raw"),
        )
        .collect()
    )
    dd = orient(dd, drug_ids).rename({"from": "drug_id", "to": "disease_id"}).with_columns(to_canon)
    label_derived = pl.col("phase").is_null() & pl.col("direct_sources").str.contains("DRUG_CENTRAL").fill_null(False)
    dd = dd.with_columns(
        pl.when(pl.col("relation") != "INDICATION").then(pl.lit("n/a"))
        .when((pl.col("phase") == 4.0) | label_derived).then(pl.lit("approved"))
        .when(pl.col("phase").is_in([0.5, 1.0, 2.0, 3.0])).then(pl.lit("trial"))
        .otherwise(pl.lit("other")).alias("status"),
        pl.col("reference_raw").str.extract_all(r"NCT\d{8}").fill_null([]).alias("trial_ids"),
    ).drop("direct_sources", "reference_raw")
    print("drug-disease:", dd.group_by("relation", "status").len().sort("relation", "status").rows())

    hier = (
        edges.filter((pl.col("label") == "DIS-DIS") & (pl.col("relation") == "PARENT"))
        .select(pl.col("from").alias("parent"), pl.col("to").alias("child"))
        .collect()
    )
    print(f"disease hierarchy edges: {hier.height}")

    # ---------------- genes ----------------
    gene_ids = sorted(set(dg["gene_id"].to_list()) | set(dis_gen["gene_id"].to_list()))
    genes = (
        nodes.filter((pl.col("label") == "GEN") & pl.col("id").is_in(gene_ids))
        .select(
            pl.col("id").alias("gene_id"),
            jp("$.symbol", "symbol"),
            jp("$.name", "name"),
            jp("$.associated_proteins", "proteins_raw"),
        )
        .collect()
        .sort("gene_id")
    )
    genes = genes.with_columns(
        pl.col("proteins_raw").map_elements(first_swissprot, return_dtype=pl.String).alias("uniprot_id")
    ).drop("proteins_raw").with_row_index("idx")
    print(f"genes: {genes.height} ({genes['uniprot_id'].is_not_null().sum()} with UniProt)")

    # ---------------- matrices ----------------
    di = index_map(drugs["drug_id"].to_list())
    gi = index_map(genes["gene_id"].to_list())
    si = index_map(diseases["disease_id"].to_list())
    nD, nG, nS = len(di), len(gi), len(si)

    dg_ok = dg.filter(pl.col("drug_id").is_in(list(di)) & pl.col("gene_id").is_in(list(gi)))
    T = matrix([di[x] for x in dg_ok["drug_id"]], [gi[x] for x in dg_ok["gene_id"]],
               np.ones(dg_ok.height), (nD, nG))
    T.data[:] = 1.0

    mg = dis_gen.filter(pl.col("disease_id").is_in(list(si)) & pl.col("gene_id").is_in(list(gi)))
    mg = mg.group_by("gene_id", "disease_id").agg(pl.col("score").max())
    M = matrix([gi[x] for x in mg["gene_id"]], [si[x] for x in mg["disease_id"]],
               mg["score"].to_numpy(), (nG, nS))

    hh = hier.filter(pl.col("parent").is_in(list(si)) & pl.col("child").is_in(list(si))).unique()
    H = matrix([si[x] for x in hh["parent"]], [si[x] for x in hh["child"]], np.ones(hh.height), (nS, nS))

    ind = dd.filter((pl.col("relation") == "INDICATION") & pl.col("status").is_in(["approved", "trial"]))
    ind = ind.filter(pl.col("drug_id").is_in(list(di)) & pl.col("disease_id").is_in(list(si)))
    I = matrix([di[x] for x in ind["drug_id"]], [si[x] for x in ind["disease_id"]], np.ones(ind.height), (nD, nS))
    I.data[:] = 1.0

    n_genes = np.diff(M.tocsc().indptr)
    diseases = diseases.with_columns(pl.Series("n_genes", n_genes.astype(np.int32)))

    # ---------------- write ----------------
    drugs.write_parquet(OUT / "drugs.parquet")
    genes.write_parquet(OUT / "genes.parquet")
    diseases.write_parquet(OUT / "diseases.parquet")
    (dg_ok.group_by("drug_id", "gene_id")
     .agg(pl.col("relation").unique().sort(), pl.col("source_url").drop_nulls().first())
     .write_parquet(OUT / "drug_gene.parquet"))
    dd.unique(subset=["drug_id", "disease_id", "relation", "phase"]).write_parquet(OUT / "drug_disease.parquet")
    for name, m in {"T": T, "M": M, "H": H, "I": I}.items():
        sp.save_npz(OUT / f"{name}.npz", m.tocsr())

    meta = {
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "min_evidence": args.min_evidence,
        "shapes": {"T": T.shape, "M": M.shape, "H": H.shape, "I": I.shape},
        "nnz": {"T": int(T.nnz), "M": int(M.nnz), "H": int(H.nnz), "I": int(I.nnz)},
        "n_approved_drugs": int(drugs["is_approved"].sum()),
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
    size = sum(p.stat().st_size for p in OUT.iterdir()) / 1e6
    print(json.dumps(meta, indent=2))
    print(f"artifacts: {size:.1f} MB in {OUT}  ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
