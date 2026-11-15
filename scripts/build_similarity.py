"""Build the two similarity layers that let scoring reach past the graph's own edges.

Run after build_artifacts.py:

    python scripts/build_similarity.py              # both layers
    python scripts/build_similarity.py --only chem  # compounds only (no download needed)

Outputs in artifacts/:
    C.npz           drugs x drugs   chemical similarity (RDKit Morgan fingerprint, Tanimoto)
    chem_pairs.parquet              the same pairs as a readable table, for the UI
    S.npz           genes x genes   protein sequence similarity (MMseqs2 percent identity)
    homolog_pairs.parquet           the same pairs with identity, e-value and coverage

These power two extra path types (see architecture.md section 4.2):
    C  drug A -chemically similar-> drug B -targets-> gene -associated-> disease
    D  drug -targets-> protein P -sequence similar-> protein Q -associated-> disease

Compounds need only rdkit, so they work the same on macOS and Windows.
Sequences need the `mmseqs` binary (macOS/Linux: brew or conda install mmseqs2).
Without it the sequence layer is skipped and scoring runs without it.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import polars as pl
import requests
import scipy.sparse as sp

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_graph import ROOT  # noqa: E402

ART = ROOT / "artifacts"
DATA = ROOT / "data"
PROTEOME = DATA / "uniprot_human_reviewed.fasta.gz"
UNIPROT_URL = (
    "https://rest.uniprot.org/uniprotkb/stream"
    "?query=%28organism_id%3A9606%29+AND+%28reviewed%3Atrue%29&format=fasta&compressed=true"
)


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------- compounds --
def build_chemical(drugs: pl.DataFrame, T: sp.csr_matrix, min_sim: float, top_k: int):
    """Tanimoto similarity between drug structures.

    Columns are restricted to drugs that have at least one gene target, because
    the path only pays off when the look-alike drug has a target to borrow.
    """
    from rdkit import Chem, DataStructs, RDLogger
    from rdkit.Chem import rdFingerprintGenerator

    RDLogger.DisableLog("rdApp.*")
    gen = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)

    smiles = drugs["smiles"].to_list()
    names = drugs["name"].to_list()
    ids = drugs["drug_id"].to_list()
    has_target = np.diff(T.tocsr().indptr) > 0

    fps: dict[int, object] = {}
    for i, smi in enumerate(smiles):
        if not smi:
            continue
        mol = Chem.MolFromSmiles(smi)
        if mol is not None:
            fps[i] = gen.GetFingerprint(mol)
    log(f"  fingerprints: {len(fps)} of {len(smiles)} drugs")

    col_idx = [i for i in fps if has_target[i]]
    col_fps = [fps[i] for i in col_idx]
    col_arr = np.array(col_idx)
    log(f"  comparing every drug against {len(col_idx)} drugs that have targets")

    rows, cols, vals = [], [], []
    for i, fp in fps.items():
        sims = np.asarray(DataStructs.BulkTanimotoSimilarity(fp, col_fps), dtype=np.float32)
        keep = np.flatnonzero(sims >= min_sim)
        keep = keep[col_arr[keep] != i]  # never match a drug to itself
        if len(keep) > top_k:
            keep = keep[np.argsort(-sims[keep])[:top_k]]
        rows.extend([i] * len(keep))
        cols.extend(col_arr[keep].tolist())
        vals.extend(sims[keep].tolist())

    n = drugs.height
    C = sp.coo_matrix((np.array(vals, dtype=np.float32), (rows, cols)), shape=(n, n)).tocsr()
    pairs = pl.DataFrame({
        "drug_id": [ids[r] for r in rows],
        "drug_name": [names[r] for r in rows],
        "similar_drug_id": [ids[c] for c in cols],
        "similar_drug_name": [names[c] for c in cols],
        "tanimoto": [round(float(v), 3) for v in vals],
    })
    return C, pairs


# --------------------------------------------------------------- sequences --
def download_proteome() -> None:
    if PROTEOME.exists() and PROTEOME.stat().st_size > 1_000_000:
        log(f"  proteome already downloaded: {PROTEOME}")
        return
    DATA.mkdir(exist_ok=True)
    log("  downloading the reviewed human proteome from UniProt (~20k sequences)...")
    with requests.get(UNIPROT_URL, stream=True, timeout=300,
                      headers={"User-Agent": "repurposekg-hackathon"}) as r:
        r.raise_for_status()
        tmp = PROTEOME.with_suffix(".part")
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
        tmp.replace(PROTEOME)
    log(f"  saved {PROTEOME.stat().st_size / 1e6:.1f} MB")


def read_fasta(path: Path) -> dict[str, str]:
    """UniProt headers look like sp|P35367|HRH1_HUMAN ... -> key on the accession."""
    seqs: dict[str, str] = {}
    acc, buf = None, []
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt") as fh:
        for line in fh:
            if line.startswith(">"):
                if acc:
                    seqs[acc] = "".join(buf)
                parts = line[1:].split("|")
                acc = parts[1] if len(parts) > 2 else line[1:].split()[0]
                buf = []
            else:
                buf.append(line.strip())
    if acc:
        seqs[acc] = "".join(buf)
    return seqs


def build_homology(genes: pl.DataFrame, T: sp.csr_matrix, M: sp.csr_matrix,
                   min_identity: float, max_evalue: float, top_k: int):
    mmseqs = shutil.which("mmseqs")
    if not mmseqs:
        log("  mmseqs not found on PATH, skipping the sequence layer.")
        log("  install it with:  brew install mmseqs2   (or: conda install -c bioconda mmseqs2)")
        return None, None

    download_proteome()
    seqs = read_fasta(PROTEOME)
    log(f"  sequences read: {len(seqs)}")

    uni = genes["uniprot_id"].to_list()
    symbols = genes["symbol"].to_list()
    gene_ids = genes["gene_id"].to_list()
    # one gene per accession; if two gene rows share one accession, keep the first
    acc_to_gene: dict[str, int] = {}
    for i, a in enumerate(uni):
        if a and a in seqs and a not in acc_to_gene:
            acc_to_gene[a] = i

    is_target = np.zeros(genes.height, dtype=bool)
    is_target[np.unique(T.tocoo().col)] = True
    has_disease = np.diff(M.tocsr().indptr) > 0

    query_accs = [a for a, i in acc_to_gene.items() if is_target[i]]
    target_accs = [a for a, i in acc_to_gene.items() if has_disease[i]]
    log(f"  query: {len(query_accs)} drug-target proteins   "
        f"against: {len(target_accs)} disease-associated proteins")

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        qf, tf, out = td / "q.fasta", td / "t.fasta", td / "hits.tsv"
        for path, accs in ((qf, query_accs), (tf, target_accs)):
            with open(path, "w") as fh:
                for a in accs:
                    fh.write(f">{a}\n{seqs[a]}\n")
        cmd = [mmseqs, "easy-search", str(qf), str(tf), str(out), str(td / "tmp"),
               "--min-seq-id", str(min_identity), "-e", str(max_evalue),
               "-c", "0.6", "--cov-mode", "0", "-s", "5.7", "--threads", "4",
               "--format-output", "query,target,fident,evalue,bits,qcov,tcov"]
        log("  running mmseqs easy-search...")
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            log("  mmseqs failed:\n" + proc.stderr[-1500:])
            return None, None
        hits = pl.read_csv(out, separator="\t", has_header=False,
                           new_columns=["query", "target", "fident", "evalue", "bits", "qcov", "tcov"])

    hits = hits.filter(pl.col("query") != pl.col("target"))
    hits = (hits.sort("bits", descending=True)
                .group_by("query", maintain_order=True).head(top_k))
    log(f"  homolog pairs kept: {hits.height}")

    rows = [acc_to_gene[q] for q in hits["query"]]
    cols = [acc_to_gene[t] for t in hits["target"]]
    vals = hits["fident"].to_numpy().astype(np.float32)  # fraction identity, 0..1
    n = genes.height
    S = sp.coo_matrix((vals, (rows, cols)), shape=(n, n)).tocsr()

    pairs = pl.DataFrame({
        "gene_id": [gene_ids[r] for r in rows],
        "symbol": [symbols[r] for r in rows],
        "homolog_gene_id": [gene_ids[c] for c in cols],
        "homolog_symbol": [symbols[c] for c in cols],
        "identity": [round(float(v), 3) for v in vals],
        "evalue": hits["evalue"].to_list(),
        "query_coverage": [round(float(v), 3) for v in hits["qcov"]],
    })
    return S, pairs


# -------------------------------------------------------------------- main --
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["chem", "seq"], help="build just one layer")
    ap.add_argument("--min-tanimoto", type=float, default=0.55,
                    help="chemical similarity cutoff (0.55 is a common look-alike threshold)")
    ap.add_argument("--chem-top-k", type=int, default=15)
    ap.add_argument("--min-identity", type=float, default=0.4,
                    help="sequence identity cutoff, 0.4 = 40 percent")
    ap.add_argument("--max-evalue", type=float, default=1e-10)
    ap.add_argument("--seq-top-k", type=int, default=10)
    args = ap.parse_args()

    t0 = time.time()
    drugs = pl.read_parquet(ART / "drugs.parquet")
    genes = pl.read_parquet(ART / "genes.parquet")
    T = sp.load_npz(ART / "T.npz").tocsr()
    M = sp.load_npz(ART / "M.npz").tocsr()
    meta = json.loads((ART / "meta.json").read_text())

    if args.only != "seq":
        log("chemical similarity")
        C, pairs = build_chemical(drugs, T, args.min_tanimoto, args.chem_top_k)
        sp.save_npz(ART / "C.npz", C)
        pairs.write_parquet(ART / "chem_pairs.parquet")
        meta["chem"] = {"nnz": int(C.nnz), "min_tanimoto": args.min_tanimoto,
                        "top_k": args.chem_top_k,
                        "drugs_with_a_look_alike": int((np.diff(C.indptr) > 0).sum())}
        log(f"  C.npz: {C.nnz} pairs, {meta['chem']['drugs_with_a_look_alike']} drugs have one")

    if args.only != "chem":
        log("protein sequence similarity")
        S, pairs = build_homology(genes, T, M, args.min_identity, args.max_evalue, args.seq_top_k)
        if S is not None:
            sp.save_npz(ART / "S.npz", S)
            pairs.write_parquet(ART / "homolog_pairs.parquet")
            meta["homology"] = {"nnz": int(S.nnz), "min_identity": args.min_identity,
                                "max_evalue": args.max_evalue, "top_k": args.seq_top_k,
                                "targets_with_a_homolog": int((np.diff(S.indptr) > 0).sum())}
            log(f"  S.npz: {S.nnz} pairs, {meta['homology']['targets_with_a_homolog']} "
                f"drug targets have a homolog")

    (ART / "meta.json").write_text(json.dumps(meta, indent=2))
    size = sum(p.stat().st_size for p in ART.iterdir()) / 1e6
    log(f"artifacts now {size:.1f} MB  ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
