"""Candidate scoring over the prebuilt artifacts (see architecture.md section 4).

Four path types, scored one disease column at a time:

  A  shared biology    drug -targets-> gene -associated-> disease
  B  sibling disease   drug -treats-> disease -shares parent-> disease
  C  chemical look-alike
                       drug -similar structure-> drug B -targets-> gene -associated-> disease
  D  protein homolog   drug -targets-> protein P -similar sequence-> protein Q -associated-> disease

A and B come from graph edges. C and D are inferred from structure and sequence
similarity, so everything they produce is labelled `inferred` and carries the
number it rests on (Tanimoto coefficient, percent identity).

C and D need artifacts/C.npz and artifacts/S.npz from scripts/build_similarity.py.
Both are optional: without them the scorer falls back to A and B alone.

Results come back as two ranked lists:
  approved        approved, not withdrawn, not already approved for the disease family
  investigational everything else (trial-stage compounds, withdrawn drugs)
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import polars as pl
import scipy.sparse as sp

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACTS = ROOT / "artifacts"

# Component weights. Path A is the anchor at 1.0; tune the rest with scripts/rediscovery.py.
DEFAULT_WEIGHTS = {"shared_biology": 1.0, "sibling_disease": 0.5,
                   "chemical_analog": 0.4, "protein_homolog": 0.4}


def _degree_normalize(X: sp.csr_matrix, damping: float) -> sp.csr_matrix:
    """D_row^-w . X . D_col^-w with degrees = number of edges, not weight sums."""
    B = X.copy()
    B.data[:] = 1.0
    r = np.asarray(B.sum(axis=1)).ravel()
    c = np.asarray(B.sum(axis=0)).ravel()
    r[r == 0] = 1
    c[c == 0] = 1
    return (sp.diags(r ** -damping) @ X @ sp.diags(c ** -damping)).tocsr()


def _unit(v: np.ndarray) -> np.ndarray:
    m = v.max() if v.size else 0.0
    return v / m if m > 0 else v


@dataclass
class FamilyInfo:
    members: set[int]
    approved: set[int] = field(default_factory=set)  # drug idx with an approved indication
    trials: dict[int, tuple[float, list[str]]] = field(default_factory=dict)  # drug -> (phase, NCTs)
    contra: set[int] = field(default_factory=set)
    off_label: set[int] = field(default_factory=set)


class Scorer:
    def __init__(self, artifacts: Path = DEFAULT_ARTIFACTS, weights: dict | None = None,
                 damping: float = 0.5, hide: set[tuple[str, str]] | None = None):
        """hide: approved (drug_id, disease_id) indications to pretend we never knew about.
        Used only by scripts/rediscovery.py. It removes those edges from both the
        sibling-disease path and the already-approved exclusion, so a held-out
        treatment has a fair chance of being rediscovered."""
        self.w = {**DEFAULT_WEIGHTS, **(weights or {})}
        self.hide = hide or set()
        a = Path(artifacts)
        self.drugs = pl.read_parquet(a / "drugs.parquet")
        self.genes = pl.read_parquet(a / "genes.parquet")
        self.diseases = pl.read_parquet(a / "diseases.parquet")
        self.drug_gene = pl.read_parquet(a / "drug_gene.parquet")
        self.drug_disease = pl.read_parquet(a / "drug_disease.parquet")

        T = sp.load_npz(a / "T.npz").tocsr()
        M = sp.load_npz(a / "M.npz").tocsr()
        H = sp.load_npz(a / "H.npz").tocsr()
        self.I = sp.load_npz(a / "I.npz").tocsr()
        self.M = M.tocsc()  # raw evidence scores, column access
        self.T = T

        self.Tn = _degree_normalize(T, damping)
        self.Mn = _degree_normalize(M, damping).tocsc()

        sib = (H.T @ H).tocsr()  # child x child through a shared parent
        sib.setdiag(0)
        sib.eliminate_zeros()
        sib.data[:] = 1.0
        self.Sib = sib.tocsc()
        self.children = H  # csr: row = parent
        self.parents = H.tocsc()  # csc: column = child

        # optional similarity layers
        self.C = self.Cn = None
        if (a / "C.npz").exists():
            self.C = sp.load_npz(a / "C.npz").tocsr()
            self.Cn = _degree_normalize(self.C, damping)
        self.S = self.Sn = None
        if (a / "S.npz").exists():
            self.S = sp.load_npz(a / "S.npz").tocsr()
            self.Sn = _degree_normalize(self.S, damping)
        self.has_chem = self.C is not None
        self.has_homolog = self.S is not None

        self.drug_idx = {x: i for i, x in enumerate(self.drugs["drug_id"].to_list())}
        self.gene_idx = {x: i for i, x in enumerate(self.genes["gene_id"].to_list())}
        self.disease_idx = {x: i for i, x in enumerate(self.diseases["disease_id"].to_list())}

        d = self.drugs
        self.drug_name = d["name"].to_list()
        self.drug_id = d["drug_id"].to_list()
        self.is_approved = d["is_approved"].to_numpy()
        self.withdrawn = d["withdrawn"].to_numpy()
        self.black_box = d["black_box"].to_numpy()
        self.max_phase = d["max_phase"].to_list()
        self.year = d["year_approved"].to_list()
        self.gene_symbol = self.genes["symbol"].to_list()
        self.gene_id = self.genes["gene_id"].to_list()
        self.uniprot = self.genes["uniprot_id"].to_list()
        self.disease_name = self.diseases["name"].to_list()
        self.disease_id = self.diseases["disease_id"].to_list()

        if self.hide:
            self._apply_holdout()
        self._index_drug_disease()
        self._drug_gene_rel = {
            (r[0], r[1]): (r[2], r[3]) for r in self.drug_gene.select(
                "drug_id", "gene_id", "relation", "source_url").iter_rows()
        }

    # ------------------------------------------------------------------ setup
    def _apply_holdout(self) -> None:
        """Drop the hidden approved indications, then rebuild I from what is left.
        A pair is only removed from I if no trial indication survives for it."""
        keep = ~(
            (pl.col("relation") == "INDICATION")
            & (pl.col("status") == "approved")
            & pl.struct("drug_id", "disease_id").map_elements(
                lambda r: (r["drug_id"], r["disease_id"]) in self.hide, return_dtype=pl.Boolean)
        )
        self.drug_disease = self.drug_disease.filter(keep)

        ind = self.drug_disease.filter(
            (pl.col("relation") == "INDICATION") & pl.col("status").is_in(["approved", "trial"]))
        rows, cols = [], []
        for drug_id, dis_id in ind.select("drug_id", "disease_id").iter_rows():
            di, si = self.drug_idx.get(drug_id), self.disease_idx.get(dis_id)
            if di is not None and si is not None:
                rows.append(di)
                cols.append(si)
        I = sp.coo_matrix((np.ones(len(rows), dtype=np.float32), (rows, cols)),
                          shape=self.I.shape).tocsr()
        I.data[:] = 1.0
        self.I = I

    def _index_drug_disease(self) -> None:
        self.by_disease: dict[int, list[tuple]] = defaultdict(list)
        for drug_id, dis_id, rel, phase, status, trial_ids in self.drug_disease.select(
            "drug_id", "disease_id", "relation", "phase", "status", "trial_ids"
        ).iter_rows():
            di, si = self.drug_idx.get(drug_id), self.disease_idx.get(dis_id)
            if di is None or si is None:
                continue
            self.by_disease[si].append((di, rel, phase, status, trial_ids or []))

    # ---------------------------------------------------------------- family
    def family(self, j: int) -> FamilyInfo:
        members = {j}
        members.update(self.parents[:, j].indices.tolist())
        stack = [j]
        while stack:  # every descendant
            p = stack.pop()
            for c in self.children[p].indices.tolist():
                if c not in members:
                    members.add(c)
                    stack.append(c)
        info = FamilyInfo(members=members)
        for s in members:
            for di, rel, phase, status, trial_ids in self.by_disease.get(s, []):
                if rel == "INDICATION" and status == "approved":
                    info.approved.add(di)
                elif rel == "INDICATION" and status == "trial":
                    prev = info.trials.get(di, (0.0, []))
                    info.trials[di] = (max(prev[0], phase or 0.0),
                                       sorted(set(prev[1]) | set(trial_ids)))
                elif rel == "CONTRAINDICATION":
                    info.contra.add(di)
                elif rel == "OFF_LABEL_USE":
                    info.off_label.add(di)
        return info

    # --------------------------------------------------------------- scoring
    def score_column(self, j: int) -> dict:
        """All four components for one disease, plus the intermediates paths need."""
        mcol = self.Mn[:, j]                                   # genes x 1
        a_raw = np.asarray((self.Tn @ mcol).todense()).ravel()  # drugs
        b_raw = np.asarray((self.I @ self.Sib[:, j]).todense()).ravel().astype(np.float64)

        c_raw = np.zeros_like(a_raw)
        if self.Cn is not None:
            c_raw = self.Cn @ a_raw   # look-alike's own path-A strength, borrowed

        d_raw = np.zeros_like(a_raw)
        gene_via_homolog = None
        if self.Sn is not None:
            gene_via_homolog = np.asarray((self.Sn @ mcol).todense()).ravel()  # genes
            d_raw = self.Tn @ gene_via_homolog

        parts = {"shared_biology": _unit(a_raw), "sibling_disease": _unit(b_raw),
                 "chemical_analog": _unit(c_raw), "protein_homolog": _unit(d_raw)}
        total = sum(self.w[k] * v for k, v in parts.items())
        return {"total": total, "parts": parts, "a_raw": a_raw,
                "mcol": np.asarray(mcol.todense()).ravel(),
                "gene_via_homolog": gene_via_homolog}

    # ------------------------------------------------------- path extraction
    def top_genes(self, d: int, j: int, k: int = 3,
                  mcol: np.ndarray | None = None) -> list[tuple[int, float]]:
        """Path A: genes the drug targets that are associated with the disease."""
        if mcol is None:
            mcol = self.Mn[:, j].toarray().ravel()
        row = self.Tn[d]
        contrib = row.data * mcol[row.indices]
        order = np.argsort(-contrib)
        return [(int(row.indices[i]), float(contrib[i])) for i in order[:k] if contrib[i] > 0]

    def top_analogs(self, d: int, a_raw: np.ndarray, k: int = 3) -> list[tuple[int, float, float]]:
        """Path C: look-alike drugs whose own targets reach the disease.
        Returns (other drug idx, raw Tanimoto, contribution)."""
        if self.C is None:
            return []
        row = self.Cn[d]
        contrib = row.data * a_raw[row.indices]
        order = np.argsort(-contrib)
        out = []
        for i in order[:k]:
            if contrib[i] <= 0:
                continue
            other = int(row.indices[i])
            out.append((other, float(self.C[d, other]), float(contrib[i])))
        return out

    def top_homologs(self, d: int, mcol: np.ndarray, k: int = 3) -> list[tuple[int, int, float, float]]:
        """Path D: a protein the drug targets whose close relative is linked to the disease.
        Returns (target gene P, homolog gene Q, raw identity, contribution)."""
        if self.S is None:
            return []
        out = []
        trow = self.Tn[d]
        for p_pos, p in enumerate(trow.indices):
            srow = self.Sn[int(p)]
            if srow.nnz == 0:
                continue
            contrib = trow.data[p_pos] * srow.data * mcol[srow.indices]
            for i in np.argsort(-contrib)[:k]:
                if contrib[i] <= 0:
                    continue
                q = int(srow.indices[i])
                out.append((int(p), q, float(self.S[int(p), q]), float(contrib[i])))
        out.sort(key=lambda x: -x[3])
        return out[:k]

    # ------------------------------------------------------------ candidates
    def candidates(self, disease_id: str, limit: int = 50) -> dict:
        j = self.disease_idx[disease_id]
        sc = self.score_column(j)
        score, parts = sc["total"], sc["parts"]
        fam = self.family(j)

        order = np.argsort(-score)
        order = order[score[order] > 0]
        top = float(score[order[0]]) if len(order) else 1.0

        approved, investigational = [], []
        excluded = 0
        for d in order:
            d = int(d)
            if d in fam.approved:
                excluded += 1
                continue
            is_app = bool(self.is_approved[d]) and not bool(self.withdrawn[d])
            bucket = approved if is_app else investigational
            if len(bucket) >= limit:
                if len(approved) >= limit and len(investigational) >= limit:
                    break
                continue
            bucket.append(self._row(d, j, score, parts, sc, top, fam, is_app, len(bucket) + 1))

        n_genes = int(self.diseases["n_genes"][j])
        warning = "LOW_GRAPH_COVERAGE" if (n_genes < 5 and not len(order)) else None
        return {
            "disease": self.disease_summary(j),
            "approved": approved,
            "investigational": investigational,
            "excluded_count": excluded,
            "already_approved_total": len(fam.approved),
            "family_size": len(fam.members),
            "weights": self.w,
            "layers": {"chemical_analog": self.has_chem, "protein_homolog": self.has_homolog},
            "warning": warning,
        }

    def _row(self, d, j, score, parts, sc, top, fam: FamilyInfo, is_app: bool, rank: int) -> dict:
        trial = fam.trials.get(d)
        if is_app:
            if d in fam.contra or self.black_box[d]:
                readiness = "SAFETY_CONCERN"
            elif trial:
                readiness = "IN_TRIALS"
            elif d in fam.off_label:
                readiness = "OFF_LABEL"
            else:
                readiness = "APPROVED_UNTESTED"
        else:
            if self.withdrawn[d]:
                readiness = "WITHDRAWN"
            elif d in fam.contra:
                readiness = "SAFETY_CONCERN"
            elif trial:
                readiness = "IN_TRIALS"
            else:
                readiness = "INVESTIGATIONAL"

        comp = {k: round(float(v[d]), 4) for k, v in parts.items()}
        lead = max(comp, key=lambda k: self.w[k] * comp[k])
        genes = self.top_genes(d, j, 3, sc["mcol"])
        year = self.year[d]
        return {
            "rank": rank,
            "drug_id": self.drug_id[d],
            "drug_name": self.drug_name[d],
            "score": round(100 * float(score[d]) / top),
            "score_components": comp,
            "lead_path": lead if comp[lead] > 0 else None,
            "inferred_only": comp["shared_biology"] == 0 and comp["sibling_disease"] == 0,
            "readiness": readiness,
            "approved": is_app,
            "max_phase": self.max_phase[d],
            "trial_phase": trial[0] if trial else None,
            "trial_ids": trial[1][:5] if trial else [],
            "top_gene_symbols": [self.gene_symbol[g] for g, _ in genes],
            "year_approved": int(year) if year is not None else None,
            "black_box": bool(self.black_box[d]),
        }

    # ----------------------------------------------------------------- paths
    def paths(self, drug_id: str, disease_id: str, k: int = 5) -> dict:
        d, j = self.drug_idx[drug_id], self.disease_idx[disease_id]
        sc = self.score_column(j)
        mcol, a_raw = sc["mcol"], sc["a_raw"]

        nodes = {drug_id: {"id": drug_id, "type": "drug", "label": self.drug_name[d]},
                 disease_id: {"id": disease_id, "type": "disease", "label": self.disease_name[j]}}
        edges: list[dict] = []
        paths: list[dict] = []

        def add_gene(g: int) -> str:
            gid = self.gene_id[g]
            nodes.setdefault(gid, {"id": gid, "type": "gene", "label": self.gene_symbol[g],
                                   "uniprot_id": self.uniprot[g]})
            return gid

        def gene_disease_edge(gid: str, g: int) -> None:
            edges.append({"source": gid, "target": disease_id, "relation": "ASSOCIATED_WITH",
                          "weight": round(float(self.M[g, j]), 4),
                          "citation": f"KG:{disease_id}|{gid}", "inferred": False})

        def target_edge(src_drug: str, gid: str) -> None:
            rels, url = self._drug_gene_rel.get((src_drug, gid), (["TARGET"], None))
            edges.append({"source": src_drug, "target": gid,
                          "relation": ", ".join(rels) if isinstance(rels, list) else str(rels),
                          "weight": None, "citation": url or f"KG:{src_drug}|{gid}",
                          "inferred": False})

        # --- A: shared biology
        for g, contrib in self.top_genes(d, j, k, mcol):
            gid = add_gene(g)
            target_edge(drug_id, gid)
            gene_disease_edge(gid, g)
            paths.append({"type": "shared_biology", "nodes": [drug_id, gid, disease_id],
                          "contribution": round(contrib, 5), "inferred": False,
                          "explanation": f"{self.drug_name[d]} targets {self.gene_symbol[g]}, "
                                         f"which is associated with {self.disease_name[j]}"})

        # --- B: sibling disease
        treated = set(self.I[d].indices.tolist())
        for s in [int(x) for x in self.Sib[:, j].indices if int(x) in treated][:3]:
            sid = self.disease_id[s]
            nodes.setdefault(sid, {"id": sid, "type": "disease", "label": self.disease_name[s]})
            edges.append({"source": drug_id, "target": sid, "relation": "INDICATION",
                          "weight": None, "citation": f"KG:{drug_id}|{sid}", "inferred": False})
            edges.append({"source": sid, "target": disease_id, "relation": "SIBLING_OF",
                          "weight": None, "citation": None, "inferred": False})
            paths.append({"type": "sibling_disease", "nodes": [drug_id, sid, disease_id],
                          "contribution": None, "inferred": False,
                          "explanation": f"{self.drug_name[d]} treats {self.disease_name[s]}, "
                                         f"a sibling of {self.disease_name[j]}"})

        # --- C: chemical look-alike
        for other, tanimoto, contrib in self.top_analogs(d, a_raw, 3):
            oid = self.drug_id[other]
            nodes.setdefault(oid, {"id": oid, "type": "drug", "label": self.drug_name[other]})
            edges.append({"source": drug_id, "target": oid, "relation": "SIMILAR_STRUCTURE",
                          "weight": round(tanimoto, 3),
                          "citation": f"CHEM:{drug_id}|{oid}|tanimoto={tanimoto:.2f}",
                          "inferred": True})
            og = self.top_genes(other, j, 1, mcol)
            chain = [drug_id, oid]
            if og:
                g = og[0][0]
                gid = add_gene(g)
                target_edge(oid, gid)
                gene_disease_edge(gid, g)
                chain += [gid, disease_id]
                why = (f"{self.drug_name[d]} is {tanimoto:.0%} structurally similar to "
                       f"{self.drug_name[other]}, which targets {self.gene_symbol[g]}, "
                       f"a gene associated with {self.disease_name[j]}")
            else:
                chain += [disease_id]
                why = (f"{self.drug_name[d]} is {tanimoto:.0%} structurally similar to "
                       f"{self.drug_name[other]}")
            paths.append({"type": "chemical_analog", "nodes": chain,
                          "contribution": round(contrib, 5), "inferred": True,
                          "similarity": round(tanimoto, 3), "explanation": why})

        # --- D: protein homolog
        for p, q, identity, contrib in self.top_homologs(d, mcol, 3):
            pid, qid = add_gene(p), add_gene(q)
            target_edge(drug_id, pid)
            edges.append({"source": pid, "target": qid, "relation": "SIMILAR_SEQUENCE",
                          "weight": round(identity, 3),
                          "citation": f"SEQ:{self.uniprot[p]}|{self.uniprot[q]}|identity={identity:.2f}",
                          "inferred": True})
            gene_disease_edge(qid, q)
            paths.append({"type": "protein_homolog", "nodes": [drug_id, pid, qid, disease_id],
                          "contribution": round(contrib, 5), "inferred": True,
                          "similarity": round(identity, 3),
                          "explanation": f"{self.drug_name[d]} targets {self.gene_symbol[p]}, whose "
                                         f"protein is {identity:.0%} identical to {self.gene_symbol[q]}, "
                                         f"a gene associated with {self.disease_name[j]}"})

        paths.sort(key=lambda p: -(p["contribution"] or 0))
        return {"nodes": list(nodes.values()), "edges": edges, "paths": paths}

    def disease_summary(self, j: int) -> dict:
        r = self.diseases.row(j, named=True)
        return {"disease_id": r["disease_id"], "name": r["name"], "n_genes": r["n_genes"],
                "description": r["description"], "therapeutic_areas": r["therapeutic_areas"]}
