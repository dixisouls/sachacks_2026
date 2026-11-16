"""The three-track run. Run: venv/bin/python -m pytest tests -q

Three tracks share one event list and one job, so the things worth testing are
the ones concurrency can break and no amount of looking at the page would
reveal: that the replay index stays unique and increasing, that the tracks do
not write into each other, and that one track dying leaves the other two alone.

The model and the chemistry engine are stubbed out. What is under test is the
plumbing around them.
"""

import asyncio
import time

import polars as pl
import pytest

from api import design, design_disease
from api.design import _emit
from api.design_disease import POOLS, _pick_seed, _proteins, _run_disease

def _run(coro, timeout: float = 30):
    """Run one coroutine to completion, with a timeout so a deadlock fails the test."""
    async def guarded():
        return await asyncio.wait_for(coro, timeout)

    return asyncio.run(guarded())


# ── the shared event list ────────────────────────────────────────────────────

def test_emit_leaves_the_track_off_job_level_events():
    job = {"events": [], "started": time.time()}
    _emit(job, "phase", text="hello")
    _emit(job, "seed", track="approved", seed={"name": "Baclofen"})
    assert "track" not in job["events"][0]
    assert job["events"][1]["track"] == "approved"
    assert [e["i"] for e in job["events"]] == [0, 1]


def test_the_replay_index_survives_concurrent_tracks():
    """`i` must be unique and increasing however the three tracks interleave."""
    job = {"events": [], "started": time.time()}

    async def noisy(track: str) -> None:
        for n in range(40):
            _emit(job, "molecule", track=track, id=f"{track}-{n}")
            await asyncio.sleep(0)  # hand control to the other tracks mid-run

    async def all_three() -> None:
        await asyncio.gather(*(noisy(pool) for pool in POOLS))

    _run(all_three())

    indices = [e["i"] for e in job["events"]]
    assert len(indices) == 120
    assert indices == sorted(indices), "events went backwards"
    assert len(set(indices)) == len(indices), "an index was reused"
    assert indices == list(range(120))
    # And all three really did interleave, or the test proves nothing.
    tracks = [e["track"] for e in job["events"]]
    assert len(set(tracks[:6])) > 1


# ── seed choice ──────────────────────────────────────────────────────────────

def _rows(*spec):
    return [{"drug_id": d, "score": s} for d, s in spec]


def test_each_pool_picks_from_its_own_list():
    result = {"approved": _rows(("A1", 100), ("A2", 60)),
              "investigational": _rows(("I1", 80), ("I2", 70))}
    smiles = {"A1": "CCO", "A2": "CCN", "I1": "CCC", "I2": "CCF"}
    assert _pick_seed(result, "approved", smiles)["drug_id"] == "A1"
    assert _pick_seed(result, "investigational", smiles)["drug_id"] == "I1"
    # `all` merges on score, which is scaled against the same top compound.
    assert _pick_seed(result, "all", smiles)["drug_id"] == "A1"


def test_all_can_pick_a_compound_that_was_never_approved():
    result = {"approved": _rows(("A1", 40)), "investigational": _rows(("I1", 90))}
    smiles = {"A1": "CCO", "I1": "CCC"}
    assert _pick_seed(result, "all", smiles)["drug_id"] == "I1"


def test_a_drug_with_no_structure_is_skipped_not_fatal():
    result = {"approved": _rows(("A1", 100), ("A2", 90), ("A3", 80)),
              "investigational": []}
    smiles = {"A1": None, "A2": "   ", "A3": "CCO"}
    assert _pick_seed(result, "approved", smiles)["drug_id"] == "A3"
    assert _pick_seed(result, "investigational", smiles) is None


# ── which protein carries a pose ─────────────────────────────────────────────

class FakePocket:
    pdb_id = "4MS3"
    resolution_A = 2.1


def test_only_the_protein_the_pose_came_from_is_marked():
    targets = [{"symbol": "GABBR1", "uniprot": "Q9UBS5", "gene_id": "G1"},
               {"symbol": "GABBR2", "uniprot": "O75899", "gene_id": "G2"}]
    out = _proteins(targets, targets[1], FakePocket())
    assert [p["has_structure"] for p in out] == [False, True]
    assert [p["pdb_id"] for p in out] == [None, "4MS3"]
    assert out[0]["uniprot_id"] == "Q9UBS5"


def test_no_pocket_means_no_protein_claims_one():
    targets = [{"symbol": "GABBR1", "uniprot": "Q9UBS5", "gene_id": "G1"}]
    out = _proteins(targets, None, None)
    assert out[0]["has_structure"] is False and out[0]["pdb_id"] is None


# ── a whole run, with the model and the chemistry stubbed out ────────────────

CANDIDATES = {
    "disease": {"disease_id": "MONDO_0000001", "name": "test disease", "n_genes": 7},
    "approved": _rows(("A1", 100), ("A2", 70)),
    "investigational": _rows(("I1", 85)),
}


@pytest.fixture
def stub(monkeypatch):
    """A scorer, a context, a pocket lookup and a round loop that need nothing."""
    from api import main

    class FakeScorer:
        drugs = pl.DataFrame({"drug_id": ["A1", "A2", "I1"],
                              "smiles": ["CCO", "CCN", "CCC"]})

        def candidates(self, disease_id, limit=10):
            return CANDIDATES

    monkeypatch.setitem(main.state, "scorer", FakeScorer())

    def fake_context(drug_id, disease_id, pool="all", result=None):
        return {"text": f"context for {pool}", "parent_smiles": "CCO",
                "parent_name": f"Seed-{drug_id}", "disease_name": "test disease",
                "targets": [{"symbol": "GABBR1", "uniprot": "Q9UBS5", "gene_id": "G1"}],
                "n_approved": 2 if pool != "investigational" else 0,
                "n_investigational": 1 if pool != "approved" else 0}

    async def fake_pocket(drug_id, targets, smiles):
        await asyncio.sleep(0)
        return None, "no structure on record", None

    def fake_evaluate(smiles, parent=None, name=None, known=False):
        return {"smiles": smiles, "valid": True, "status": "pass",
                "summary": "Passes every check.", "checks": [], "properties": {"sa_score": 3.1}}

    async def fake_rounds(job, context, pocket, note, *, attempts, track=None, id_prefix=""):
        for n in range(2):
            await asyncio.sleep(0)  # let the other tracks in
            attempt = {"id": f"{id_prefix}1-{n}", "track": track, "round": 1,
                       "name": f"{track}-{n}", "rationale": "", "builds_on": "",
                       "check": fake_evaluate("CCO")}
            attempts.append(attempt)
            _emit(job, "verdict", track=track, id=attempt["id"], status="pass",
                  summary="Passes every check.", check=attempt["check"])
        return attempts

    async def fake_workup(job, pool, track, context):
        await asyncio.sleep(0)
        _emit(job, "workup", track=pool, kind="case", data={"verdict": f"for {pool}"})
        return {"synthesis": None, "admet": None, "offtarget": None,
                "case": {"verdict": f"for {pool}", "for": [], "against": [], "next_step": "x"}}

    monkeypatch.setattr(design_disease, "build_context", fake_context)
    monkeypatch.setattr(design_disease, "_load_pocket", fake_pocket)
    monkeypatch.setattr(design_disease, "run_rounds", fake_rounds)
    monkeypatch.setattr(design_disease, "run_workup", fake_workup)
    monkeypatch.setattr(design_disease.chemcheck, "evaluate", fake_evaluate)
    monkeypatch.setattr(design_disease.chemcheck, "warm", lambda: None)
    monkeypatch.setattr(design_disease.cache, "put", lambda *a, **k: None)


def _new_job(job_id="testjob"):
    job = {"job_id": job_id, "kind": "disease", "key": "k", "status": "running",
           "started": time.time(), "disease_id": "MONDO_0000001",
           "disease_name": "MONDO_0000001",
           "tracks": {pool: design_disease._blank_track(pool) for pool in POOLS},
           "events": [], "random_pass_rate": 0.815, "error": None, "cached": False}
    design._jobs[job_id] = job
    return job


def test_three_tracks_run_at_once_and_keep_to_themselves(stub):
    job = _new_job()
    try:
        _run(_run_disease("testjob"))
    finally:
        design._jobs.pop("testjob", None)

    assert job["status"] == "done"
    assert job["disease_name"] == "test disease"

    indices = [e["i"] for e in job["events"]]
    assert indices == list(range(len(indices))), "the replay index broke under three tracks"

    for pool in POOLS:
        track = job["tracks"][pool]
        assert track["status"] == "done", pool
        assert track["seed"] is not None and track["best"] is not None
        # Each track's attempts belong to it and nobody else.
        assert len(track["attempts"]) == 2
        assert {a["track"] for a in track["attempts"]} == {pool}
        assert all(a["id"].startswith(f"{pool}-") for a in track["attempts"])
        assert track["workup"]["case"]["verdict"] == f"for {pool}"

    # Attempt ids are unique across the whole job, not just within a track.
    ids = [a["id"] for t in job["tracks"].values() for a in t["attempts"]]
    assert len(set(ids)) == len(ids)

    # The three pools picked their own seeds from their own lists.
    assert job["tracks"]["approved"]["seed"]["drug_id"] == "A1"
    assert job["tracks"]["investigational"]["seed"]["drug_id"] == "I1"
    assert job["tracks"]["approved"]["studied"] == {"approved": 2, "investigational": 0}
    assert job["tracks"]["investigational"]["studied"] == {"approved": 0, "investigational": 1}

    done = next(e for e in job["events"] if e["type"] == "done")
    assert done["tried"] == 6 and done["accepted"] == 6
    assert "track" not in done
    assert {e["track"] for e in job["events"] if e["type"] == "track_done"} == set(POOLS)


def test_every_track_emits_one_pocket_event_carrying_its_proteins(stub):
    job = _new_job("pocketjob")
    try:
        _run(_run_disease("pocketjob"))
    finally:
        design._jobs.pop("pocketjob", None)

    for pool in POOLS:
        events = [e for e in job["events"] if e["type"] == "pocket" and e["track"] == pool]
        assert len(events) == 1, f"{pool} sent {len(events)} pocket events"
        assert events[0]["proteins"] == job["tracks"][pool]["proteins"]
        assert events[0]["proteins"][0]["symbol"] == "GABBR1"
        assert "pocket" not in events[0]  # none was found, so none is claimed
        # It arrives after the seed and before any molecule of that track.
        seed = next(e for e in job["events"] if e["type"] == "seed" and e["track"] == pool)
        first = next(e for e in job["events"]
                     if e["type"] == "verdict" and e["track"] == pool)
        assert seed["i"] < events[0]["i"] < first["i"]


def test_one_track_failing_leaves_the_other_two_running(stub, monkeypatch):
    real = design_disease.run_rounds

    async def explode(job, context, pocket, note, *, attempts, track=None, id_prefix=""):
        if track == "investigational":
            raise RuntimeError("the model fell over")
        return await real(job, context, pocket, note, attempts=attempts, track=track,
                          id_prefix=id_prefix)

    monkeypatch.setattr(design_disease, "run_rounds", explode)
    job = _new_job("brokenjob")
    try:
        _run(_run_disease("brokenjob"))
    finally:
        design._jobs.pop("brokenjob", None)

    assert job["status"] == "done", "one track's failure took the whole job down"
    assert job["error"] is None
    assert job["tracks"]["investigational"]["status"] == "error"
    assert job["tracks"]["investigational"]["error"] == "the model fell over"
    assert job["tracks"]["investigational"]["workup"] is None
    for pool in ("approved", "all"):
        assert job["tracks"][pool]["status"] == "done"
        assert len(job["tracks"][pool]["attempts"]) == 2

    # The failure is on the record, tagged, and the track still reports stopping.
    error = next(e for e in job["events"] if e["type"] == "error")
    assert error["track"] == "investigational"
    assert {e["track"] for e in job["events"] if e["type"] == "track_done"} == set(POOLS)
    assert [e["i"] for e in job["events"]] == list(range(len(job["events"])))


def test_a_pool_with_no_usable_seed_fails_only_itself(stub, monkeypatch):
    def no_seed(result, pool, smiles_of):
        return None if pool == "approved" else _pick_seed(result, pool, smiles_of)

    monkeypatch.setattr(design_disease, "_pick_seed", no_seed)
    job = _new_job("seedlessjob")
    try:
        _run(_run_disease("seedlessjob"))
    finally:
        design._jobs.pop("seedlessjob", None)

    assert job["status"] == "done"
    assert job["tracks"]["approved"]["status"] == "error"
    assert "nothing" in job["tracks"]["approved"]["error"].lower()
    assert job["tracks"]["approved"]["seed"] is None
    assert job["tracks"]["all"]["status"] == "done"


def test_the_public_job_carries_the_three_tracks_and_no_internals(stub):
    job = _new_job("publicjob")
    try:
        _run(_run_disease("publicjob"))
        public = design._public(job)
    finally:
        design._jobs.pop("publicjob", None)

    assert set(public["tracks"]) == set(POOLS)
    assert public["disease_name"] == "test disease"
    assert public["random_pass_rate"] == 0.815
    assert "key" not in public and "started" not in public and "kind" not in public
    track = public["tracks"]["approved"]
    for field in ("pool", "label", "blurb", "status", "seed", "studied", "pocket",
                  "proteins", "attempts", "best", "workup", "error"):
        assert field in track, field


def test_a_run_where_every_track_failed_is_not_cached(stub, monkeypatch):
    """Caching that would make a transient outage permanent for one disease.

    Every cause of all three tracks failing at once is shared and temporary, so
    the run holds nothing worth keeping and keeping it would break the page for
    every later visitor until someone chose to spend a run.
    """
    async def explode(job, context, pocket, note, *, attempts, track=None, id_prefix=""):
        raise RuntimeError("the model is down")

    saved = []
    monkeypatch.setattr(design_disease, "run_rounds", explode)
    monkeypatch.setattr(design_disease.cache, "put", lambda *a: saved.append(a))
    job = _new_job("deadjob")
    try:
        _run(_run_disease("deadjob"))
    finally:
        design._jobs.pop("deadjob", None)

    assert job["status"] == "done"
    assert all(t["status"] == "error" for t in job["tracks"].values())
    assert saved == [], "an all-failed run was cached"
    assert any(e["type"] == "note" and "nothing was saved" in e["text"]
               for e in job["events"])


def test_a_partly_failed_run_is_still_cached(stub, monkeypatch):
    """Two good tracks are worth keeping, whatever the third did."""
    real = design_disease.run_rounds

    async def one_bad(job, context, pocket, note, *, attempts, track=None, id_prefix=""):
        if track == "all":
            raise RuntimeError("just this one")
        return await real(job, context, pocket, note, attempts=attempts, track=track,
                          id_prefix=id_prefix)

    saved = []
    monkeypatch.setattr(design_disease, "run_rounds", one_bad)
    monkeypatch.setattr(design_disease.cache, "put", lambda *a: saved.append(a))
    job = _new_job("partjob")
    try:
        _run(_run_disease("partjob"))
    finally:
        design._jobs.pop("partjob", None)

    assert len(saved) == 1, "a run with two good tracks was thrown away"
    cached = saved[0][2]
    assert cached["tracks"]["approved"]["best"] is not None
    assert cached["tracks"]["all"]["status"] == "error"



# ── idempotency, which the page depends on ───────────────────────────────────
# The disease page POSTs on every mount with force=false, so "never start a
# second run" is not an optimisation here: if it breaks, every navigation spends
# nine model calls and the page looks like it is burning money.

@pytest.fixture
def route(monkeypatch):
    from api import cache, config, main

    class FakeScorer:
        disease_idx = {"MONDO_0000001": 0}

    monkeypatch.setitem(main.state, "scorer", FakeScorer())
    monkeypatch.setattr(config, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(design_disease.config, "have_llm", lambda: True)

    # api.cache.get opens the on-disk envelope itself, so the fake is keyed the
    # same way the real one is and returns the value, not a wrapper.
    store: dict[str, object] = {}
    monkeypatch.setattr(cache, "get", lambda src, key: store.get(key))

    started: list[str] = []

    async def fake_run(job_id):
        started.append(job_id)

    monkeypatch.setattr(design_disease, "_run_disease", fake_run)
    return store, started


def _post(disease_id="MONDO_0000001", force=False):
    return _run(design_disease.start_disease(disease_id=disease_id, force=force), timeout=10)


def test_posting_twice_does_not_start_a_second_run(route):
    store, started = route
    ids = []
    try:
        first = _post()
        second = _post()
        ids = [first.job_id, second.job_id]
        assert first.status == "running" and first.cached is False
        assert second.job_id == first.job_id, "a reload started a second run"
        assert second.status == "running" and second.cached is False
        assert started == [first.job_id], "the run was launched twice"
    finally:
        for jid in ids:
            design._jobs.pop(jid, None)


def test_a_finished_run_comes_back_cached_under_a_stable_id(route):
    store, started = route
    finished = {"job_id": "whatever", "status": "done", "disease_id": "MONDO_0000001",
                "disease_name": "test disease", "tracks": {}, "events": [],
                "error": None, "cached": False}
    store[design_disease._job_key("MONDO_0000001")] = finished
    try:
        first, second = _post(), _post()
        assert first.status == "done" and first.cached is True
        assert first.job_id.startswith("c")
        # Stable across calls, and so across restarts: it is a hash of the key.
        assert second.job_id == first.job_id
        assert started == [], "a cached run was designed again"
        assert design._jobs[first.job_id]["kind"] == "disease"
        assert design._public(design._jobs[first.job_id])["cached"] is True
    finally:
        design._jobs.pop(first.job_id, None)


def test_force_designs_again_even_with_a_cached_run(route):
    store, started = route
    store[design_disease._job_key("MONDO_0000001")] = {
        "job_id": "x", "status": "done", "disease_id": "MONDO_0000001",
        "disease_name": "d", "tracks": {}, "events": [], "error": None, "cached": False}
    forced = None
    try:
        forced = _post(force=True)
        assert forced.status == "running" and forced.cached is False
        assert not forced.job_id.startswith("c")
        assert started == [forced.job_id]
    finally:
        if forced:
            design._jobs.pop(forced.job_id, None)


def test_the_model_name_is_part_of_the_key(route):
    before = design_disease._job_key("MONDO_0000001")
    assert design_disease.config.GEMINI_MODEL in before
    assert design_disease._job_key("MONDO_0000002") != before


def test_two_diseases_do_not_share_a_run(route):
    store, started = route
    ids = []
    try:
        one = _post("MONDO_0000001")
        from api import main
        main.state["scorer"].disease_idx["MONDO_0000002"] = 1
        two = _post("MONDO_0000002")
        ids = [one.job_id, two.job_id]
        assert one.job_id != two.job_id
        assert sorted(started) == sorted(ids)
    finally:
        for jid in ids:
            design._jobs.pop(jid, None)


def test_done_is_the_last_event_and_a_cached_run_replays_as_finished(stub, monkeypatch):
    """Order matters at both ends of the finish.

    `done` must be last, because a reader may treat it as the last word, and the
    cache must be written after it, or a cached run replays without ever saying
    it finished.
    """
    saved = []
    monkeypatch.setattr(design_disease.cache, "put", lambda *a: saved.append(a))
    job = _new_job("orderjob")
    try:
        _run(_run_disease("orderjob"))
    finally:
        design._jobs.pop("orderjob", None)

    assert job["events"][-1]["type"] == "done"
    cached = saved[0][2]
    assert cached["events"][-1]["type"] == "done"
    assert cached["status"] == "done"


def test_the_all_failed_note_arrives_before_done(stub, monkeypatch):
    async def explode(job, context, pocket, note, *, attempts, track=None, id_prefix=""):
        raise RuntimeError("the model is down")

    monkeypatch.setattr(design_disease, "run_rounds", explode)
    job = _new_job("notejob")
    try:
        _run(_run_disease("notejob"))
    finally:
        design._jobs.pop("notejob", None)

    kinds = [e["type"] for e in job["events"]]
    note = next(i for i, e in enumerate(job["events"])
                if e["type"] == "note" and "nothing was saved" in e["text"])
    assert note < kinds.index("done")
    assert kinds[-1] == "done"
