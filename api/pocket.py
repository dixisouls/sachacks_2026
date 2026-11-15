"""Put a proposed molecule where the real drug sits, and see whether it fits.

Every other check in api/chemcheck.py judges a molecule on its own: its size,
its greasiness, whether a chemist could make it. None of them know which
protein it is aimed at, which is why most molecules pass them.

This one is about the target. When an experimental structure exists of the
starting drug inside its protein, that structure records where the drug
actually sits. A proposed molecule that shares the drug's core can be laid onto
that measured position, and the parts that stick out can be measured against
the protein around them. A molecule whose new substituent lands inside a helix
is not going to bind that way.

What this is not. It is not docking: nothing searches for a better pose, and
nothing lets the protein move. The shared core is pinned to where the real
drug's core was, and the rest follows. A clash means this particular pose does
not fit, not that the molecule cannot bind. Treat it as the strongest doubt
available here, not as a refutation.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, rdFMCS, rdMolAlign

log = logging.getLogger("repurposekg.pocket")
RDLogger.DisableLog("rdApp.*")

EMBED_SEED = 20240711
N_CONFORMERS = 40
# Two heavy atoms closer than this are overlapping rather than touching: a van
# der Waals contact between carbons sits near 3.4 A, and a hydrogen bond near
# 2.8 A. 2.2 A is well inside both, so it counts only real overlap.
CLASH_A = 2.2
MIN_CORE = 5


@dataclass
class Pocket:
    """The measured position of a drug inside its protein."""

    pdb_id: str
    ligand: Chem.Mol  # the drug, with its crystal coordinates
    protein: np.ndarray  # heavy-atom coordinates of everything around it
    resolution_A: float | None


def _atom_site(cif_text: str) -> tuple[dict[str, int], list[list[str]]]:
    """The _atom_site table out of an mmCIF file: column positions and rows."""
    lines = cif_text.splitlines()
    i = 0
    while i < len(lines):
        if lines[i].strip() != "loop_":
            i += 1
            continue
        j = i + 1
        names: list[str] = []
        while j < len(lines) and lines[j].lstrip().startswith("_"):
            names.append(lines[j].strip())
            j += 1
        if names and names[0].startswith("_atom_site."):
            columns = {n.split(".", 1)[1]: k for k, n in enumerate(names)}
            rows = []
            while j < len(lines) and not lines[j].startswith("#"):
                if lines[j].strip():
                    rows.append(lines[j].split())
                j += 1
            return columns, rows
        i = j
    raise ValueError("no _atom_site table in this mmCIF file")


def read_pocket(cif_text: str, comp_id: str, drug_smiles: str, pdb_id: str,
                resolution_A: float | None = None) -> Pocket:
    """Pull the bound drug and its surroundings out of a crystal structure."""
    columns, rows = _atom_site(cif_text)
    need = ("label_comp_id", "Cartn_x", "Cartn_y", "Cartn_z", "type_symbol", "label_atom_id")
    missing = [n for n in need if n not in columns]
    if missing:
        raise ValueError(f"mmCIF is missing {', '.join(missing)}")

    chain_col = columns.get("auth_asym_id", columns.get("label_asym_id"))
    ligand_rows = [r for r in rows if r[columns["label_comp_id"]] == comp_id]
    if not ligand_rows:
        raise ValueError(f"ligand {comp_id} is not in {pdb_id}")
    # An entry can hold one copy per chain. One is enough, and mixing them would
    # put atoms from different copies into the same molecule.
    if chain_col is not None:
        first = ligand_rows[0][chain_col]
        ligand_rows = [r for r in ligand_rows if r[chain_col] == first]

    block = []
    for n, row in enumerate(ligand_rows, 1):
        block.append(
            "HETATM%5d %-4s %3s A%4d    %8.3f%8.3f%8.3f  1.00  0.00          %2s"
            % (n, row[columns["label_atom_id"]][:4], comp_id[:3], 1,
               float(row[columns["Cartn_x"]]), float(row[columns["Cartn_y"]]),
               float(row[columns["Cartn_z"]]), row[columns["type_symbol"]])
        )
    raw = Chem.MolFromPDBBlock("\n".join(block) + "\nEND\n", proximityBonding=True, removeHs=False)
    if raw is None:
        raise ValueError(f"could not read ligand {comp_id} from {pdb_id}")

    template = Chem.MolFromSmiles(drug_smiles)
    if template is None:
        raise ValueError("the drug's own structure will not parse")
    try:
        # Coordinates carry no bond orders; the drug's own structure supplies them.
        ligand = AllChem.AssignBondOrdersFromTemplate(template, raw)
    except ValueError:
        ligand = raw  # a partially resolved ligand still gives a usable position

    group_col = columns.get("group_PDB")
    protein = np.array(
        [[float(r[columns["Cartn_x"]]), float(r[columns["Cartn_y"]]), float(r[columns["Cartn_z"]])]
         for r in rows
         if r[columns["type_symbol"]] != "H"
         and (group_col is None or r[group_col] == "ATOM")],
        dtype=float,
    )
    if protein.size == 0:
        raise ValueError(f"{pdb_id} has no protein atoms around the ligand")
    return Pocket(pdb_id=pdb_id, ligand=ligand, protein=protein, resolution_A=resolution_A)


def place(smiles: str, pocket: Pocket) -> dict[str, Any]:
    """Lay a molecule onto the drug's measured position and measure the overlap.

    Returns the placed structure as an SDF block, how well the shared core could
    be matched, and how many of its atoms end up inside the protein.
    """
    probe = Chem.MolFromSmiles(smiles)
    if probe is None:
        raise ValueError("this molecule will not parse")

    found = rdFMCS.FindMCS([probe, pocket.ligand], timeout=10,
                           ringMatchesRingOnly=True, completeRingsOnly=True)
    pattern = Chem.MolFromSmarts(found.smartsString) if found.smartsString else None
    if pattern is None or found.numAtoms < MIN_CORE:
        raise ValueError(f"shares only {found.numAtoms} atoms with the bound drug, too few to "
                         "place it with any confidence")

    mol = Chem.AddHs(probe)
    params = AllChem.ETKDGv3()
    params.randomSeed = EMBED_SEED
    params.pruneRmsThresh = 0.5
    if not AllChem.EmbedMultipleConfs(mol, numConfs=N_CONFORMERS, params=params):
        raise ValueError("could not generate 3D shapes for this molecule")
    AllChem.MMFFOptimizeMoleculeConfs(mol, maxIters=300)
    mol = Chem.RemoveHs(mol)

    atom_map = list(zip(mol.GetSubstructMatch(pattern), pocket.ligand.GetSubstructMatch(pattern)))
    if not atom_map:
        raise ValueError("the shared core did not line up in 3D")

    # Of the shapes this molecule can take, keep whichever puts the shared core
    # closest to where the real drug's core sits.
    scored = [(rdMolAlign.AlignMol(mol, pocket.ligand, prbCid=c, atomMap=atom_map), c)
              for c in range(mol.GetNumConformers())]
    rmsd, best = min(scored)

    positions = mol.GetConformer(best).GetPositions()
    nearest = np.linalg.norm(positions[:, None, :] - pocket.protein[None, :, :], axis=2).min(axis=1)
    clashing = int((nearest < CLASH_A).sum())

    placed = Chem.Mol(mol)
    placed.RemoveAllConformers()
    placed.AddConformer(mol.GetConformer(best), assignId=True)
    placed.SetProp("_Name", f"placed in {pocket.pdb_id}")

    return {
        "pdb_id": pocket.pdb_id,
        "resolution_A": pocket.resolution_A,
        "core_atoms": found.numAtoms,
        "rmsd": round(float(rmsd), 2),
        "atoms": mol.GetNumAtoms(),
        "clashes": clashing,
        "closest_A": round(float(nearest.min()), 2),
        "sdf": Chem.MolToMolBlock(placed),
    }


def as_check(result: dict[str, Any] | None, error: str | None = None) -> dict[str, Any]:
    """The placement, in the same shape as every other check in chemcheck."""
    if result is None:
        return {"id": "pocket", "label": "Fits where the drug sits", "status": "warn",
                "value": "not tested", "problem": "could not be placed in the pocket",
                "detail": error or "No experimental structure of the original drug inside its "
                                   "protein, so there is no measured position to place this one "
                                   "into. Nothing here tests the target."}
    clashes, atoms = result["clashes"], result["atoms"]
    share = clashes / max(atoms, 1)
    status = "pass" if clashes == 0 else "warn" if share <= 0.15 else "fail"
    detail = (
        f"Laid onto the position the original drug occupies in {result['pdb_id']}"
        + (f" ({result['resolution_A']} A)" if result.get("resolution_A") else "")
        + f", matching {result['core_atoms']} shared atoms to within {result['rmsd']} A. "
    )
    detail += (
        "No atom overlaps the protein, so this pose is at least possible."
        if clashes == 0 else
        f"{clashes} of {atoms} atoms sit inside the protein, the closest {result['closest_A']} A "
        "from it. The pocket can flex and the molecule can turn, so this is a doubt rather than "
        "a refutation, but it is the only check here that knows which protein you are aiming at."
    )
    return {"id": "pocket", "label": "Fits where the drug sits", "status": status,
            "value": "no overlap" if clashes == 0 else f"{clashes} of {atoms} atoms overlap",
            "problem": "does not fit the pocket the drug binds", "detail": detail}
