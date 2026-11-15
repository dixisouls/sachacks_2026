"""Structured drug profiles and a cohort comparison, built as LLM input.

The point is the project's core rule: the model explains and assembles, it never
invents the biology. So before any prose is written, this assembles the facts in
a shape a model can only describe:

  per drug   which genes it hits and how, which chemical groups it carries,
             which drugs in our own data resemble it, how far it has got clinically
  per cohort what every candidate has in common, and what sets each one apart

Everything here comes from the graph or from RDKit reading the drug's own
structure. Nothing is looked up on the open internet and nothing is inferred by
a model. api/evidence/ adds the outside sources separately.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

import polars as pl
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from rdkit import RDLogger
from rdkit.Chem import MolFromSmarts, MolFromSmiles

from api.scoring import Scorer

RDLogger.DisableLog("rdApp.*")
log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("ARTIFACT_DIR", ROOT / "artifacts"))

# Groups a medicinal chemist would name when asked what a molecule carries.
# Plain-English labels, because these end up in a sentence a reader sees.
FUNCTIONAL_GROUPS: dict[str, str] = {
    "carboxylic acid": "[CX3](=O)[OX2H1]",
    "primary amine": "[NX3;H2;!$(NC=O)]",
    "secondary amine": "[NX3;H1;!$(NC=O)]",
    "tertiary amine": "[NX3;H0;!$(NC=O);!$(N=*);!$(N#*)]",
    "amide": "[NX3][CX3](=[OX1])",
    "sulfonamide": "[SX4](=[OX1])(=[OX1])[NX3]",
    "phosphate": "[PX4](=O)([OX2])[OX2]",
    "ester": "[CX3](=O)[OX2][#6]",
    "ketone": "[#6][CX3](=O)[#6]",
    "alcohol": "[OX2H][CX4]",
    "phenol": "[OX2H]c",
    "ether": "[OD2]([#6])[#6]",
    "halogen": "[F,Cl,Br,I]",
    "nitrile": "[NX1]#[CX2]",
    "nitro": "[$([NX3](=O)=O)]",
    "aromatic ring": "a1aaaaa1",
    "fused aromatic system": "c1ccc2ccccc2c1",
    "piperazine": "C1CNCCN1",
    "piperidine": "C1CCNCC1",
    "morpholine": "C1COCCN1",
    "imidazole": "c1cnc[nH]1",
    "pyrimidine": "c1cncnc1",
    "guanidine": "[NX3][CX3](=[NX2])[NX3]",
    "urea": "[NX3][CX3](=[OX1])[NX3]",
    "quaternary carbon": "[CX4]([#6])([#6])([#6])[#6]",
}


@lru_cache(maxsize=1)
def _patterns() -> list[tuple[str, object]]:
    out = []
    for label, smarts in FUNCTIONAL_GROUPS.items():
        patt = MolFromSmarts(smarts)
        if patt is not None:
            out.append((label, patt))
        else:
            log.warning("bad SMARTS for %s, skipping", label)
    return out


@lru_cache(maxsize=4096)
def groups_for(smiles: str) -> tuple[str, ...]:
    mol = MolFromSmiles(smiles) if smiles else None
    if mol is None:
        return ()
    return tuple(label for label, patt in _patterns() if mol.HasSubstructMatch(patt))


# ── schemas ──────────────────────────────────────────────────────────────────

class TargetFact(BaseModel):
    gene_id: str
    symbol: str
    relations: list[str] = Field(description="how the drug acts on it, e.g. AGONIST, INHIBITOR")
    linked_to_disease: bool = Field(description="this gene is associated with the disease asked about")
    evidence_score: float | None = Field(description="strength of that gene-disease association")


class AnalogFact(BaseModel):
    drug_id: str
    name: str
    tanimoto: float
    in_candidate_list: bool = Field(description="this look-alike is itself a candidate here")
    approved: bool
    shares_target: bool = Field(description="hits at least one of the same genes")


class DrugProfile(BaseModel):
    drug_id: str
    name: str
    rank: int | None
    score: int | None
    readiness: str | None
    approved: bool
    max_phase: float | None
    year_approved: int | None
    black_box: bool
    targets: list[TargetFact]
    functional_groups: list[str] = Field(description="chemical groups read from its structure")
    analogs: list[AnalogFact] = Field(description="look-alikes in our own data")
    has_structure: bool


class CohortComparison(BaseModel):
    disease_id: str
    disease_name: str
    drugs: list[DrugProfile]
    shared_targets: list[str] = Field(description="genes every drug in the cohort hits")
    shared_groups: list[str] = Field(description="chemical groups every drug carries")
    distinguishing: dict[str, dict[str, list[str]]] = Field(
        description="per drug_id, {'targets': [...], 'groups': [...]} that no other drug here has. "
                    "Genes and chemical groups are kept apart on purpose: a model handed one "
                    "merged list will describe a gene as though it were a chemical group")
    summary: str = Field(description="plain sentences stating the facts above, for the model to build on")


# ── building ─────────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _analog_index() -> dict[str, list[tuple[str, float]]]:
    path = ARTIFACTS / "chem_pairs.parquet"
    if not path.exists():
        return {}
    pairs = pl.read_parquet(path)
    index: dict[str, list[tuple[str, float]]] = {}
    for drug_id, other_id, tan in pairs.select(
            "drug_id", "similar_drug_id", "tanimoto").iter_rows():
        index.setdefault(drug_id, []).append((other_id, tan))
        index.setdefault(other_id, []).append((drug_id, tan))  # similarity is symmetric
    for key in index:
        index[key] = sorted(set(index[key]), key=lambda x: -x[1])
    return index


def _targets(scorer: Scorer, drug_id: str, j: int) -> list[TargetFact]:
    d = scorer.drug_idx[drug_id]
    facts = []
    for g in scorer.T[d].indices.tolist():
        gene_id = scorer.gene_id[g]
        relations, _ = scorer._drug_gene_rel.get((drug_id, gene_id), ([], None))
        if isinstance(relations, str):
            relations = [relations]
        score = float(scorer.M[g, j])
        facts.append(TargetFact(
            gene_id=gene_id, symbol=scorer.gene_symbol[g],
            relations=sorted(set(relations)) or ["TARGET"],
            linked_to_disease=score > 0,
            evidence_score=round(score, 4) if score > 0 else None))
    facts.sort(key=lambda f: (not f.linked_to_disease, -(f.evidence_score or 0)))
    return facts


def build_profile(scorer: Scorer, drug_id: str, j: int, row: dict | None,
                  cohort_ids: set[str], max_analogs: int = 5) -> DrugProfile:
    d = scorer.drug_idx[drug_id]
    drug = scorer.drugs.row(d, named=True)
    smiles = drug["smiles"]
    targets = _targets(scorer, drug_id, j)
    own_genes = {t.gene_id for t in targets}

    analogs = []
    for other_id, tan in _analog_index().get(drug_id, [])[:max_analogs]:
        o = scorer.drug_idx.get(other_id)
        if o is None:
            continue
        other_genes = {scorer.gene_id[g] for g in scorer.T[o].indices.tolist()}
        analogs.append(AnalogFact(
            drug_id=other_id, name=scorer.drug_name[o] or other_id, tanimoto=round(tan, 3),
            in_candidate_list=other_id in cohort_ids,
            approved=bool(scorer.is_approved[o]),
            shares_target=bool(own_genes & other_genes)))

    return DrugProfile(
        drug_id=drug_id, name=drug["name"] or drug_id,
        rank=row.get("rank") if row else None,
        score=row.get("score") if row else None,
        readiness=row.get("readiness") if row else None,
        approved=bool(scorer.is_approved[d]),
        max_phase=drug["max_phase"], year_approved=drug["year_approved"],
        black_box=bool(drug["black_box"]),
        targets=targets, functional_groups=list(groups_for(smiles or "")),
        analogs=analogs, has_structure=bool(smiles))


def _summarize(disease_name: str, profiles: list[DrugProfile],
               shared_targets: list[str], shared_groups: list[str],
               distinguishing: dict[str, dict[str, list[str]]]) -> str:
    lines = [f"{len(profiles)} candidates for {disease_name}."]
    lines.append(f"Every one of them acts on {', '.join(shared_targets)}." if shared_targets
                 else "They do not all share a target gene.")
    if shared_groups:
        lines.append(f"All of them carry these chemical groups: {', '.join(shared_groups)}.")

    for p in profiles:
        bits = []
        linked = [t.symbol for t in p.targets if t.linked_to_disease][:3]
        if linked:
            how = p.targets[0].relations[0].lower().replace("_", " ")
            bits.append(f"{how} of {', '.join(linked)}, "
                        f"{'all' if len(linked) > 1 else 'which is'} linked to {disease_name}")
        only = distinguishing.get(p.drug_id, {})
        if only.get("targets"):
            bits.append(f"the only one here acting on {', '.join(only['targets'][:3])}")
        if only.get("groups"):
            bits.append(f"the only one carrying {', '.join(only['groups'][:3])}")
        in_list = [a.name for a in p.analogs if a.in_candidate_list]
        if in_list:
            bits.append(f"structurally close to {', '.join(in_list[:2])} in this same list")
        if p.black_box:
            bits.append("carries a black box warning")
        if p.readiness == "IN_TRIALS":
            bits.append("already in trials for this disease family")
        lines.append(f"- {p.name}: " + ("; ".join(bits) if bits else "no recorded detail"))
    return "\n".join(lines)


def build_cohort(scorer: Scorer, disease_id: str, limit: int,
                 include_investigational: bool) -> CohortComparison:
    j = scorer.disease_idx[disease_id]
    result = scorer.candidates(disease_id, limit=limit)
    rows = list(result["approved"])[:limit]
    if include_investigational:
        rows += list(result["investigational"])[:limit]
    if not rows:
        raise ValueError(f"no candidates for {result['disease']['name']}")

    cohort_ids = {r["drug_id"] for r in rows}
    profiles = [build_profile(scorer, r["drug_id"], j, r, cohort_ids) for r in rows]

    target_sets = [{t.symbol for t in p.targets} for p in profiles]
    group_sets = [set(p.functional_groups) for p in profiles]
    shared_targets = sorted(set.intersection(*target_sets)) if target_sets else []
    shared_groups = sorted(set.intersection(*group_sets)) if group_sets else []

    distinguishing: dict[str, dict[str, list[str]]] = {}
    for i, p in enumerate(profiles):
        rest_t = target_sets[:i] + target_sets[i + 1:]
        rest_g = group_sets[:i] + group_sets[i + 1:]
        others_t = set().union(*rest_t) if rest_t else set()
        others_g = set().union(*rest_g) if rest_g else set()
        distinguishing[p.drug_id] = {
            "targets": sorted(target_sets[i] - others_t),
            "groups": sorted(group_sets[i] - others_g),
        }

    return CohortComparison(
        disease_id=disease_id, disease_name=result["disease"]["name"], drugs=profiles,
        shared_targets=shared_targets, shared_groups=shared_groups,
        distinguishing=distinguishing,
        summary=_summarize(result["disease"]["name"], profiles,
                           shared_targets, shared_groups, distinguishing))


# ── routes ───────────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api", tags=["profile"])
_scorer: Scorer | None = None


def scorer() -> Scorer:
    global _scorer
    if _scorer is None:
        _scorer = Scorer(ARTIFACTS)
    return _scorer


@router.get("/profile", response_model=DrugProfile)
def drug_profile(
    drug_id: str = Query(description="e.g. CHEMBL701"),
    disease_id: str = Query(description="e.g. MONDO_0010726"),
) -> DrugProfile:
    """Everything our own data knows about one drug, relative to one disease."""
    s = scorer()
    if drug_id not in s.drug_idx:
        raise HTTPException(404, f"unknown drug_id {drug_id}")
    if disease_id not in s.disease_idx:
        raise HTTPException(404, f"unknown disease_id {disease_id}")
    return build_profile(s, drug_id, s.disease_idx[disease_id], None, set())


@router.get("/cohort", response_model=CohortComparison)
def cohort(
    disease_id: str = Query(description="e.g. MONDO_0010726"),
    limit: int = Query(6, ge=2, le=15, description="candidates per list"),
    include_investigational: bool = Query(False, description="also profile the not-approved list"),
) -> CohortComparison:
    """Side-by-side facts for the top candidates: what they share, what sets each apart.

    `summary` is written to be handed to a model as grounded input.
    """
    s = scorer()
    if disease_id not in s.disease_idx:
        raise HTTPException(404, f"unknown disease_id {disease_id}")
    try:
        return build_cohort(s, disease_id, limit, include_investigational)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
