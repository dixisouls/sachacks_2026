"""Judge a proposed molecule with RDKit. No network, no language model.

A language model can propose a molecule, but it cannot tell you whether the
molecule is real chemistry, whether anyone could make it, or whether it is
simply an existing drug rewritten. This module answers those questions with a
chemistry engine, so every claim the design feature makes is computed here
rather than asserted by the model.

Every check returns the number it judged on, so the UI can show the evidence
next to the verdict instead of a bare pass or fail.
"""

from __future__ import annotations

import logging
import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import polars as pl
from rdkit import DataStructs, RDConfig, RDLogger
from rdkit.Chem import (Crippen, Descriptors, FilterCatalog, Mol, MolFromSmiles,
                        MolToInchiKey, MolToSmiles, QED, rdFingerprintGenerator,
                        rdMolDescriptors)

log = logging.getLogger("repurposekg.chemcheck")
RDLogger.DisableLog("rdApp.*")  # a bad SMILES is an expected answer here, not a crash

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("ARTIFACT_DIR", ROOT / "artifacts"))

# Morgan radius 2, 2048 bits: the same fingerprint scripts/build_similarity.py
# used to build chem_pairs.parquet, so similarity numbers here mean the same
# thing as the "look-alike" numbers elsewhere in the product.
_FPGEN = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)

Status = Literal["pass", "warn", "fail"]


def _catalog(which: str) -> FilterCatalog.FilterCatalog:
    params = FilterCatalog.FilterCatalogParams()
    params.AddCatalog(getattr(FilterCatalog.FilterCatalogParams.FilterCatalogs, which))
    return FilterCatalog.FilterCatalog(params)


# The two filters are kept apart because they carry very different weight.
# PAINS flags groups that fake results in screening assays, which is close to
# disqualifying. Brenk flags groups undesirable in a fragment screen, and is
# conservative enough that marketed drugs trip it: cannabidiol hits it twice.
# Treating both as fatal would reject the very drugs this product ranks.
@lru_cache(maxsize=1)
def _pains() -> FilterCatalog.FilterCatalog:
    return _catalog("PAINS")


@lru_cache(maxsize=1)
def _brenk() -> FilterCatalog.FilterCatalog:
    return _catalog("BRENK")


@lru_cache(maxsize=1)
def _sa_scorer():
    """Ertl's synthetic accessibility score, shipped in RDKit's contrib folder."""
    path = os.path.join(RDConfig.RDContribDir, "SA_Score")
    if path not in sys.path:
        sys.path.append(path)
    try:
        import sascorer  # type: ignore[import-not-found]

        return sascorer.calculateScore
    except ImportError:  # pragma: no cover - depends on the RDKit build
        log.warning("SA_Score not available in this RDKit build; skipping that check")
        return None


@lru_cache(maxsize=1)
def _known_drugs() -> tuple[list[str], list[str], list[str], list[Any]]:
    """Every drug we know, as (ids, names, inchi_keys, fingerprints).

    Loaded once. 13,911 fingerprints take a moment to build, which is why this
    is cached and why the design job warms it before the first model call.
    """
    frame = pl.read_parquet(ARTIFACTS / "drugs.parquet",
                            columns=["drug_id", "name", "smiles", "inchi_key"])
    ids, names, keys, fps = [], [], [], []
    for row in frame.iter_rows(named=True):
        smiles = row["smiles"]
        if not smiles:
            continue
        mol = MolFromSmiles(smiles)
        if mol is None:
            continue
        ids.append(row["drug_id"])
        names.append(row["name"] or row["drug_id"])
        keys.append((row["inchi_key"] or "").split("-")[0])  # skeleton, ignores salt form
        fps.append(_FPGEN.GetFingerprint(mol))
    log.info("chemcheck: %d known drug fingerprints ready", len(fps))
    return ids, names, keys, fps


def warm() -> None:
    """Build the caches now, so the first design run does not pay for them."""
    _known_drugs()
    _pains()
    _brenk()
    _sa_scorer()


def similarity(left: str, right: str) -> float | None:
    """Tanimoto between two SMILES, or None if either will not parse."""
    a, b = MolFromSmiles(left), MolFromSmiles(right)
    if a is None or b is None:
        return None
    return DataStructs.TanimotoSimilarity(_FPGEN.GetFingerprint(a), _FPGEN.GetFingerprint(b))


def _nearest_known(mol: Mol) -> tuple[str, str, float] | None:
    ids, names, _, fps = _known_drugs()
    if not fps:
        return None
    scores = DataStructs.BulkTanimotoSimilarity(_FPGEN.GetFingerprint(mol), fps)
    best = max(range(len(scores)), key=scores.__getitem__)
    return ids[best], names[best], scores[best]


def _check(cid: str, label: str, status: Status, value: str, detail: str,
           problem: str | None = None) -> dict[str, Any]:
    """`label` names the good outcome, `problem` names what went wrong.

    The two are not opposites of each other, so a failing check needs its own
    wording: a molecule that fails "No known-problem groups" has problem groups,
    and saying "rejected: no known-problem groups" states the reverse.
    """
    return {"id": cid, "label": label, "status": status, "value": value,
            "detail": detail, "problem": problem or label.lower()}


def evaluate(smiles: str, parent_smiles: str | None = None,
             parent_name: str | None = None) -> dict[str, Any]:
    """Run every check on one proposed molecule.

    Returns the canonical structure, the descriptors, and a list of checks each
    carrying the number it judged on. `status` is the worst check: a molecule
    that fails anything is a fail, one that only warns is a warn.
    """
    mol = MolFromSmiles(smiles)
    if mol is None:
        return {
            "smiles": smiles,
            "valid": False,
            "status": "fail",
            "summary": "Not a valid molecule. The structure could not be read as chemistry.",
            "checks": [_check("valid", "Real chemistry", "fail", "unreadable",
                              "RDKit could not parse this structure, so it is not a molecule.",
                              problem="not readable as chemistry")],
            "properties": {},
        }

    canonical = MolToSmiles(mol)
    checks: list[dict[str, Any]] = [
        _check("valid", "Real chemistry", "pass", "parsed",
               "RDKit read the structure and the valences are chemically possible.")
    ]

    mw = Descriptors.MolWt(mol)
    logp = Crippen.MolLogP(mol)
    tpsa = rdMolDescriptors.CalcTPSA(mol)
    hbd = rdMolDescriptors.CalcNumHBD(mol)
    hba = rdMolDescriptors.CalcNumHBA(mol)
    rotatable = rdMolDescriptors.CalcNumRotatableBonds(mol)
    qed = QED.qed(mol)

    properties = {
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "mol_weight": round(mw, 1),
        "logp": round(logp, 2),
        "tpsa": round(tpsa, 1),
        "hbd": hbd,
        "hba": hba,
        "rotatable_bonds": rotatable,
        "heavy_atoms": mol.GetNumHeavyAtoms(),
        "rings": rdMolDescriptors.CalcNumRings(mol),
        "qed": round(qed, 3),
    }

    # Lipinski's rule of five: the classic oral-drug filter. One violation is
    # common among real drugs, two or more is the warning sign.
    violations = [name for name, bad in (
        (f"weight {mw:.0f} > 500", mw > 500),
        (f"logP {logp:.1f} > 5", logp > 5),
        (f"{hbd} H-bond donors > 5", hbd > 5),
        (f"{hba} H-bond acceptors > 10", hba > 10),
    ) if bad]
    checks.append(_check(
        "lipinski", "Drug-like size and greasiness",
        "pass" if not violations else "warn" if len(violations) == 1 else "fail",
        f"{len(violations)} of 4 broken",
        "Passes Lipinski's rule of five, the usual test for a pill that can be absorbed."
        if not violations else "Breaks " + ", ".join(violations) + ".",
        problem="wrong size or too greasy for a pill",
    ))

    # Veber: oral bioavailability needs a molecule that is not too floppy or too polar.
    veber = rotatable <= 10 and tpsa <= 140
    checks.append(_check(
        "veber", "Can survive being swallowed", "pass" if veber else "warn",
        f"{rotatable} rotatable bonds, TPSA {tpsa:.0f}",
        "Rigid enough and not too polar, so an oral dose has a chance of reaching the blood."
        if veber else "Too floppy or too polar for reliable oral absorption (Veber's rules).",
        problem="unlikely to be absorbed when swallowed",
    ))

    checks.append(_check(
        "qed", "Overall drug-likeness", "pass" if qed >= 0.5 else "warn" if qed >= 0.3 else "fail",
        f"{qed:.2f} of 1.00",
        "QED scores how much a molecule resembles known oral drugs. Above 0.5 is good, "
        "below 0.3 is unusual for a drug.",
        problem="does not look much like a drug",
    ))

    sa = _sa_scorer()
    if sa is not None:
        score = sa(mol)
        properties["sa_score"] = round(score, 2)
        checks.append(_check(
            "synthesis", "A chemist could make it",
            "pass" if score <= 4 else "warn" if score <= 6 else "fail",
            f"{score:.1f} of 10",
            "Synthetic accessibility, 1 is trivial and 10 is a research project in itself. "
            "Under 4 means routine medicinal chemistry.",
            problem="too hard to actually make",
        ))

    pains = sorted({entry.GetDescription() for entry in _pains().GetMatches(mol)})
    checks.append(_check(
        "pains", "Will not fake a screening result", "pass" if not pains else "fail",
        "clean" if not pains else f"{len(pains)} found",
        "No PAINS alerts: nothing here is a group notorious for producing false hits in assays."
        if not pains else "Contains " + ", ".join(pains[:3]) + ". Groups like this interfere with "
        "assays and produce hits that evaporate on a closer look.",
        problem="contains a group that fakes screening results",
    ))

    brenk = sorted({entry.GetDescription() for entry in _brenk().GetMatches(mol)})
    checks.append(_check(
        "brenk", "No awkward chemistry", "pass" if not brenk else "warn",
        "clean" if not brenk else f"{len(brenk)} found",
        "Nothing a medicinal chemist would object to on sight." if not brenk else
        "Contains " + ", ".join(brenk[:3]) + ". Worth a second look, though plenty of approved "
        "drugs carry groups like these.",
        problem="has chemistry a medicinal chemist would question",
    ))

    # Novelty. Matching an existing drug is not a failure of chemistry, but it is
    # a failure of the brief, and it is the single most likely way a language
    # model goes wrong here, so it is reported loudly either way.
    skeleton = (MolToInchiKey(mol) or "").split("-")[0]
    _, _, keys, _ = _known_drugs()
    nearest = _nearest_known(mol)
    exact = skeleton and skeleton in keys
    if exact and nearest:
        checks.append(_check(
            "novel", "A new molecule", "fail", f"same as {nearest[1].title()}",
            f"This is {nearest[1].title()}, a drug already in the database. The model recited an "
            "existing molecule rather than designing one.",
            problem=f"is {nearest[1].title()}, a drug that already exists",
        ))
    elif nearest:
        drug_id, name, score = nearest
        checks.append(_check(
            "novel", "A new molecule",
            "pass" if score < 0.85 else "warn", f"{score:.0%} like {name.title()}",
            f"The closest known drug is {name.title()} ({drug_id}) at {score:.0%} similarity. "
            + ("Close enough that it is a small tweak rather than a new idea."
               if score >= 0.85 else "Different enough to count as a new structure."),
            problem=f"barely differs from {name.title()}",
        ))
        properties["nearest_drug"] = {"drug_id": drug_id, "name": name, "similarity": round(score, 3)}

    # Resemblance to the drug it was designed from. Too far and there is no reason
    # to think it still hits the same protein; identical and nothing was designed.
    if parent_smiles:
        score = similarity(canonical, parent_smiles)
        if score is not None:
            properties["parent_similarity"] = round(score, 3)
            label = f"Still resembles {parent_name.title()}" if parent_name else "Still resembles the original"
            shown = parent_name.title() if parent_name else "the original"
            checks.append(_check(
                "parent", label,
                "pass" if 0.3 <= score < 0.98 else "fail" if score >= 0.98 else "warn",
                f"{score:.0%} similar",
                "Shares enough structure to plausibly act on the same protein, while being a "
                "different molecule." if 0.3 <= score < 0.98 else
                "Essentially the same molecule, so nothing was designed." if score >= 0.98 else
                "Shares little structure with the original, so there is no strong reason to "
                "expect it still acts on the same protein. A chemist would need to check.",
                problem=(f"is essentially {shown} again" if score >= 0.98
                         else f"may be too unlike {shown} to hit the same protein"),
            ))

    worst: Status = ("fail" if any(c["status"] == "fail" for c in checks)
                     else "warn" if any(c["status"] == "warn" for c in checks) else "pass")
    failed = [c["problem"] for c in checks if c["status"] == "fail"]
    warned = [c["problem"] for c in checks if c["status"] == "warn"]
    summary = ("Passes every check." if worst == "pass"
               else "Rejected: " + "; ".join(failed) + "." if failed
               else "Usable, but " + "; ".join(warned) + ".")

    return {
        "smiles": canonical,
        "valid": True,
        "status": worst,
        "summary": summary,
        "checks": checks,
        "properties": properties,
    }


def feedback_line(name: str, result: dict[str, Any]) -> str:
    """One line per attempt, written for the model to read on the next round."""
    if not result["valid"]:
        return f"- {name}: INVALID. {result['smiles']} is not parseable chemistry. Do not repeat it."
    bits = [f"{c['status'].upper()}: {c['problem']} ({c['value']})"
            for c in result["checks"] if c["status"] != "pass"]
    verdict = "ACCEPTED" if result["status"] == "pass" else result["status"].upper()
    detail = "; ".join(bits) if bits else "all checks passed"
    return f"- {name} [{result['smiles']}]: {verdict}. {detail}."
