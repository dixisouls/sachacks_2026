"""Design a new molecule from an existing drug, and check it with real chemistry.

This is the one part of the product that proposes something that does not exist.
It is kept honest by three rules:

  1. The model proposes structures only. Every judgement about a structure comes
     from RDKit in api/chemcheck.py, never from the model.
  2. Nothing is hidden. Rejected attempts stay in the record with the reason, so
     the search is visible rather than only its happiest result.
  3. The output is labelled as designed, never made and never tested. It is not
     a repurposing candidate and must not be ranked beside one.

A run takes a while, so it is a job: start it, then watch it. Progress is kept
on the job itself, so a reload re-attaches to the run instead of restarting it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import uuid
from typing import Any, AsyncIterator, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api import cache, chemcheck, config, pocket as pocket_mod

log = logging.getLogger("repurposekg.design")
router = APIRouter(prefix="/api/design", tags=["design"])

SOURCE = "design"
ROUNDS = 3
PER_ROUND = 4
# This model thinks before it writes, and the thinking is charged against the
# same budget (see the note in api/brief.py). Designing is harder than
# summarising, so the budget is far larger here.
MAX_OUTPUT_TOKENS = 32768
# Keep the event stream from going quiet long enough for a proxy to hang up.
HEARTBEAT_S = 15

SYSTEM = """You are a medicinal chemist designing a new small molecule, one round at a time.

You are given a drug that a knowledge graph ranked for a disease, the biological
reason it was ranked, the other drugs ranked for the same disease (both approved
and not approved), and the proteins involved. Your job is to design a molecule
that acts on the same protein as the starting drug, but is better.

How you are judged. After every round a chemistry engine checks each molecule you
propose and reports back: whether the structure is valid, whether it is simply an
existing drug, its drug-likeness, whether a chemist could make it, whether it
contains groups known to cause trouble, and how much it still resembles the
starting drug. You will see those results before the next round. Use them.

Rules, in order of importance:
1. Output SMILES that parse. A structure that is not readable chemistry is a
   wasted round. Prefer a simple molecule you are sure of over an elaborate one.
2. Never propose a molecule that is already a marketed drug. You are designing,
   not recalling.
3. Keep the part of the starting drug that makes it bind its target, and change
   the rest. If you abandon the binding group, say so and say why.
4. Never repeat a structure that was already rejected, and never repeat the same
   mistake twice. If weight was the problem, come back lighter.
5. Explain each molecule in one or two plain sentences: what you changed, and
   what you expect that change to buy. Write for a researcher, not a chemist.
6. Passing the checks is a low bar: most random molecules pass them, and so does
   the drug you are starting from. Clearing them is not success. Aim at a real
   weakness of the starting drug and say which one you are aiming at.

You are proposing hypotheses for a chemist to consider. Nothing you design has
been made or tested, and you must not imply otherwise."""

_REASONING = re.compile(r'"reasoning"\s*:\s*"')
_ESCAPES = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "/": "/"}


def _partial_reasoning(raw: str) -> str | None:
    """The `reasoning` field out of half-written JSON, so the page can show it arriving.

    The model streams one JSON document, and a half-finished document will not
    parse. Rather than show the reader braces and quotes, pull out the one field
    worth watching and leave the rest until it is complete.
    """
    match = _REASONING.search(raw)
    if not match:
        return None
    out: list[str] = []
    i = match.end()
    while i < len(raw):
        char = raw[i]
        if char == "\\":
            if i + 1 >= len(raw):
                break
            out.append(_ESCAPES.get(raw[i + 1], ""))
            i += 2
            continue
        if char == '"':
            break
        out.append(char)
        i += 1
    return "".join(out)


PROPOSAL_SCHEMA = {
    "type": "object",
    "properties": {
        "reasoning": {
            "type": "string",
            "description": "What you learned from the drugs and from the previous round, "
                           "and the strategy for this round. Two to four sentences.",
        },
        "molecules": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "A short working name, e.g. 'RK-3'"},
                    "smiles": {"type": "string"},
                    "rationale": {"type": "string",
                                  "description": "What changed and what it should buy. 1-2 sentences."},
                    "builds_on": {"type": "string",
                                  "description": "Name of the earlier attempt this improves on, "
                                                 "or the starting drug."},
                },
                "required": ["name", "smiles", "rationale"],
            },
        },
    },
    "required": ["reasoning", "molecules"],
}


# ── job store ────────────────────────────────────────────────────────────────
# In memory: a run is worth watching while it happens, and the finished result
# is written to the disk cache, so losing a half-finished run to a restart costs
# nothing but the time.

Status = Literal["running", "done", "error"]
_jobs: dict[str, dict[str, Any]] = {}
_lock = asyncio.Lock()


def _job_key(drug_id: str, disease_id: str) -> str:
    return f"{drug_id}|{disease_id}|{config.GEMINI_MODEL}|v2"


def _emit(job: dict[str, Any], kind: str, /, track: str | None = None,
          **payload: Any) -> None:
    """Append one event. The index lets a reconnecting client replay the rest.

    `track` names which of a disease run's three tracks the event belongs to, and
    is left off job-level events entirely.

    `job` and `kind` are positional-only because a `workup` event carries a field
    of its own called `kind` (which of the four sections it is), and without the
    slash that field collides with this parameter and raises.

    This is deliberately a plain function and not a coroutine. Three tracks run
    concurrently on one event list, and `i` has to be unique and increasing
    across all of them; reading the length and appending with no await in
    between is what makes that true on a single event loop. Do not add one.
    """
    event = {"i": len(job["events"]), "type": kind,
             "at": round(time.time() - job["started"], 2)}
    if track:
        event["track"] = track
    event.update(payload)
    job["events"].append(event)


class StartResponse(BaseModel):
    job_id: str
    status: Status
    cached: bool = Field(description="True when a finished run was reused, so there is nothing to watch.")


@router.post("", response_model=StartResponse)
async def start(
    drug_id: str = Query(description="the drug to design from, e.g. CHEMBL701"),
    disease_id: str = Query(description="e.g. MONDO_0010726"),
    force: bool = Query(False, description="ignore a cached run and design again"),
) -> StartResponse:
    if not config.have_llm():
        raise HTTPException(503, "No GEMINI_API_KEY. Put it in .env at the repo root.")

    from api.main import scorer  # imported here to avoid a circular import at module load

    s = scorer()
    if drug_id not in s.drug_idx:
        raise HTTPException(404, f"No drug with id {drug_id!r}")

    key = _job_key(drug_id, disease_id)
    if not force:
        done = cache.get(SOURCE, key)
        if done:
            # stable id: the same finished run keeps its job id across restarts
            job_id = "c" + hashlib.sha256(key.encode()).hexdigest()[:11]
            _jobs[job_id] = {**done, "job_id": job_id, "cached": True}
            return StartResponse(job_id=job_id, status="done", cached=True)

    async with _lock:
        for jid, job in _jobs.items():
            if job.get("key") == key and job["status"] == "running":
                return StartResponse(job_id=jid, status="running", cached=False)
        job_id = uuid.uuid4().hex[:12]
        _jobs[job_id] = {
            "job_id": job_id, "key": key, "status": "running", "started": time.time(),
            "drug_id": drug_id, "disease_id": disease_id, "events": [], "attempts": [],
            "best": None, "error": None, "cached": False,
        }

    asyncio.create_task(_run(job_id))
    return StartResponse(job_id=job_id, status="running", cached=False)


@router.get("/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    """The whole job, for a client that just reconnected or cannot use the stream."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "No such design job. It may have expired; start a new one.")
    return _public(job)


@router.get("/{job_id}/stream")
async def stream(job_id: str, request: Request, since: int = 0) -> StreamingResponse:
    """Server-sent events. `since` replays from an index, so a reload loses nothing."""
    if job_id not in _jobs:
        raise HTTPException(404, "No such design job.")

    async def events() -> AsyncIterator[str]:
        sent = since
        last = time.monotonic()
        while True:
            if await request.is_disconnected():
                return
            job = _jobs.get(job_id)
            if not job:
                return
            while sent < len(job["events"]):
                event = job["events"][sent]
                sent += 1
                last = time.monotonic()
                yield f"id: {event['i']}\ndata: {json.dumps(event)}\n\n"
            if job["status"] != "running":
                yield f"data: {json.dumps({'type': 'end', 'status': job['status']})}\n\n"
                return
            # A proxy that sees nothing for long enough will close the connection:
            # Heroku's router gives up after 55 seconds. A model can easily think
            # for longer than that before its first token, so say something.
            if time.monotonic() - last > HEARTBEAT_S:
                last = time.monotonic()
                yield ": still running\n\n"
            await asyncio.sleep(0.25)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


DRUG_FIELDS = ("job_id", "status", "drug_id", "disease_id", "events", "attempts", "best",
               "parent", "pocket", "random_pass_rate", "error", "cached")
DISEASE_FIELDS = ("job_id", "status", "disease_id", "disease_name", "tracks", "events",
                  "random_pass_rate", "error", "cached")


def _public(job: dict[str, Any]) -> dict[str, Any]:
    """The job as the client sees it. The internals (cache key, clock) stay here."""
    fields = DISEASE_FIELDS if job.get("kind") == "disease" else DRUG_FIELDS
    return {k: job[k] for k in fields if k in job}


# ── the context handed to the model ──────────────────────────────────────────

def _brief_drug(row: dict[str, Any], smiles: str | None, extra: str = "") -> str:
    name = (row.get("drug_name") or row["drug_id"]).title()
    genes = ", ".join(row.get("top_gene_symbols") or []) or "no direct target on these paths"
    return (f"- {name} (score {row['score']}, {row['readiness'].lower().replace('_', ' ')}): "
            f"targets {genes}.{extra} SMILES: {smiles or 'unknown'}")


def build_context(drug_id: str, disease_id: str, pool: str = "all",
                  result: dict[str, Any] | None = None) -> dict[str, Any]:
    """Everything known about this drug, this disease and the field around them.

    `pool` decides which ranked lists the model is allowed to learn from, which
    is the only difference between the three tracks of a disease run: `approved`
    shows only drugs already approved, `investigational` only compounds that
    never got there, `all` shows both. Pass `result` to reuse a ranking that has
    already been computed instead of scoring the disease again.
    """
    from api.main import scorer

    s = scorer()
    smiles_of = dict(zip(s.drugs["drug_id"].to_list(), s.drugs["smiles"].to_list()))
    name_of = dict(zip(s.drugs["drug_id"].to_list(), s.drugs["name"].to_list()))

    if result is None:
        result = s.candidates(disease_id, limit=10)
    disease = result["disease"]
    paths = s.paths(drug_id, disease_id)

    parent_smiles = smiles_of.get(drug_id)
    parent_name = (name_of.get(drug_id) or drug_id).title()
    if not parent_smiles:
        raise HTTPException(422, f"No structure on record for {parent_name}, so there is "
                                 "nothing to design from.")

    row = next((c for c in result["approved"] + result["investigational"]
                if c["drug_id"] == drug_id), None)

    targets = [{"symbol": n["label"], "uniprot": n.get("uniprot_id"), "gene_id": n["id"]}
               for n in paths["nodes"] if n["type"] == "gene"]
    direct = {e["target"] if e["source"] == drug_id else e["source"]
              for e in paths["edges"] if drug_id in (e["source"], e["target"])}
    own_targets = [t for t, n in ((t, n) for t in targets
                                  for n in paths["nodes"] if n["label"] == t["symbol"])
                   if n["id"] in direct]

    lines = [
        f"DISEASE: {disease['name']} ({disease['disease_id']}), "
        f"{disease['n_genes']} genes associated with it.",
        "",
        f"STARTING DRUG: {parent_name} ({drug_id})",
        f"  SMILES: {parent_smiles}",
    ]
    if row:
        lines += [
            f"  Graph score {row['score']} of 100, ranked #{row['rank']} among "
            f"{'approved' if row['approved'] else 'not-approved'} drugs.",
            f"  Status: {row['readiness'].lower().replace('_', ' ')}"
            + (f", approved {row['year_approved']}" if row.get("year_approved") else "")
            + (", carries a black box warning" if row.get("black_box") else "") + ".",
        ]
    lines.append("  Proteins it acts on directly: "
                 + (", ".join(f"{t['symbol']} (UniProt {t['uniprot']})" for t in own_targets)
                    if own_targets else "none recorded on these paths"))
    lines.append("")
    lines.append("WHY THE GRAPH RANKED IT:")
    # A protein_homolog path carries weight 0 in the score (see DEFAULT_WEIGHTS in
    # api/scoring.py, which explains why it is still computed). It is supporting
    # context, so it is marked as that rather than offered to the model as a
    # reason for the rank -- the model quotes these lines back in its rationales,
    # and at the sequence cutoff the artifact is built with, the weakest of them
    # are a reason to look rather than a reason to believe.
    shown = paths["paths"][:6]
    lines += [f"  - {p['explanation']}."
              + (" (sequence similarity only: supporting context, not part of the score)"
                 if p["type"] == "protein_homolog" else "")
              for p in shown] or ["  - no paths recorded"]

    approved = [c for c in result["approved"][:10] if c["drug_id"] != drug_id]
    investigational = [c for c in result["investigational"][:10] if c["drug_id"] != drug_id]
    if pool == "approved":
        investigational = []
    elif pool == "investigational":
        approved = []

    if pool != "investigational":
        lines += ["", "APPROVED DRUGS RANKED FOR THE SAME DISEASE (what already works here):"]
        lines += [_brief_drug(c, smiles_of.get(c["drug_id"])) for c in approved] or ["  none"]

    if pool != "approved":
        lines += ["", "NOT-APPROVED COMPOUNDS RANKED FOR THE SAME DISEASE "
                      "(chemistry already explored here, and how far it got):"]
        lines += [_brief_drug(c, smiles_of.get(c["drug_id"]),
                              f" Reached phase {c['max_phase']}."
                              if c.get("max_phase") is not None else "")
                  for c in investigational] or ["  none"]

    if pool == "approved":
        lines += ["", "You are being shown approved drugs only. Build on chemistry that has "
                      "already cleared safety in people."]
    elif pool == "investigational":
        lines += ["", "You are being shown compounds that never reached approval. Build on "
                      "chemistry others explored and dropped, and aim at the weakness that "
                      "plausibly stopped them."]

    return {
        "text": "\n".join(lines),
        "parent_smiles": parent_smiles,
        "parent_name": parent_name,
        "disease_name": disease["name"],
        "targets": own_targets,
        # What the model was actually shown, which is what the track studied.
        "n_approved": len(approved),
        "n_investigational": len(investigational),
    }


# ── the run ──────────────────────────────────────────────────────────────────

async def _load_pocket(
    drug_id: str, targets: list[dict[str, Any]], drug_smiles: str
) -> tuple[pocket_mod.Pocket | None, str | None, dict[str, Any] | None]:
    """The crystal structure of this drug inside one of its targets, if one exists.

    Returns the pocket, the reason there is none, and the target it was found in,
    so the viewer can mark which protein actually carries a measured pose.

    Only a BOUND plan carries a measured position. A predicted protein tells us
    the shape of the protein but nothing about where the drug goes, so there is
    nothing to place against and the check reports that rather than guessing.
    """
    from api.structures import build_structure_plan, fetch_structure_file

    tried = []
    for target in targets:
        gene_id = target.get("gene_id")
        if not gene_id:
            continue
        try:
            plan = await build_structure_plan(drug_id, gene_id)
        except Exception as exc:  # a structure lookup must not end the run
            log.info("structure lookup failed for %s/%s: %s", drug_id, gene_id, exc)
            continue
        if plan.mode != "BOUND" or not plan.protein or not plan.ligand_comp_id:
            tried.append(f"{target['symbol']} has no structure with the drug bound")
            continue
        try:
            raw, _ = await fetch_structure_file("rcsb", plan.protein.id)
            found = await asyncio.to_thread(
                pocket_mod.read_pocket, raw.decode("utf-8", "replace"), plan.ligand_comp_id,
                drug_smiles, plan.protein.id, plan.resolution_A)
            return found, None, target
        except Exception as exc:
            log.info("could not read pocket %s: %s", plan.protein.id, exc)
            tried.append(f"{plan.protein.id} could not be read")
    note = ("No experimental structure of this drug inside a target protein"
            + (f" ({'; '.join(tried)})" if tried else "")
            + ", so nothing here tests whether a molecule fits the target.")
    return None, note, None


def pocket_lines(pocket: pocket_mod.Pocket | None, note: str | None,
                 parent_name: str) -> tuple[str, str]:
    """What to tell the reader about the pocket, and what to tell the model.

    Both the per-drug run and every track of a disease run say this, and the
    wording matters: it is where the product admits that a placement is not a
    docking. One copy, so the two cannot drift apart.
    """
    if pocket is None:
        return note or "", ""
    shown = (f"Found {parent_name} inside its target in {pocket.pdb_id}"
             + (f" at {pocket.resolution_A} A" if pocket.resolution_A else "")
             + ". Every molecule will be placed there to see whether it fits.")
    told = (f"\n\nA crystal structure ({pocket.pdb_id}) records exactly where {parent_name} sits "
            "inside its target. Every molecule you propose will be laid onto that position by its "
            "shared core, and any atom that ends up inside the protein counts against it. Keep "
            "the core that binds, and grow into open space rather than into the protein.")
    return shown, told


async def _propose(job: dict[str, Any], prompt: str, track: str | None = None) -> dict[str, Any]:
    """One model call, streamed so the page has something to show while it thinks."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=config.GEMINI_API_KEY)
    stream = await client.aio.models.generate_content_stream(
        model=config.GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            response_mime_type="application/json",
            response_schema=PROPOSAL_SCHEMA,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            temperature=0.75,  # this is a search for ideas, not a summary
        ),
    )
    raw = ""
    shown = 0
    async for chunk in stream:
        piece = chunk.text or ""
        if not piece:
            continue
        raw += piece
        # Emit the reasoning as it arrives, but only every so often: one event per
        # chunk would bury the record in fragments and bloat the saved run.
        partial = _partial_reasoning(raw)
        if partial and len(partial) - shown >= 40:
            shown = len(partial)
            _emit(job, "thinking", track=track, text=partial)

    raw = raw.strip()
    if not raw:
        raise RuntimeError(
            f"{config.GEMINI_MODEL} returned nothing. It may have spent the whole "
            f"{MAX_OUTPUT_TOKENS}-token budget thinking; raise MAX_OUTPUT_TOKENS in api/design.py.")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw, re.S)
        if not match:
            raise RuntimeError(f"{config.GEMINI_MODEL} did not return JSON: {raw[:200]!r}")
        return json.loads(match.group(0))


def _rank_key(attempt: dict[str, Any]) -> tuple:
    """Best first.

    Fitting the pocket comes before everything else. It is the only check that
    knows which protein the molecule is aimed at, and ranking on drug-likeness
    alone put a molecule with six atoms inside the protein at the top.
    """
    check = attempt["check"]
    rank = {"pass": 0, "warn": 1, "fail": 2}[check["status"]]
    fit = next((c for c in check["checks"] if c["id"] == "pocket"), None)
    fit_rank = {"pass": 0, "warn": 1, "fail": 2}.get(fit["status"], 1) if fit else 1
    props = check.get("properties", {})
    return (fit_rank, rank, -(props.get("qed") or 0), props.get("sa_score") or 10)


async def _run(job_id: str) -> None:
    job = _jobs[job_id]
    try:
        _emit(job, "phase", text="Reading the chemistry database")
        await asyncio.to_thread(chemcheck.warm)

        context = await asyncio.to_thread(build_context, job["drug_id"], job["disease_id"])
        # Score the starting drug on the same checks. Without it there is nothing to
        # judge a design against, and "passes every check" sounds like an achievement
        # when the approved drug it came from passes them too.
        baseline = await asyncio.to_thread(
            chemcheck.evaluate, context["parent_smiles"], None, None, True)
        job["parent"] = {"name": context["parent_name"], "smiles": context["parent_smiles"],
                         "check": baseline}
        job["random_pass_rate"] = round(chemcheck.RANDOM_PASS_RATE, 3)
        _emit(job, "baseline", name=context["parent_name"], check=baseline,
              text=f"{context['parent_name']} itself: {baseline['summary'].lower()}")
        _emit(job, "context",
              text=f"Studied {context['parent_name']}, {context['n_approved']} approved and "
                   f"{context['n_investigational']} not-approved drugs for {context['disease_name']}, "
                   f"and {len(context['targets'])} target protein(s)",
              parent=job["parent"],
              targets=[t["symbol"] for t in context["targets"]])

        pocket, pocket_note, _ = await _load_pocket(
            job["drug_id"], context["targets"], context["parent_smiles"])
        job["pocket"] = ({"pdb_id": pocket.pdb_id, "resolution_A": pocket.resolution_A}
                         if pocket else None)
        shown, told = pocket_lines(pocket, pocket_note, context["parent_name"])
        _emit(job, "pocket", text=shown)
        context["text"] += told

        await run_rounds(job, context, pocket, pocket_note, attempts=job["attempts"])

        ranked = sorted(job["attempts"], key=_rank_key)
        job["best"] = ranked[0] if ranked else None
        job["attempts"] = ranked
        if job["best"]:
            _emit(job, "best", id=job["best"]["id"], name=job["best"]["name"],
                  status=job["best"]["check"]["status"])
        job["status"] = "done"
        _emit(job, "done", tried=len(job["attempts"]),
              accepted=sum(1 for a in job["attempts"] if a["check"]["status"] == "pass"))
        cache.put(SOURCE, job["key"], _public(job))

    except Exception as exc:  # noqa: BLE001 - the job must report, never vanish
        log.exception("design job failed")
        job["status"] = "error"
        job["error"] = str(exc)
        _emit(job, "error", text=str(exc))


async def run_rounds(job: dict[str, Any], context: dict[str, Any],
                     pocket: pocket_mod.Pocket | None, pocket_note: str | None, *,
                     attempts: list[dict[str, Any]], track: str | None = None,
                     id_prefix: str = "") -> list[dict[str, Any]]:
    """The design loop itself: propose, judge with RDKit, feed the failures back in.

    Shared by the per-drug run and by each track of a disease run, so the three
    rules in the module docstring are enforced in one place rather than three.
    Every attempt is appended to `attempts`, rejected ones included.
    """
    history: list[str] = []
    seen: set[str] = set()

    for round_no in range(1, ROUNDS + 1):
        _emit(job, "round", track=track, n=round_no, of=ROUNDS)

        prompt = context["text"]
        if history:
            prompt += ("\n\nWHAT YOU ALREADY TRIED, and what the chemistry engine said.\n"
                       "Do not repeat any of these structures. Fix what it objected to:\n"
                       + "\n".join(history))
            prompt += (f"\n\nRound {round_no} of {ROUNDS}. Propose {PER_ROUND} improved molecules.")
        else:
            prompt += (f"\n\nRound 1 of {ROUNDS}. Study the drugs above, then propose "
                       f"{PER_ROUND} molecules designed from {context['parent_name']}.")

        try:
            parsed = await _propose(job, prompt, track=track)
        except Exception as exc:  # one bad round should not end the run
            log.warning("design round %d failed: %s", round_no, exc)
            _emit(job, "note", track=track,
                  text=f"Round {round_no} did not return usable molecules. Moving on.")
            history.append(f"- round {round_no} produced nothing usable")
            continue

        _emit(job, "reasoning", track=track, round=round_no, text=parsed.get("reasoning", ""))

        for proposal in parsed.get("molecules", [])[:PER_ROUND]:
            smiles = (proposal.get("smiles") or "").strip()
            name = (proposal.get("name") or f"R{round_no}").strip()
            if not smiles:
                continue
            attempt_id = f"{id_prefix}{round_no}-{len(attempts)}"
            _emit(job, "molecule", track=track, id=attempt_id, round=round_no, name=name,
                  smiles=smiles, rationale=proposal.get("rationale", ""),
                  builds_on=proposal.get("builds_on", ""))

            if smiles in seen:
                # `problem` is not optional: chemcheck.feedback_line reads it from
                # every check that did not pass, to write the line the next round
                # reads. Without it this raised KeyError on the one thing the
                # branch exists to handle gracefully -- the model repeating itself,
                # which rule 4 of the prompt asks it not to do and it does anyway
                # -- and the exception escaped the round and killed the whole track.
                check = {"smiles": smiles, "valid": True, "status": "fail",
                         "summary": "Already proposed in an earlier round.",
                         "checks": [{"id": "repeat", "label": "A new attempt", "status": "fail",
                                     "value": "repeat",
                                     "problem": "repeats a structure already tried",
                                     "detail": "This exact structure was "
                                               "already tried this run."}],
                         "properties": {}}
            else:
                seen.add(smiles)
                check = await asyncio.to_thread(
                    chemcheck.evaluate, smiles, context["parent_smiles"], context["parent_name"])
                if check["valid"]:
                    # Only judged against the pocket when there is a pocket. With no
                    # measured position there is nothing to place anything into, and
                    # recording that as a warning against each molecule said "could
                    # not be placed" about a placement that was never attempted --
                    # which also made every molecule warn, so a run on a drug with no
                    # co-crystal accepted none of its 36 attempts while the page
                    # explained that 81.5% of random molecules pass. The absence is
                    # said once per track in the `pocket` event and again in the case
                    # against; it is not a fact about any one molecule.
                    if pocket:
                        fit, note = None, None
                        try:
                            fit = await asyncio.to_thread(pocket_mod.place, smiles, pocket)
                        except Exception as exc:
                            note = str(exc)
                        check["checks"].append(pocket_mod.as_check(fit, note))
                        if fit:
                            check["properties"]["pocket"] = {
                                k: fit[k] for k in
                                ("pdb_id", "clashes", "atoms", "rmsd", "core_atoms", "closest_A")}
                            check["pose_sdf"] = fit["sdf"]
                    # The worst check still decides, now that fit may be one of
                    # them, and the sentence comes from the same place as before
                    # it was one. Rewriting it here is what let the two copies
                    # drift into claiming a target test that never happened.
                    check["status"], check["summary"] = chemcheck.summarise(check["checks"])

            attempt = {"id": attempt_id, "round": round_no, "name": name,
                       "rationale": proposal.get("rationale", ""),
                       "builds_on": proposal.get("builds_on", ""), "check": check}
            if track:
                attempt["track"] = track
            attempts.append(attempt)
            _emit(job, "verdict", track=track, id=attempt_id, status=check["status"],
                  summary=check["summary"], check=check)
            history.append(chemcheck.feedback_line(name, check))

        passed = [a for a in attempts if a["check"]["status"] == "pass"]
        if passed and round_no < ROUNDS:
            _emit(job, "note", track=track,
                  text=f"{len(passed)} molecule(s) pass every check so far. "
                       "Refining to see if they can be improved.")

    return attempts
