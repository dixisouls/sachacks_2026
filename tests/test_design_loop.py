"""The design loop: propose, judge, feed the failures back. Run: pytest tests -q

run_rounds is shared by the per-drug run and by all three tracks of a disease
run, so a crash in it is never one molecule's problem -- it escapes the round
and takes the whole track with it. These cover the two ways that happened.

The model and the chemistry engine are stubbed. What is under test is what the
loop does with their answers.
"""

import asyncio
import time

import pytest

from api import chemcheck, design, pocket as pocket_mod

CONTEXT = {"text": "a prompt", "parent_smiles": "CCO", "parent_name": "Ethanol",
           "disease_name": "test disease", "targets": [], "n_approved": 1,
           "n_investigational": 0}


def _job():
    return {"events": [], "started": time.time()}


def _run(coro, timeout: float = 30):
    async def guarded():
        return await asyncio.wait_for(coro, timeout)

    return asyncio.run(guarded())


@pytest.fixture
def loop(monkeypatch):
    """One round of four, and a chemistry engine that passes everything."""
    monkeypatch.setattr(design, "ROUNDS", 1)

    def fake_evaluate(smiles, parent=None, parent_name=None, *args):
        return {"smiles": smiles, "valid": True, "status": "pass",
                "summary": "Passes every check.", "checks": [
                    {"id": "druglike", "label": "Drug-like", "status": "pass",
                     "value": "ok", "problem": "not drug-like", "detail": "fine"}],
                "properties": {"qed": 0.7, "sa_score": 2.0}}

    monkeypatch.setattr(chemcheck, "evaluate", fake_evaluate)

    def propose(*molecules):
        async def fake(job, prompt, track=None):
            return {"reasoning": "because", "molecules": list(molecules)}

        monkeypatch.setattr(design, "_propose", fake)

    return propose


def _mol(name, smiles):
    return {"name": name, "smiles": smiles, "rationale": "r", "builds_on": "b"}


# ── a repeated structure ─────────────────────────────────────────────────────

def test_a_repeated_structure_is_recorded_not_fatal(loop):
    """The model repeating itself used to kill the whole track.

    chemcheck.feedback_line reads `problem` off every check that did not pass,
    to write the line the next round reads. The repeat check did not carry one,
    so the KeyError escaped the round and the track reported "'problem'" as its
    error -- on the one case this branch exists to handle gracefully.
    """
    loop(_mol("A", "CCO"), _mol("B", "CCO"))  # the same structure twice
    job, attempts = _job(), []
    _run(design.run_rounds(job, CONTEXT, None, None, attempts=attempts))

    assert len(attempts) == 2, "the repeat was dropped instead of recorded"
    first, second = attempts
    assert first["check"]["status"] == "pass"
    assert second["check"]["status"] == "fail"
    assert second["check"]["summary"] == "Already proposed in an earlier round."
    # Every check the page renders carries every field of `Check`.
    for check in second["check"]["checks"]:
        assert {"id", "label", "status", "value", "detail", "problem"} <= set(check)
    # And the line the next round reads was written, which is where it crashed.
    assert "repeats a structure already tried" in chemcheck.feedback_line("B", second["check"])
    assert not any(e["type"] == "error" for e in job["events"])


# ── the pocket, present and absent ───────────────────────────────────────────

class FakePocket:
    pdb_id = "4MS3"
    resolution_A = 2.1


def test_no_pocket_means_no_pocket_check_and_a_molecule_can_still_pass(loop):
    """A drug with no co-crystal must not warn every molecule it designs.

    The absence of a measured position is not a fact about any one molecule.
    Recording it as a per-molecule check said "could not be placed" about a
    placement never attempted, and because the worst check decides, it made
    every molecule `warn`: a real run on multiple sclerosis accepted 0 of 36
    attempts while the same page said 81.5% of random molecules pass. The
    absence is said once per track in the `pocket` event and again in the case
    against.
    """
    loop(_mol("A", "CCN"))
    job, attempts = _job(), []
    note = "No experimental structure of this drug inside a target protein."
    _run(design.run_rounds(job, CONTEXT, None, note, attempts=attempts))

    check = attempts[0]["check"]
    assert [c["id"] for c in check["checks"]] == ["druglike"]
    assert check["status"] == "pass", "an untested pocket must not hold a molecule back"
    assert check["summary"] == "Passes every check."
    assert "pocket" not in check["properties"]
    assert "could not be placed" not in str(job["events"])


def test_a_pocket_that_rejects_a_molecule_fails_it(loop, monkeypatch):
    loop(_mol("A", "CCN"))

    def place(smiles, pocket):
        return {"pdb_id": "4MS3", "resolution_A": 2.1, "core_atoms": 6, "rmsd": 0.4,
                "atoms": 20, "clashes": 9, "closest_A": 1.1, "sdf": "SDF"}

    monkeypatch.setattr(pocket_mod, "place", place)
    job, attempts = _job(), []
    _run(design.run_rounds(job, CONTEXT, FakePocket(), None, attempts=attempts))

    check = attempts[0]["check"]
    assert check["status"] == "fail"
    assert check["properties"]["pocket"]["clashes"] == 9
    assert check["pose_sdf"] == "SDF"


def test_a_molecule_that_cannot_be_placed_in_a_real_pocket_is_doubted(loop, monkeypatch):
    """That is a fact about the molecule: it kept too little of the core."""
    loop(_mol("A", "CCN"))

    def place(smiles, pocket):
        raise ValueError("shares only 2 atoms with the bound drug")

    monkeypatch.setattr(pocket_mod, "place", place)
    job, attempts = _job(), []
    _run(design.run_rounds(job, CONTEXT, FakePocket(), None, attempts=attempts))

    check = attempts[0]["check"]
    fit = next(c for c in check["checks"] if c["id"] == "pocket")
    assert check["status"] == "warn"
    assert fit["status"] == "warn"
    assert "shares only 2 atoms" in fit["detail"]
    assert "pocket" not in check["properties"]


# ── a round that returns nothing ─────────────────────────────────────────────

def test_a_round_that_fails_does_not_end_the_run(monkeypatch):
    monkeypatch.setattr(design, "ROUNDS", 2)
    calls = []

    async def fake(job, prompt, track=None):
        calls.append(prompt)
        if len(calls) == 1:
            raise RuntimeError("the model fell over")
        return {"reasoning": "r", "molecules": [_mol("B", "CCO")]}

    monkeypatch.setattr(design, "_propose", fake)
    monkeypatch.setattr(chemcheck, "evaluate", lambda s, *a: {
        "smiles": s, "valid": True, "status": "pass", "summary": "Passes every check.",
        "checks": [], "properties": {}})

    job, attempts = _job(), []
    _run(design.run_rounds(job, CONTEXT, None, None, attempts=attempts))

    assert len(attempts) == 1, "the second round did not run"
    assert any(e["type"] == "note" and "did not return usable molecules" in e["text"]
               for e in job["events"])
    # The failure was handed to the next round rather than hidden from it.
    assert "round 1 produced nothing usable" in calls[1]
