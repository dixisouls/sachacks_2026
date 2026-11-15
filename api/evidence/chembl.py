"""ChEMBL: the drug's recorded mechanism of action.

The graph already says which gene a drug hits; this gives the sentence a
pharmacologist would write for it, from the same ChEMBL id the graph uses, so
no id mapping is needed.
"""

from __future__ import annotations

import httpx

from api import cache

URL = "https://www.ebi.ac.uk/chembl/api/data/mechanism.json"
SOURCE = "chembl"


def fetch_chembl(drug_id: str):
    key = drug_id

    async def run(client: httpx.AsyncClient) -> dict:
        cached = cache.load(SOURCE, key)
        if cached is not None:
            return cached

        response = await client.get(URL, params={"molecule_chembl_id": drug_id, "limit": 10})
        response.raise_for_status()
        mechanisms = response.json().get("mechanisms", [])

        items = []
        for m in mechanisms:
            description = m.get("mechanism_of_action")
            if not description:
                continue
            ref = m.get("mechanism_refs") or []
            items.append({
                "id": f"CHEMBL_MOA:{m.get('mec_id') or drug_id}",
                "source": SOURCE,
                "title": description,
                "url": f"https://www.ebi.ac.uk/chembl/compound_report_card/{drug_id}/",
                "snippet": " · ".join(filter(None, [m.get("action_type"),
                                                    m.get("target_chembl_id")])) or None,
                "data": {"action_type": m.get("action_type"),
                         "target": m.get("target_chembl_id"),
                         "references": [r.get("ref_url") for r in ref if r.get("ref_url")][:3]},
            })

        payload = {"items": items,
                   "note": None if items else f"ChEMBL lists no mechanism of action for {drug_id}"}
        cache.put(SOURCE, key, payload)
        return payload

    return run
