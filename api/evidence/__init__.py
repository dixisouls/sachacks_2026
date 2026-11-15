"""Evidence gathering: a deterministic fetcher, not an agent loop.

All sources run concurrently. Each has its own timeout and its own failure
handling, so one slow API never takes down a brief: a source that fails returns
no items plus a note saying so, and the brief is written from what did arrive.

Every item carries an `id` that the brief must cite and the UI can turn into a
link. The LLM is only ever shown these items, never the open internet.
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from api.evidence.chembl import fetch_chembl
from api.evidence.clinicaltrials import fetch_trials
from api.evidence.openfda import fetch_adverse_events
from api.evidence.pubmed import fetch_pubmed

log = logging.getLogger("repurposekg.evidence")

SOURCE_TIMEOUT = 6.0
USER_AGENT = "repurposekg-hackathon"


async def gather_evidence(drug_name: str, disease_name: str, drug_id: str,
                          synonyms: list[str] | None = None) -> dict:
    """Returns {"items": [...], "notes": [...], "by_source": {...}}."""
    started = time.perf_counter()
    sources = {
        "clinicaltrials": fetch_trials(drug_name, disease_name),
        "pubmed": fetch_pubmed(drug_name, disease_name),
        "openfda": fetch_adverse_events(drug_name, synonyms or []),
        "chembl": fetch_chembl(drug_id),
    }

    async with httpx.AsyncClient(
        timeout=SOURCE_TIMEOUT, headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
    ) as client:
        async def run(name: str, coro_factory):
            try:
                return name, await asyncio.wait_for(coro_factory(client), SOURCE_TIMEOUT)
            except asyncio.TimeoutError:
                log.warning("%s timed out after %.0fs", name, SOURCE_TIMEOUT)
                return name, {"items": [], "note": f"{name} did not respond in time"}
            except Exception as exc:
                log.warning("%s failed: %s: %s", name, type(exc).__name__, exc)
                return name, {"items": [], "note": f"{name} was unavailable"}

        results = await asyncio.gather(*(run(n, f) for n, f in sources.items()))

    items, notes, by_source = [], [], {}
    for name, result in results:
        found = result.get("items", [])
        items.extend(found)
        by_source[name] = len(found)
        if result.get("note"):
            notes.append(result["note"])

    log.info("evidence for %s / %s: %s in %.0fms", drug_name, disease_name,
             by_source, (time.perf_counter() - started) * 1000)
    return {"items": items, "notes": notes, "by_source": by_source}
