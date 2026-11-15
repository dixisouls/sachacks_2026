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
from rdkit.Chem import (AllChem, Mol, MolFromSmarts, MolFromSmiles, MolToMolBlock,
                        RemoveHs, rdFingerprintGenerator, rdFMCS, rdMolAlign)
from rdkit.Chem import AddHs
from rdkit.Chem.Draw import rdMolDraw2D

RDLogger.DisableLog("rdApp.*")
log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("ARTIFACT_DIR", ROOT / "artifacts"))

WIDTH, HEIGHT = 340, 260
MCS_TIMEOUT = 5
HIGHLIGHT = (0.13, 0.63, 0.52)  # teal, readable on light and dark backgrounds
N_CONFORMERS = 30   # candidates generated for the probe; the best-overlaying one is kept
EMBED_SEED = 42     # fixed, so the same pair always renders identically

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


# ── 3D overlay ───────────────────────────────────────────────────────────────

class Overlay3D(BaseModel):
    left: str = Field(description="MDL molblock, the reference conformer")
    right: str = Field(description="MDL molblock, aligned onto the reference's shared core")
    left_name: str
    right_name: str
    left_shared_atoms: list[int] = Field(description="0-based atom indices of the shared core")
    right_shared_atoms: list[int]
    core_rmsd_A: float = Field(description="how closely the shared cores superimpose")
    shared_atoms: int
    conformers_tried: int
    is_computed: bool = Field(
        True, description="always true: generated conformers, not experimental structures")
    caption: str


def _conformer(smiles: str) -> Mol:
    mol = AddHs(MolFromSmiles(smiles))
    params = AllChem.ETKDGv3()
    params.randomSeed = EMBED_SEED
    if AllChem.EmbedMolecule(mol, params) != 0:
        raise ValueError("could not generate a 3D conformer")
    AllChem.MMFFOptimizeMolecule(mol, maxIters=400)
    return RemoveHs(mol)


def _best_overlay(smiles: str, reference: Mol, pattern: Mol) -> tuple[Mol, float, int]:
    """Generate several conformers and keep the one whose shared core best matches.

    A single conformer lands wherever the embedding happens to put the flexible
    parts, which can look like a poor match when the molecules are in fact close:
    fostamatinib against R-406 goes from 1.75 A with one conformer to 0.10 A here.
    """
    mol = AddHs(MolFromSmiles(smiles))
    params = AllChem.ETKDGv3()
    params.randomSeed = EMBED_SEED
    params.pruneRmsThresh = 0.5
    if not AllChem.EmbedMultipleConfs(mol, numConfs=N_CONFORMERS, params=params):
        raise ValueError("could not generate 3D conformers")
    AllChem.MMFFOptimizeMoleculeConfs(mol, maxIters=300)
    mol = RemoveHs(mol)

    atom_map = list(zip(mol.GetSubstructMatch(pattern), reference.GetSubstructMatch(pattern)))
    if not atom_map:
        raise ValueError("shared scaffold did not match in 3D")
    tried = mol.GetNumConformers()
    rmsd, best_id = min((rdMolAlign.AlignMol(mol, reference, prbCid=c, atomMap=atom_map), c)
                        for c in range(tried))

    single = Mol(mol)
    single.RemoveAllConformers()
    single.AddConformer(mol.GetConformer(best_id), assignId=True)
    return single, rmsd, tried


@lru_cache(maxsize=256)
def build_overlay(drug_id: str, other_drug_id: str) -> Overlay3D:
    drugs = _drugs()
    left, right = drugs.get(drug_id), drugs.get(other_drug_id)
    if left is None:
        raise KeyError(f"unknown drug_id {drug_id}")
    if right is None:
        raise KeyError(f"unknown drug_id {other_drug_id}")
    if not left["smiles"] or not right["smiles"]:
        missing = left["name"] if not left["smiles"] else right["name"]
        raise ValueError(f"no chemical structure recorded for {missing}")

    flat_left, flat_right = MolFromSmiles(left["smiles"]), MolFromSmiles(right["smiles"])
    mcs = rdFMCS.FindMCS([flat_left, flat_right], timeout=MCS_TIMEOUT,
                         ringMatchesRingOnly=True, completeRingsOnly=True)
    pattern = MolFromSmarts(mcs.smartsString) if mcs.smartsString else None
    if pattern is None:
        raise ValueError("the two molecules share no common scaffold to align on")

    reference = _conformer(left["smiles"])
    probe, rmsd, tried = _best_overlay(right["smiles"], reference, pattern)
    shared_left = list(reference.GetSubstructMatch(pattern))
    shared_right = list(probe.GetSubstructMatch(pattern))

    return Overlay3D(
        left=MolToMolBlock(reference), right=MolToMolBlock(probe),
        left_name=left["name"] or drug_id, right_name=right["name"] or other_drug_id,
        left_shared_atoms=shared_left, right_shared_atoms=shared_right,
        core_rmsd_A=round(rmsd, 3), shared_atoms=len(shared_left), conformers_tried=tried,
        # Say what this is. Computed conformers are not experimental structures, and an
        # overlay of two drugs is not a binding pose -- that claim belongs only to a
        # co-crystal, which /api/structures reports separately.
        caption=(f"Computed 3D conformers aligned on the shared scaffold "
                 f"({len(shared_left)} atoms, core RMSD {rmsd:.2f} Å). "
                 f"Predicted shapes, not experimental structures, and not a binding pose."),
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


@router.get("/3d", response_model=Overlay3D)
def compare_drugs_3d(
    drug_id: str = Query(description="the candidate, e.g. CHEMBL2103830"),
    other_drug_id: str = Query(description="its look-alike, e.g. CHEMBL475251"),
) -> Overlay3D:
    """Both molecules as 3D molblocks, superimposed on their shared scaffold.

    Feed `left` and `right` straight to 3Dmol as `mol` format and colour the
    shared atom indices to make the common core read at a glance.
    """
    try:
        return build_overlay(drug_id, other_drug_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'"))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
