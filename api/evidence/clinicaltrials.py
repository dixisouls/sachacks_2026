"""ClinicalTrials.gov v2: is anyone already testing this drug for this disease?

This is the single most useful live check. A hit means the hypothesis is already
being pursued, which is worth knowing before a researcher spends time on it.
"""

from __future__ import annotations

import httpx

from api import cache

URL = "https://clinicaltrials.gov/api/v2/studies"
SOURCE = "clinicaltrials"


def _item(study: dict) -> dict | None:
    protocol = study.get("protocolSection", {})
    ident = protocol.get("identificationModule", {})
    status = protocol.get("statusModule", {})
    design = protocol.get("designModule", {})

    nct = ident.get("nctId")
    if not nct:
        return None
    phases = design.get("phases") or []
    return {
        "id": nct,
        "source": SOURCE,
        "title": ident.get("briefTitle") or nct,
        "url": f"https://clinicaltrials.gov/study/{nct}",
        "snippet": " · ".join(filter(None, [
            status.get("overallStatus"),
            ", ".join(phases) if phases else None,
            (status.get("startDateStruct") or {}).get("date"),
        ])) or None,
        "data": {
            "status": status.get("overallStatus"),
            "phases": phases,
            "start_date": (status.get("startDateStruct") or {}).get("date"),
        },
    }


def fetch_trials(drug_name: str, disease_name: str):
    key = f"{drug_name.lower()}|{disease_name.lower()}"

    async def run(client: httpx.AsyncClient) -> dict:
        cached = cache.load(SOURCE, key)
        if cached is not None:
            return cached

        response = await client.get(URL, params={
            "query.cond": disease_name,
            "query.intr": drug_name,
            "pageSize": 20,
            "countTotal": "true",
        })
        response.raise_for_status()
        payload = response.json()

        studies = payload.get("studies", [])
        items = [i for i in (_item(s) for s in studies) if i]
        total = payload.get("totalCount", len(items))
        result = {
            "items": items,
            "note": None if items else
                    f"No registered trial found for {drug_name} in {disease_name}",
            "total": total,
        }
        cache.put(SOURCE, key, result)
        return result

    return run
