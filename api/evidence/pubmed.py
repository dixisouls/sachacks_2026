"""PubMed E-utilities: papers mentioning this drug and this disease together.

Two calls: esearch for the PMIDs, esummary for titles. The hit count matters as
much as the papers; zero papers is itself a finding worth putting in the brief,
and the brief is allowed to cite the search itself for that claim.

NCBI allows 3 requests/second without a key, 10 with NCBI_API_KEY.
"""

from __future__ import annotations

import os

import httpx

from api import cache

BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
SOURCE = "pubmed"
MAX_PAPERS = 8


def _params(extra: dict) -> dict:
    params = {"db": "pubmed", "retmode": "json", "tool": "repurposekg", **extra}
    if os.environ.get("NCBI_API_KEY"):
        params["api_key"] = os.environ["NCBI_API_KEY"]
    return params


def fetch_pubmed(drug_name: str, disease_name: str):
    key = f"{drug_name.lower()}|{disease_name.lower()}"
    term = f'"{drug_name}"[tiab] AND "{disease_name}"[tiab]'

    async def run(client: httpx.AsyncClient) -> dict:
        cached = cache.get(SOURCE, key)
        if cached is not None:
            return cached

        search = await client.get(f"{BASE}/esearch.fcgi",
                                  params=_params({"term": term, "retmax": MAX_PAPERS}))
        search.raise_for_status()
        result = search.json().get("esearchresult", {})
        pmids = result.get("idlist", [])
        total = int(result.get("count", 0))

        items = []
        if pmids:
            summary = await client.get(f"{BASE}/esummary.fcgi",
                                       params=_params({"id": ",".join(pmids)}))
            summary.raise_for_status()
            records = summary.json().get("result", {})
            for pmid in records.get("uids", []):
                record = records.get(pmid, {})
                items.append({
                    "id": f"PMID:{pmid}",
                    "source": SOURCE,
                    "title": record.get("title") or f"PMID {pmid}",
                    "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                    "snippet": " · ".join(filter(None, [record.get("source"),
                                                        record.get("pubdate")])) or None,
                    "data": {"journal": record.get("source"), "pubdate": record.get("pubdate")},
                })

        payload = {
            "items": items,
            "total": total,
            "query": term,
            # A zero result is a real finding, so give the brief something citable.
            "note": None if items else
                    f"PubMed has no paper with both {drug_name} and {disease_name} "
                    f"in the title or abstract",
        }
        cache.put(SOURCE, key, payload)
        return payload

    return run
