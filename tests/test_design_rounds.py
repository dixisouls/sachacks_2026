"""The design loop's verdict rules. Run: venv/bin/python -m pytest tests -q

Two rules here decide what the page is allowed to call a molecule, and both were
got wrong once in a way no reader could have spotted:

  * A molecule is judged against the pocket only when there is a pocket. The
    absence of a measured structure is a fact about the drug we could not find a
    structure for, not about anything the model designed, and recording it as a
    check against each molecule both asserted a placement nobody attempted and
    made `accepted` incomparable to RANDOM_PASS_RATE, which is measured without
    any pocket check at all.
  * Every check that does not pass carries `problem`, because
    chemcheck.feedback_line reads it to write the line the next round sees.
    A check without it killed a whole track.

Neither is visible in the contract and both are the normal case, so they are
pinned here. If a change makes one of these fail, that is the test asking
whether the change was meant, not noise.
"""

import asyncio
import time

import pytest

from api import chemcheck, design, pocket as pocket_mod


def _job():
    return {"events": [], "started": time.time()}


CONTEXT = {"text": "context", "parent_smiles": "NCC(CC(=O)O)c1ccc(Cl)cc1",
           "parent_name": "Baclofen", "disease_name": "test disease", "targets": []}


@pytest.fixture
def loop(monkeypatch):
    """One round, one molecule, a chemistry engine that always likes it."""
    monkeypatch.setattr(design, "ROUNDS", 1)
    monkeypatch.setattr(design, "PER_ROUND", 2)

    smiles = ["CCO"]

    async def fake_propose(job, prompt, track=None):
        return {"reasoning": "because", "molecules": [
            {"name": f"M{n}", "smiles": s, "rationale": "r", "builds_on": "Baclofen"}
            for n, s in enumerate(smiles, 1)]}

    def fake_evaluate(mol, parent=None, parent_name=None, known_drug=False):
        return {"smiles": mol, "valid": True, "status": "pass",
                "summary": "Passes every check.", "properties": {},
                "checks": [{"id": "qed", "label": "Overall drug-likeness", "status": "pass",
                            "value": "0.7 of 1.00", "detail": "d", "problem": "p"}]}

    monkeypatch.setattr(design, "_propose", fake_propose)
    monkeypatch.setattr(design.chemcheck, "evaluate", fake_evaluate)
    return smiles


def _run_once(pocket, note, loop_smiles=None):
    job, attempts = _job(), []
    asyncio.run(asyncio.wait_for(
        design.run_rounds(job, dict(CONTEXT), pocket, note, attempts=attempts), timeout=10))
    return job, attempts


# ── no pocket: not a mark against the molecule ───────────────────────────────

def test_with_no_pocket_the_molecule_is_not_judged_against_one(loop):
    job, attempts = _run_once(None, "no measured structure exists")
    check = attempts[0]["check"]

    assert [c["id"] for c in check["checks"]] == ["qed"], \
        "a molecule was judged against a pocket that does not exist"
    assert check["status"] == "pass"
    assert check["summary"] == "Passes every check."
    assert "pocket" not in check["properties"]
    assert "pose_sdf" not in check


def test_the_absence_of_a_structure_is_still_said_once_on_the_stream(loop):
    """It belongs to the run, not to each molecule, but it must not vanish."""
    pocket, note = None, "No experimental structure of this drug inside a target protein."
    shown, told = design.pocket_lines(pocket, note, "Baclofen")
    assert shown == note
    assert told == ""


# ── a pocket that exists, and a molecule that will not go into it ────────────

class FakePocket:
    pdb_id = "4MS3"
    resolution_A = 2.1


def test_a_molecule_that_cannot_be_placed_in_a_real_pocket_is_doubted(loop, monkeypatch):
    def refuse(smiles, pocket):
        raise ValueError("shares only 3 atoms with the bound drug, too few to place it")

    monkeypatch.setattr(design.pocket_mod, "place", refuse)
    job, attempts = _run_once(FakePocket(), None)
    check = attempts[0]["check"]

    fit = next(c for c in check["checks"] if c["id"] == "pocket")
    assert fit["status"] == "warn"
    assert check["status"] == "warn", "a molecule that would not go in still passed"
    assert "too few to place it" in fit["detail"]


def test_a_placed_molecule_carries_its_pose_and_numbers(loop, monkeypatch):
    placed = {"pdb_id": "4MS3", "resolution_A": 2.1, "core_atoms": 9, "rmsd": 0.4,
              "atoms": 14, "clashes": 0, "closest_A": 3.6, "sdf": "SDF-BLOCK"}
    monkeypatch.setattr(design.pocket_mod, "place", lambda smiles, pocket: placed)
    job, attempts = _run_once(FakePocket(), None)
    check = attempts[0]["check"]

    assert check["status"] == "pass"
    assert check["pose_sdf"] == "SDF-BLOCK"
    assert check["properties"]["pocket"] == {
        "pdb_id": "4MS3", "clashes": 0, "atoms": 14, "rmsd": 0.4,
        "core_atoms": 9, "closest_A": 3.6}
    assert "resolution_A" not in check["properties"]["pocket"]


def test_as_check_never_reports_a_missing_pocket_as_a_failed_placement():
    """Its None branch means "this molecule would not go in", not "there is none"."""
    none = pocket_mod.as_check(None, "the core did not line up")
    assert none["status"] == "warn"
    assert none["problem"], "a non-passing check with no problem breaks feedback_line"
    assert "not tested" not in none["value"]
    fit = pocket_mod.as_check({"pdb_id": "4MS3", "resolution_A": None, "core_atoms": 9,
                               "rmsd": 0.4, "atoms": 14, "clashes": 0, "closest_A": 3.6})
    assert fit["status"] == "pass" and "no overlap" in fit["value"]


# ── the repeat branch, which killed a track ──────────────────────────────────

def test_a_repeated_structure_is_rejected_without_killing_the_round(loop, monkeypatch):
    loop.append("CCO")  # the same molecule twice in one round
    job, attempts = _run_once(None, "no structure")

    assert len(attempts) == 2, "the repeat ended the round instead of being rejected"
    second = attempts[1]["check"]
    assert second["status"] == "fail"
    assert second["summary"] == "Already proposed in an earlier round."
    repeat = next(c for c in second["checks"] if c["id"] == "repeat")
    assert repeat["problem"], "feedback_line reads problem off every non-passing check"
    # The real thing that broke: writing the next round's feedback must not raise.
    line = chemcheck.feedback_line("M2", second)
    assert "FAIL" in line and "repeat" in line.lower()


def test_feedback_line_survives_every_check_the_loop_can_build(loop, monkeypatch):
    """Whatever shape a check takes in this file, the next round can be told about it."""
    monkeypatch.setattr(design.pocket_mod, "place",
                        lambda smiles, pocket: (_ for _ in ()).throw(ValueError("no core")))
    loop.append("CCO")
    job, attempts = _run_once(FakePocket(), None)
    for attempt in attempts:
        chemcheck.feedback_line(attempt["name"], attempt["check"])  # must not raise
