"""Side-by-side structure comparison for the chemical look-alike path.

Scoring path C says "this drug resembles that one, which targets a disease gene".
This endpoint shows *why*: both molecules drawn as SVG with the shared scaffold
highlighted, so a reader can see the common core rather than take a number on trust.

It also reports two similarity numbers, which matters for honesty:

  tanimoto         the flat 2D value, which is what scoring actually used
  tanimoto_stereo  the same comparison with three-dimensional handedness included

Baclofen and arbaclofen score 1.00 flat but 0.93 with stereochemistry, because
they are mirror images. Showing only the flat number would overstate the claim,
so the caption is written from both.

Mount from api/main.py with:  app.include_router(compare.router)
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

import polars as pl
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from rdkit import DataStructs, RDLogger
from rdkit.Chem import Mol, MolFromSmarts, MolFromSmiles, rdFingerprintGenerator, rdFMCS
from rdkit.Chem.Draw import rdMolDraw2D

RDLogger.DisableLog("rdApp.*")
log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("ARTIFACT_DIR", ROOT / "artifacts"))

WIDTH, HEIGHT = 340, 260
MCS_TIMEOUT = 5
HIGHLIGHT = (0.13, 0.63, 0.52)  # teal, readable on light and dark backgrounds

_plain = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
_stereo = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048, includeChirality=True)


class MoleculeImage(BaseModel):
    drug_id: str
    name: str
    smiles: str
    svg: str = Field(description="inline SVG, shared scaffold highlighted")
    n_atoms: int
    n_shared_atoms: int


class Comparison(BaseModel):
    tanimoto: float = Field(description="flat 2D similarity; the value scoring used")
    tanimoto_stereo: float = Field(
        description="same comparison including three-dimensional handedness")
    stereo_only_difference: bool = Field(
        description="identical connectivity, differing only in stereochemistry")
    shared_atoms: int
    shared_smarts: str = Field(description="SMARTS of the maximum common substructure")
    left: MoleculeImage
    right: MoleculeImage
    caption: str = Field(description="one plain sentence, safe to render as-is")


@lru_cache(maxsize=1)
def _drugs() -> dict[str, dict]:
    frame = pl.read_parquet(ARTIFACTS / "drugs.parquet", columns=["drug_id", "name", "smiles"])
    return {r["drug_id"]: r for r in frame.iter_rows(named=True)}


def _render(mol: Mol, highlight: list[int]) -> str:
    drawer = rdMolDraw2D.MolDraw2DSVG(WIDTH, HEIGHT)
    options = drawer.drawOptions()
    options.clearBackground = False  # let the page background show through
    rdMolDraw2D.PrepareAndDrawMolecule(
        drawer, mol,
        highlightAtoms=highlight,
        highlightAtomColors={i: HIGHLIGHT for i in highlight},
    )
    drawer.FinishDrawing()
    return drawer.GetDrawingText()


def _caption(left: str, right: str, tanimoto: float, stereo: float,
             shared: int, total: int, stereo_only: bool) -> str:
    if stereo_only:
        return (f"{left} and {right} have identical connectivity and differ only in "
                f"stereochemistry ({stereo:.0%} similar once that is compared)")
    return (f"{left} is {tanimoto:.0%} structurally similar to {right}, "
            f"sharing {shared} of {total} atoms")


@lru_cache(maxsize=512)
def build_comparison(drug_id: str, other_drug_id: str) -> Comparison:
    drugs = _drugs()
    left, right = drugs.get(drug_id), drugs.get(other_drug_id)
    if left is None:
        raise KeyError(f"unknown drug_id {drug_id}")
    if right is None:
        raise KeyError(f"unknown drug_id {other_drug_id}")
    if not left["smiles"] or not right["smiles"]:
        missing = left["name"] if not left["smiles"] else right["name"]
        raise ValueError(f"no chemical structure recorded for {missing}; "
                         f"biologics have no small-molecule structure to compare")

    mol_left, mol_right = MolFromSmiles(left["smiles"]), MolFromSmiles(right["smiles"])
    if mol_left is None or mol_right is None:
        raise ValueError("could not parse one of the structures")

    tanimoto = DataStructs.TanimotoSimilarity(_plain.GetFingerprint(mol_left),
                                              _plain.GetFingerprint(mol_right))
    stereo = DataStructs.TanimotoSimilarity(_stereo.GetFingerprint(mol_left),
                                            _stereo.GetFingerprint(mol_right))

    mcs = rdFMCS.FindMCS([mol_left, mol_right], timeout=MCS_TIMEOUT,
                         ringMatchesRingOnly=True, completeRingsOnly=True)
    pattern = MolFromSmarts(mcs.smartsString) if mcs.smartsString else None
    hits_left = list(mol_left.GetSubstructMatch(pattern)) if pattern else []
    hits_right = list(mol_right.GetSubstructMatch(pattern)) if pattern else []

    stereo_only = tanimoto >= 0.999 and stereo < 0.999
    return Comparison(
        tanimoto=round(tanimoto, 3),
        tanimoto_stereo=round(stereo, 3),
        stereo_only_difference=stereo_only,
        shared_atoms=len(hits_left),
        shared_smarts=mcs.smartsString or "",
        left=MoleculeImage(drug_id=drug_id, name=left["name"] or drug_id,
                           smiles=left["smiles"], svg=_render(mol_left, hits_left),
                           n_atoms=mol_left.GetNumAtoms(), n_shared_atoms=len(hits_left)),
        right=MoleculeImage(drug_id=other_drug_id, name=right["name"] or other_drug_id,
                            smiles=right["smiles"], svg=_render(mol_right, hits_right),
                            n_atoms=mol_right.GetNumAtoms(), n_shared_atoms=len(hits_right)),
        caption=_caption(left["name"] or drug_id, right["name"] or other_drug_id,
                         tanimoto, stereo, len(hits_left), mol_left.GetNumAtoms(), stereo_only),
    )


router = APIRouter(prefix="/api/compare", tags=["compare"])


@router.get("", response_model=Comparison)
def compare_drugs(
    drug_id: str = Query(description="the candidate, e.g. CHEMBL701"),
    other_drug_id: str = Query(description="its look-alike, e.g. CHEMBL301742"),
) -> Comparison:
    try:
        return build_comparison(drug_id, other_drug_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'"))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
