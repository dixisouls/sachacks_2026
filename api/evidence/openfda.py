"""openFDA FAERS: the adverse events most reported for this drug.

This feeds the "evidence against" half of the brief. These are spontaneous
reports, not incidence rates, so the brief must never phrase them as risk --
only as what is most frequently reported.
"""

from __future__ import annotations

import os

import httpx

from api import cache

URL = "https://api.fda.gov/drug/event.json"
SOURCE = "openfda"
TOP_N = 10


def fetch_adverse_events(drug_name: str, synonyms: list[str]):
    key = drug_name.lower()

    async def query(client: httpx.AsyncClient, name: str) -> list[dict]:
        params = {
            "search": f'patient.drug.openfda.generic_name:"{name}"',
            "count": "patient.reaction.reactionmeddrapt.exact",
            "limit": TOP_N,
        }
        if os.environ.get("OPENFDA_API_KEY"):
            params["api_key"] = os.environ["OPENFDA_API_KEY"]
        response = await client.get(URL, params=params)
        if response.status_code == 404:  # openFDA's "no matches"
            return []
        response.raise_for_status()
        return response.json().get("results", [])

    async def run(client: httpx.AsyncClient) -> dict:
        cached = cache.get(SOURCE, key)
        if cached is not None:
            return cached

        results = await query(client, drug_name)
        used = drug_name
        for alt in synonyms[:3]:  # generic name may differ from the graph's label
            if results:
                break
            results = await query(client, alt)
            used = alt

        if not results:
            payload = {"items": [],
                       "note": f"openFDA has no adverse event reports filed under {drug_name}"}
            cache.put(SOURCE, key, payload)
            return payload

        reactions = [{"term": r["term"].lower(), "count": r["count"]} for r in results]
        top = ", ".join(f"{r['term']} ({r['count']:,})" for r in reactions[:5])

        # A synonym can be a related but distinct drug (arbaclofen is not baclofen),
        # so say plainly whose reports these are. The brief must not silently
        # attribute one drug's safety record to another.
        substituted = used.lower() != drug_name.lower()
        title = f"Most reported adverse events for {used}"
        if substituted:
            title += f" (reported under {used}, not {drug_name})"

        payload = {
            "items": [{
                "id": f"FAERS:{used.lower()}",
                "source": SOURCE,
                "title": title,
                "url": "https://open.fda.gov/data/faers/",
                "snippet": top,
                "data": {"queried_as": used, "requested": drug_name,
                         "is_substitute_name": substituted, "reactions": reactions},
            }],
            "note": (f"No openFDA reports under {drug_name}; showing reports filed "
                     f"under {used} instead") if substituted else None,
        }
        cache.put(SOURCE, key, payload)
        return payload

    return run
