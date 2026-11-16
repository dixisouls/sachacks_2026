"""The computed half of the workup. Run: venv/bin/python -m pytest tests -q

These are locked down because the whole claim of api/workup.py is that the
numbers and the verdicts come from code rather than from the model. If a
threshold drifts, the model's prose stays just as fluent and the section is
quietly wrong, which is the failure this product is meant not to have.
"""

from rdkit.Chem import MolFromSmiles

from api import chemcheck
from api.workup import _difficulty, _ramp, admet_items, case_floor, cns_mpo, homologs

# Caffeine: small, polar, no basic amine. Imatinib: heavy, greasy, basic.
CAFFEINE = "Cn1cnc2c1c(=O)n(C)c(=O)n2C"
IMATINIB = ("Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1")


def test_ramp_is_one_below_good_and_zero_above_bad():
    assert _ramp(1.0, 3.0, 5.0) == 1.0
    assert _ramp(3.0, 3.0, 5.0) == 1.0
    assert _ramp(5.0, 3.0, 5.0) == 0.0
    assert _ramp(9.0, 3.0, 5.0) == 0.0
    assert _ramp(4.0, 3.0, 5.0) == 0.5  # halfway


def test_ramp_runs_the_other_way_too():
    # The rising edge of the TPSA hump: 20 is bad, 40 is good.
    assert _ramp(20.0, 40.0, 20.0) == 0.0
    assert _ramp(30.0, 40.0, 20.0) == 0.5
    assert _ramp(60.0, 40.0, 20.0) == 1.0


def test_cns_mpo_stays_in_range_and_names_its_substitutions():
    for smiles in (CAFFEINE, IMATINIB):
        mpo = cns_mpo(MolFromSmiles(smiles))
        assert 0 <= mpo["score"] <= 6
        assert len(mpo["terms"]) == 6
        # The two substituted terms must say so in their own names, so a reader
        # of the raw terms cannot mistake them for the real thing.
        assert any("approximated" in k for k in mpo["terms"])
        assert any("in place of pKa" in k for k in mpo["terms"])
        assert "approximated by cLogP" in mpo["caveat"]


def test_cns_mpo_prefers_the_small_uncharged_molecule():
    small = cns_mpo(MolFromSmiles(CAFFEINE))["score"]
    big = cns_mpo(MolFromSmiles(IMATINIB))["score"]
    assert small > big


def test_basic_amine_costs_the_pka_term():
    # A basic amine is largely charged in blood, which the surrogate must notice.
    amine = cns_mpo(MolFromSmiles("CCCCN"))
    ether = cns_mpo(MolFromSmiles("CCCCOC"))
    assert amine["terms"]["basic centre (in place of pKa)"] < 1.0
    assert ether["terms"]["basic centre (in place of pKa)"] == 1.0
    assert "basic amine" in amine["basis"]
    # An amide nitrogen is not a base and must not be counted as one.
    amide = cns_mpo(MolFromSmiles("CCC(=O)NC"))
    assert amide["terms"]["basic centre (in place of pKa)"] == 1.0


def test_guanidine_is_scored_worse_than_a_plain_amine():
    guanidine = cns_mpo(MolFromSmiles("NC(=N)NCCCC"))
    amine = cns_mpo(MolFromSmiles("CCCCN"))
    assert (guanidine["terms"]["basic centre (in place of pKa)"]
            < amine["terms"]["basic centre (in place of pKa)"])


def test_admet_items_are_computed_with_a_status_each():
    items = admet_items(CAFFEINE)
    assert [i["label"] for i in items] == [
        "Size", "Greasiness", "Polar surface", "Hydrogen-bond donors",
        "Flexibility", "Reaches the brain"]
    for item in items:
        assert item["status"] in {"pass", "warn", "fail"}
        assert item["value"] and item["fact"]


def test_admet_status_follows_the_number_not_the_molecule():
    # A long greasy chain breaks the logP threshold; caffeine does not.
    greasy = {i["label"]: i for i in admet_items("CCCCCCCCCCCCCCCCCCCCCC")}
    assert greasy["Greasiness"]["status"] == "fail"
    assert greasy["Flexibility"]["status"] == "fail"
    mild = {i["label"]: i for i in admet_items(CAFFEINE)}
    assert mild["Greasiness"]["status"] == "pass"
    assert mild["Size"]["status"] == "pass"


def test_an_approved_drug_is_not_failed_for_being_polar():
    # Caffeine and metformin both compute to cLogP -1.0. A band that calls that a
    # failure is measuring the wrong end of the scale.
    for smiles in (CAFFEINE, "CN(C)C(=N)NC(N)=N"):
        items = {i["label"]: i for i in admet_items(smiles)}
        assert items["Greasiness"]["status"] == "pass"


def test_brain_line_says_both_the_word_and_the_number():
    brain = next(i for i in admet_items(CAFFEINE) if i["label"] == "Reaches the brain")
    assert "of 6" in brain["value"]
    assert brain["value"].split(",")[0] in {"likely", "uncertain", "unlikely"}
    assert "only if the target is inside the brain" in brain["fact"]


def test_difficulty_phrases_come_from_the_sa_score():
    assert "routine" in _difficulty(3.4)[0]
    assert _difficulty(3.4)[0].startswith("3.4 of 10")
    assert _difficulty(5.0)[1] == "awkward"
    assert _difficulty(8.0)[1] == "hard"
    assert _difficulty(None) == ("not computed", "unknown")


def test_homologs_come_from_the_sequence_data():
    # RYR2's closest relatives in artifacts/homolog_pairs.parquet are the other
    # two ryanodine receptors, at identities recorded in that file.
    found = homologs(["ENSG00000198626"])
    symbols = [h["symbol"] for h in found]
    assert "RYR3" in symbols and "RYR1" in symbols
    top = found[0]
    assert 0 < top["identity"] <= 1
    assert found == sorted(found, key=lambda h: -h["identity"])
    assert top["of_target"] == "RYR2"


def test_a_target_is_never_its_own_off_target():
    found = homologs(["ENSG00000198626", "ENSG00000198838"])  # RYR2 and RYR3
    assert {"RYR2", "RYR3"}.isdisjoint({h["symbol"] for h in found})
    assert "RYR1" in {h["symbol"] for h in found}


def test_homologs_of_nothing_is_empty_not_an_error():
    assert homologs([]) == []
    assert homologs([None]) == []
    assert homologs(["ENSG_NOT_A_GENE"]) == []


def test_case_floor_always_says_the_three_things():
    track = {"seed": {"name": "Baclofen"},
             "best": {"check": {"properties": {"pocket": {"pdb_id": "4MS3"}}}}}
    floor = case_floor(track)
    assert len(floor) == 3
    joined = " ".join(floor)
    assert "never been made" in joined
    assert "placement, not a docking" in joined
    assert "4MS3" in joined and "Baclofen" in joined
    # The low-bar line must quote the measured rate, not a remembered one.
    assert f"{chemcheck.RANDOM_PASS_RATE:.0%}" in joined
    assert f"{round(chemcheck.RANDOM_PASS_RATE * 200)} of 200" in joined


def test_case_floor_says_so_when_nothing_tested_the_target():
    track = {"seed": {"name": "Riluzole"}, "best": {"check": {"properties": {}}}}
    floor = case_floor(track)
    assert "tested the target at all" in floor[2]
    assert "placement" not in floor[2]


# ── the whole workup, with the model stubbed ─────────────────────────────────

import asyncio
import time

import pytest

from api import workup as workup_mod

CONTEXT = {"parent_name": "Baclofen", "parent_smiles": "NCC(CC(=O)O)c1ccc(Cl)cc1",
           "disease_name": "test disease",
           "targets": [{"symbol": "RYR2", "uniprot": "Q92736", "gene_id": "ENSG00000198626"}]}


def _track():
    return {
        "seed": {"name": "Baclofen", "smiles": CONTEXT["parent_smiles"],
                 "check": {"summary": "Already a known drug."}},
        "best": {"id": "approved-1-0", "name": "RK-3", "check": {
            "smiles": CAFFEINE, "valid": True, "status": "pass",
            "summary": "Passes every check.",
            "checks": [{"id": "qed", "label": "Overall drug-likeness", "status": "pass",
                        "value": "0.71 of 1.00", "detail": "looks like a drug"}],
            "properties": {"sa_score": 3.4, "pocket": {"pdb_id": "4MS3", "clashes": 0}}}},
        "attempts": [{"check": {"status": "pass"}}, {"check": {"status": "fail"}}],
    }


def _job():
    return {"events": [], "started": time.time()}


@pytest.fixture
def model(monkeypatch):
    """A model that answers every section, and tries to overstep in each."""
    async def fake_ask(prompt, schema):
        props = schema["properties"]
        if "steps" in props:
            return {"steps": [{"what": "Alkylate the amine", "why": "cheapest first"},
                              {"what": "Couple the aryl ring", "why": "Suzuki, well precedented"}],
                    "note": "The second step is the risky one."}
        if "items" in props and "concern" in props["items"]["items"]["properties"]:
            return {"items": [{"symbol": "RYR3", "concern": "Also in brain; would blunt signalling."}],
                    "note": "Sequence similarity only."}
        if "items" in props:
            # Note the wrong label case, one missing label, and an attempt to
            # restate a number the engine already decided.
            return {"items": [{"label": "size", "detail": "Light enough to swallow."},
                              {"label": "Reaches the brain", "detail": "Should get in."}],
                    "note": "Computed, not measured."}
        return {"verdict": "Worth one assay, no more.", "for": ["cheap to make"],
                "against": ["nothing tests binding"], "next_step": "A RYR2 binding assay."}

    monkeypatch.setattr(workup_mod, "_ask", fake_ask)


def test_run_workup_produces_all_four_sections(model):
    job, track = _job(), _track()
    out = asyncio.run(workup_mod.run_workup(job, "approved", track, CONTEXT))

    assert set(out) == {"synthesis", "admet", "offtarget", "case"}
    assert all(out[k] is not None for k in out)

    # Every section emitted a running step, a done step and one workup event.
    kinds = [e["kind"] for e in job["events"] if e["type"] == "workup"]
    assert kinds == ["synthesis", "admet", "offtarget", "case"]
    steps = [(e["step"], e["status"]) for e in job["events"] if e["type"] == "workup_step"]
    assert steps == [("synthesis", "running"), ("synthesis", "done"),
                     ("admet", "running"), ("admet", "done"),
                     ("offtarget", "running"), ("offtarget", "done"),
                     ("case", "running"), ("case", "done")]
    assert all(e["track"] == "approved" for e in job["events"])


def test_the_difficulty_is_the_computed_score_and_steps_are_numbered(model):
    out = asyncio.run(workup_mod.run_workup(_job(), "approved", _track(), CONTEXT))
    synth = out["synthesis"]
    assert synth["difficulty"].startswith("3.4 of 10")
    assert [s["n"] for s in synth["steps"]] == [1, 2]
    assert "No step here has been attempted" in synth["note"]


def test_the_model_cannot_move_a_computed_value_or_status(model):
    out = asyncio.run(workup_mod.run_workup(_job(), "approved", _track(), CONTEXT))
    items = {i["label"]: i for i in out["admet"]["items"]}
    computed = {i["label"]: i for i in admet_items(CAFFEINE)}
    assert len(items) == 6
    for label, item in items.items():
        assert item["value"] == computed[label]["value"]
        assert item["status"] == computed[label]["status"]
    # The model's prose is used where it gave some, matched case-insensitively.
    assert items["Size"]["detail"] == "Light enough to swallow."
    # A label it skipped falls back to the computed fact rather than going blank.
    assert items["Polar surface"]["detail"].startswith("Topological polar surface area")
    assert "Nothing has been dosed" in out["admet"]["note"]


def test_offtarget_identities_come_from_the_data_not_the_model(model):
    out = asyncio.run(workup_mod.run_workup(_job(), "approved", _track(), CONTEXT))
    items = out["offtarget"]["items"]
    symbols = [i["symbol"] for i in items]
    assert "RYR3" in symbols and "RYR1" in symbols
    from_data = {h["symbol"]: h["identity"] for h in homologs(["ENSG00000198626"])}
    for item in items:
        assert item["identity"] == from_data[item["symbol"]]
    # The model only wrote about one of them; the rest say so rather than invent.
    ryr3 = next(i for i in items if i["symbol"] == "RYR3")
    ryr1 = next(i for i in items if i["symbol"] == "RYR1")
    assert ryr3["concern"] == "Also in brain; would blunt signalling."
    assert "was not established here" in ryr1["concern"]
    assert "not evidence that this molecule binds it" in out["offtarget"]["note"]


def test_the_case_against_keeps_the_floor_whatever_the_model_writes(model):
    track = _track()
    out = asyncio.run(workup_mod.run_workup(_job(), "approved", track, CONTEXT))
    case = out["case"]
    assert case["verdict"] == "Worth one assay, no more."
    assert case["next_step"] == "A RYR2 binding assay."
    # The three floor items come first and in order, and the model's one point is
    # kept after them -- deduplicated, since it repeated one of ours in substance.
    assert case["against"][:3] == case_floor(track)
    assert len(case["against"]) == 4
    assert "placement, not a docking" in " ".join(case["against"])


def test_a_section_that_fails_is_null_and_does_not_stop_the_rest(monkeypatch):
    calls = []

    async def fussy_ask(prompt, schema):
        calls.append(schema)
        if "steps" in schema["properties"]:
            raise RuntimeError("the model fell over")
        if "verdict" in schema["properties"]:
            return {"verdict": "v", "for": [], "against": [], "next_step": "n"}
        return {"items": [], "note": "n"}

    monkeypatch.setattr(workup_mod, "_ask", fussy_ask)
    job = _job()
    out = asyncio.run(workup_mod.run_workup(job, "all", _track(), CONTEXT))

    assert out["synthesis"] is None
    assert out["admet"] is not None and out["case"] is not None
    assert len(calls) == 4, "a failed section stopped the ones after it"

    # The failure is reported as a step, and no workup event claims that section.
    failed = [e for e in job["events"] if e["type"] == "workup_step" and e["status"] == "error"]
    assert [e["step"] for e in failed] == ["synthesis"]
    assert "synthesis" not in [e["kind"] for e in job["events"] if e["type"] == "workup"]
