"""One disease in, three designed molecules out.

The per-drug run in api/design.py answers "can this drug be improved". This
answers a question a reader actually has: given a disease, what would you
design for it, and does the answer depend on what you were allowed to learn
from. So the same run happens three times at once over three pools of prior
art:

    approved          drugs already approved for this disease
    investigational   compounds that were tried here and never got there
    all               both lists together

Each track picks its own starting drug from its own pool, so the three usually
diverge at the first step and stay apart. That divergence is the point: it shows
what the prior art was doing to the design, which a single run cannot show.

Three tracks, one job, one event stream. Every event carries the track it came
from. A track that fails records its own error and the others carry on, because
three independent runs failing together would only ever be our fault.

The honesty rules are the ones in api/design.py, unchanged and enforced in the
same code: the model proposes structures, RDKit judges them, rejected attempts
stay in the record, and nothing here has been made or tested.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from api import cache, chemcheck, config
from api.design import (StartResponse, _emit, _jobs, _load_pocket, _lock, _public, _rank_key,
                        build_context, pocket_lines, pocket_mod, run_rounds)
from api.workup import run_workup

log = logging.getLogger("repurposekg.design.disease")
router = APIRouter(prefix="/api/design", tags=["design"])

SOURCE = "design_disease"
POOLS = ("approved", "investigational", "all")

# How each track is introduced. Written here rather than in the page because the
# reader needs to know what a track was allowed to see to read its result.
TRACKS: dict[str, dict[str, str]] = {
    "approved": {
        "label": "Built on approved drugs",
        "blurb": "Starts from the best-ranked drug already approved for people, so every "
                 "structure it borrows from is one that cleared safety.",
    },
    "investigational": {
        "label": "Built on compounds that stalled",
        "blurb": "Starts from the best-ranked compound that never reached approval, where the "
                 "chemistry was explored by someone and then dropped.",
    },
    "all": {
        "label": "Built on everything known",
        "blurb": "Starts from the best-ranked compound of either kind and may learn from both "
                 "lists at once.",
    },
}


def _job_key(disease_id: str) -> str:
    return f"disease|{disease_id}|{config.GEMINI_MODEL}|v1"


def _blank_track(pool: str) -> dict[str, Any]:
    return {"pool": pool, **TRACKS[pool], "status": "waiting", "seed": None,
            "studied": {"approved": 0, "investigational": 0}, "pocket": None,
            "proteins": [], "attempts": [], "best": None, "workup": None, "error": None}


@router.post("/disease", response_model=StartResponse)
async def start_disease(
    disease_id: str = Query(description="e.g. MONDO_0010726"),
    force: bool = Query(False, description="ignore a cached run and design again"),
) -> StartResponse:
    """Start the three-track run for one disease, or re-attach to one already going."""
    if not config.have_llm():
        raise HTTPException(503, "No GEMINI_API_KEY. Put it in .env at the repo root.")

    from api.main import resolve_disease

    resolve_disease(disease_id)  # 404s with something useful if the id is wrong

    key = _job_key(disease_id)
    if not force:
        done = cache.get(SOURCE, key)
        if done:
            # Stable id: the same finished run keeps its job id across restarts, so a
            # page that reloads a week later re-attaches instead of designing again.
            job_id = "c" + hashlib.sha256(key.encode()).hexdigest()[:11]
            _jobs[job_id] = {**done, "job_id": job_id, "kind": "disease", "cached": True,
                             "started": time.time(), "key": key}
            return StartResponse(job_id=job_id, status="done", cached=True)

    async with _lock:
        # Reloading the page must not start a second run. One worker holds the whole
        # store (the Procfile pins --workers 1), so this scan sees every live job.
        for jid, job in _jobs.items():
            if job.get("key") == key and job["status"] == "running":
                return StartResponse(job_id=jid, status="running", cached=False)
        job_id = uuid.uuid4().hex[:12]
        _jobs[job_id] = {
            "job_id": job_id, "kind": "disease", "key": key, "status": "running",
            "started": time.time(), "disease_id": disease_id, "disease_name": disease_id,
            "tracks": {pool: _blank_track(pool) for pool in POOLS},
            "events": [], "random_pass_rate": round(chemcheck.RANDOM_PASS_RATE, 3),
            "error": None, "cached": False,
        }

    asyncio.create_task(_run_disease(job_id))
    return StartResponse(job_id=job_id, status="running", cached=False)


# ── the run ──────────────────────────────────────────────────────────────────

def _pick_seed(result: dict[str, Any], pool: str,
               smiles_of: dict[str, str | None]) -> dict[str, Any] | None:
    """The top-ranked drug in this pool that we have a structure for.

    A drug with no SMILES cannot be designed from, so it is skipped rather than
    failing the track. `all` merges the two lists on score, which is comparable
    across them: it is scaled against the same top-ranked compound.
    """
    if pool == "all":
        ranked = sorted(result["approved"] + result["investigational"],
                        key=lambda c: -c["score"])
    else:
        ranked = result[pool]
    for row in ranked:
        if (smiles_of.get(row["drug_id"]) or "").strip():
            return row
    return None


def _proteins(targets: list[dict[str, Any]], used: dict[str, Any] | None,
              pocket: pocket_mod.Pocket | None) -> list[dict[str, Any]]:
    """The seed's target proteins, marking the one a measured pose was found in.

    Only that one is marked. The structure lookup stops at the first target it
    finds a co-crystal for, so for the others we have not looked and must not
    imply that we did.
    """
    out = []
    for target in targets:
        hit = (pocket is not None and used is not None
               and target.get("gene_id") == used.get("gene_id"))
        out.append({"gene_id": target.get("gene_id"), "symbol": target["symbol"],
                    "uniprot_id": target.get("uniprot"),
                    "has_structure": hit, "pdb_id": pocket.pdb_id if hit else None})
    return out


def _counts(tracks: dict[str, dict[str, Any]]) -> tuple[int, int]:
    tried = sum(len(t["attempts"]) for t in tracks.values())
    accepted = sum(1 for t in tracks.values() for a in t["attempts"]
                   if a["check"]["status"] == "pass")
    return tried, accepted


async def _run_disease(job_id: str) -> None:
    job = _jobs[job_id]
    try:
        _emit(job, "phase", text="Reading the chemistry database")
        await asyncio.to_thread(chemcheck.warm)  # once, not three times

        from api.main import scorer

        s = scorer()
        # Scored once and shared read-only. Each track narrows it to its own pool
        # rather than scoring the same disease three times.
        result = await asyncio.to_thread(s.candidates, job["disease_id"], 10)
        job["disease_name"] = result["disease"]["name"]
        _emit(job, "phase",
              text=f"{len(result['approved'])} approved and "
                   f"{len(result['investigational'])} not-approved compounds ranked for "
                   f"{job['disease_name']}. Three tracks start now, one per pool.")

        # One track failing must not take the others with it. Each track already
        # catches its own failures; return_exceptions is the second line of that.
        await asyncio.gather(*(_run_track(job, pool, result) for pool in POOLS),
                             return_exceptions=True)

        tried, accepted = _counts(job["tracks"])

        # Saved only if something survived. A run where every track failed has
        # nothing in it worth keeping, and every cause of all three failing at
        # once is shared and temporary -- the key, a rate limit, the model being
        # down -- rather than anything about this disease. Caching that would
        # turn five bad minutes into a disease whose page stays broken for every
        # later visitor. A partial run is kept: two good tracks are worth having
        # and the third reports its own failure.
        survived = [p for p, t in job["tracks"].items() if t["status"] == "done"]
        if not survived:
            # Said before `done`, which a reader may treat as the last word.
            _emit(job, "note", text="Every track failed, so nothing was saved. Designing "
                                    "again will start a fresh run rather than show you this.")

        job["status"] = "done"
        _emit(job, "done", tried=tried, accepted=accepted)
        if survived:
            # After the `done` event, so a cached run replays as a finished one.
            cache.put(SOURCE, job["key"], _public(job))
        log.info("disease design %s: %d attempts, %d accepted, tracks %s, %s",
                 job["disease_id"], tried, accepted,
                 {p: t["status"] for p, t in job["tracks"].items()},
                 f"cached ({len(survived)} track(s) survived)" if survived else "not cached")

    except Exception as exc:  # noqa: BLE001 - the job must report, never vanish
        log.exception("disease design job failed")
        job["status"] = "error"
        job["error"] = str(exc)
        _emit(job, "error", text=str(exc))


async def _run_track(job: dict[str, Any], pool: str, result: dict[str, Any]) -> None:
    """One track: pick a seed from this pool, design against it, work the winner up."""
    track = job["tracks"][pool]
    track["status"] = "running"
    try:
        from api.main import scorer

        s = scorer()
        smiles_of = dict(zip(s.drugs["drug_id"].to_list(), s.drugs["smiles"].to_list()))
        row = _pick_seed(result, pool, smiles_of)
        if row is None:
            raise RuntimeError(
                f"Nothing ranked in the {pool.replace('all', 'combined')} pool for "
                f"{job['disease_name']} has a structure on record, so there is nothing "
                "to design from here.")

        context = await asyncio.to_thread(
            build_context, row["drug_id"], job["disease_id"], pool, result)

        # The seed on the same checks as its own descendants. Without it, "passes
        # every check" reads as an achievement, when the drug it came from passes
        # them too.
        seed_check = await asyncio.to_thread(
            chemcheck.evaluate, context["parent_smiles"], None, None, True)
        track["seed"] = {"drug_id": row["drug_id"], "name": context["parent_name"],
                         "smiles": context["parent_smiles"], "score": row["score"],
                         "check": seed_check}
        track["studied"] = {"approved": context["n_approved"],
                            "investigational": context["n_investigational"]}
        _emit(job, "seed", track=pool, seed=track["seed"])

        pocket, note, used = await _load_pocket(
            row["drug_id"], context["targets"], context["parent_smiles"])
        track["pocket"] = ({"pdb_id": pocket.pdb_id, "resolution_A": pocket.resolution_A}
                           if pocket else None)
        track["proteins"] = _proteins(context["targets"], used, pocket)
        shown, told = pocket_lines(pocket, note, context["parent_name"])
        context["text"] += told
        # Always emitted, structure or no structure, and it carries the proteins: it
        # is the one event the viewer needs before any molecule arrives.
        _emit(job, "pocket", track=pool, text=shown, proteins=track["proteins"],
              **({"pocket": track["pocket"]} if track["pocket"] else {}))

        await run_rounds(job, context, pocket, note, attempts=track["attempts"],
                         track=pool, id_prefix=f"{pool}-")

        ranked = sorted(track["attempts"], key=_rank_key)
        track["attempts"] = ranked
        track["best"] = ranked[0] if ranked else None
        if track["best"]:
            _emit(job, "best", track=pool, id=track["best"]["id"], name=track["best"]["name"],
                  status=track["best"]["check"]["status"])
            track["workup"] = await run_workup(job, pool, track, context)
        else:
            _emit(job, "note", track=pool,
                  text="No molecule survived to be worked up in this track.")

        track["status"] = "done"

    except Exception as exc:  # noqa: BLE001 - one track's failure is its own
        log.warning("design track %s failed: %s", pool, exc, exc_info=True)
        track["status"] = "error"
        track["error"] = str(exc)
        _emit(job, "error", track=pool, text=str(exc))

    # Sent whether the track finished or failed, so "all three have stopped" is one
    # thing to watch for rather than two.
    _emit(job, "track_done", track=pool, tried=len(track["attempts"]),
          accepted=sum(1 for a in track["attempts"] if a["check"]["status"] == "pass"))
