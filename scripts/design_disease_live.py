"""Run the real three-track disease job in-process and audit its event stream.

    venv/bin/python scripts/design_disease_live.py MONDO_0005301 [--save run.json]

This spends real model calls, which is the point: scripts/design_disease_check.py
proves a disease has seeds to design from, and tests/test_design_disease.py
proves the plumbing with the model stubbed, but neither one ever watches a live
run. The failures that only a live run shows -- a track that deadlocks, an event
index that repeats, a workup section that crashes on a null, a budget spent
entirely on thinking -- are the ones this catches.

Every rule in DESIGN_API.md that can be checked from the outside is checked here
against the stream the run actually produced, because a contract nobody tests is
a document, not a contract.

With --save it writes the whole finished job, events and all, to a file: a run
costs real money and takes three minutes, so an audit failure is worth being
able to read again without paying for another one. Saved whether the audit
passed or not, which is the case you most want to keep.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api import chemcheck, config  # noqa: E402
from api.design import _jobs, _public  # noqa: E402
from api.design_disease import POOLS, _blank_track, _job_key, _run_disease  # noqa: E402
from api.scoring import Scorer  # noqa: E402
from api.workup import case_floor  # noqa: E402


def audit(job: dict) -> list[str]:
    """Every DESIGN_API.md rule that can be judged from the finished job."""
    bad: list[str] = []
    events = job["events"]

    # "Events never arrive out of order and `i` never repeats."
    for n, event in enumerate(events):
        if event.get("i") != n:
            bad.append(f"event {n} has i={event.get('i')}: indices must be dense and unique")
            break
    ats = [e.get("at") for e in events]
    if any(b is not None and a is not None and b < a for a, b in zip(ats, ats[1:])):
        bad.append("event timestamps go backwards")
    if any(e["type"] == "end" for e in events):
        bad.append("an `end` event was stored; it belongs to the stream only")

    if set(job["tracks"]) != set(POOLS):
        bad.append(f"tracks are {sorted(job['tracks'])}, must always be all three pools")

    for pool in POOLS:
        mine = [e for e in events if e.get("track") == pool]
        kinds = [e["type"] for e in mine]
        track = job["tracks"].get(pool)
        if track is None:
            continue  # already reported above; indexing it here would only crash

        if track["status"] == "error":
            # A failed track is allowed, but it must say so and not poison the rest.
            if not track["error"]:
                bad.append(f"{pool}: status error with no error string")
            continue

        # "Exactly one `pocket` event per track, after its `seed` and before its
        # first `round`." It carries the proteins, so the viewer never re-fetches.
        if kinds.count("pocket") != 1:
            bad.append(f"{pool}: {kinds.count('pocket')} pocket events, must be exactly 1")
        else:
            at = kinds.index("pocket")
            if "seed" not in kinds[:at]:
                bad.append(f"{pool}: pocket event arrived before the seed")
            if "round" in kinds[:at]:
                bad.append(f"{pool}: pocket event arrived after a round began")
            if "proteins" not in mine[at]:
                bad.append(f"{pool}: pocket event carries no proteins")

        # "A `molecule` always precedes its `verdict`."
        proposed: set[str] = set()
        for event in mine:
            if event["type"] == "molecule":
                if event["id"] in proposed:
                    bad.append(f"{pool}: molecule {event['id']} proposed twice")
                proposed.add(event["id"])
            elif event["type"] == "verdict" and event["id"] not in proposed:
                bad.append(f"{pool}: verdict for {event['id']} with no molecule before it")

        ids = [a["id"] for a in track["attempts"]]
        if len(ids) != len(set(ids)):
            bad.append(f"{pool}: duplicate attempt ids")
        if sorted(ids) != sorted(proposed - _unjudged(mine)):
            bad.append(f"{pool}: attempts and judged molecules disagree")

        if "track_done" not in kinds:
            bad.append(f"{pool}: no track_done event")

        # Every check the frontend renders must carry every field of `Check`.
        for attempt in track["attempts"]:
            for check in attempt["check"]["checks"]:
                missing = {"id", "label", "status", "value", "detail", "problem"} - set(check)
                if missing:
                    bad.append(f"{pool}: check {check.get('id')} on {attempt['id']} is "
                               f"missing {sorted(missing)}")

        workup = track["workup"]
        if track["best"] and workup is None:
            bad.append(f"{pool}: a winner was picked but no workup ran")
        if workup:
            for kind, data in workup.items():
                sent = [e for e in mine if e["type"] == "workup" and e["kind"] == kind]
                if data is None:
                    if sent:
                        bad.append(f"{pool}: {kind} is null but a workup event was sent")
                    continue
                if not sent:
                    bad.append(f"{pool}: {kind} was produced but never emitted")
                elif sent[-1]["data"] != data:
                    bad.append(f"{pool}: the {kind} event disagrees with the stored section")
            case = workup.get("case")
            if case:
                # "`case.against` always contains the three honest facts."
                for fact in case_floor(track):
                    if fact not in case["against"]:
                        bad.append(f"{pool}: the case dropped a floor fact: {fact[:60]}...")
                if not case["verdict"] or not case["next_step"]:
                    bad.append(f"{pool}: the case has no verdict or no next step")
            offtarget = workup.get("offtarget")
            if offtarget is not None and not offtarget.get("note"):
                # The empty case is a result and has to explain itself.
                bad.append(f"{pool}: the off-target section has no note")

    if job["status"] != "done":
        bad.append(f"job status is {job['status']!r}, not done")
    if not any(e["type"] == "done" for e in events):
        bad.append("no job-level done event")

    try:
        json.dumps(_public(job))
    except (TypeError, ValueError) as exc:
        bad.append(f"the job will not serialise to JSON: {exc}")
    return bad


def _unjudged(events: list[dict]) -> set[str]:
    """Molecules that were proposed but never got a verdict (there should be none)."""
    judged = {e["id"] for e in events if e["type"] == "verdict"}
    return {e["id"] for e in events if e["type"] == "molecule"} - judged


def summarise(job: dict) -> None:
    print(f"\n{job['disease_name']} ({job['disease_id']}) -- {job['status']}, "
          f"{len(job['events'])} events, {time.time() - job['started']:.0f}s")
    for pool in POOLS:
        track = job["tracks"][pool]
        seed = (track["seed"] or {}).get("name", "-")
        best = (track["best"] or {}).get("name", "-")
        passed = sum(1 for a in track["attempts"] if a["check"]["status"] == "pass")
        sections = [k for k, v in (track["workup"] or {}).items() if v]
        print(f"  {pool:16} {track['status']:7} seed {seed:22} "
              f"{len(track['attempts'])} tried, {passed} pass, best {best}")
        print(f"  {'':16} pocket {track['pocket'] or 'none':<28} "
              f"workup {', '.join(sections) or 'nothing'}")
        if track["error"]:
            print(f"  {'':16} ERROR {track['error']}")
        unjudged = _unjudged([e for e in job["events"] if e.get("track") == pool])
        if unjudged:
            print(f"  {'':16} UNJUDGED {sorted(unjudged)}")


async def main(disease_id: str, save_to: str | None) -> int:
    if not config.have_llm():
        print("No GEMINI_API_KEY in .env, so there is no live run to make.")
        return 2

    from api import main as api_main

    print(f"loading artifacts, model {config.GEMINI_MODEL}")
    api_main.state["scorer"] = Scorer()

    job_id = "live" + str(int(time.time()))[-8:]
    _jobs[job_id] = {
        "job_id": job_id, "kind": "disease", "key": _job_key(disease_id), "status": "running",
        "started": time.time(), "disease_id": disease_id, "disease_name": disease_id,
        "tracks": {pool: _blank_track(pool) for pool in POOLS},
        "events": [], "random_pass_rate": round(chemcheck.RANDOM_PASS_RATE, 3),
        "error": None, "cached": False,
    }

    watcher = asyncio.create_task(_watch(_jobs[job_id]))
    await _run_disease(job_id)
    watcher.cancel()

    job = _jobs[job_id]
    summarise(job)

    bad = audit(job)
    print(f"\n{len(bad)} contract problem(s)")
    for problem in bad:
        print(f"  ! {problem}")

    if save_to:
        out = Path(save_to).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(_public(job), indent=1))
        print(f"\nwrote {out} ({out.stat().st_size // 1024} KB)")
    return 1 if bad else 0


async def _watch(job: dict) -> None:
    """Print events as they land, so a stall is visible while it is happening."""
    seen = 0
    while True:
        while seen < len(job["events"]):
            event = job["events"][seen]
            seen += 1
            if event["type"] == "thinking":
                continue  # resent whole as it grows; one line per round is enough
            where = event.get("track", "job")
            detail = {k: v for k, v in event.items()
                      if k in ("text", "name", "n", "step", "status", "kind", "id", "tried")}
            print(f"  [{event['at']:7.1f}s {where:16}] {event['type']:12} "
                  f"{str(detail)[:120]}")
        await asyncio.sleep(0.2)


if __name__ == "__main__":
    argv = sys.argv[1:]
    save = argv[argv.index("--save") + 1] if "--save" in argv[:-1] else None
    free = [a for a in argv if not a.startswith("--") and a != save]
    raise SystemExit(asyncio.run(main(free[0] if free else "MONDO_0010726", save)))
