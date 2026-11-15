"""Disease search: exact name > exact synonym > name prefix > name substring > synonym substring.
Ties go to diseases with more gene associations (better graph coverage)."""

from __future__ import annotations

import polars as pl

RANK = {"exact": 0, "synonym": 1, "prefix": 2, "substring": 3, "synonym_substring": 4}


class DiseaseSearch:
    def __init__(self, diseases: pl.DataFrame):
        self.rows = [
            (r["disease_id"], r["name"] or "", (r["name"] or "").lower(),
             [s.lower() for s in (r["synonyms"] or [])], r["n_genes"], r["therapeutic_areas"] or [])
            for r in diseases.iter_rows(named=True)
        ]

    def search(self, q: str, limit: int = 10) -> list[dict]:
        q = q.strip().lower()
        if len(q) < 2:
            return []
        hits = []
        for did, name, lname, syns, n_genes, areas in self.rows:
            if lname == q:
                t = "exact"
            elif q in syns:
                t = "synonym"
            elif lname.startswith(q):
                t = "prefix"
            elif q in lname:
                t = "substring"
            elif any(q in s for s in syns):
                t = "synonym_substring"
            else:
                continue
            hits.append((RANK[t], -n_genes, len(name), did, name, t, n_genes, areas))
        hits.sort()
        return [{"disease_id": h[3], "name": h[4], "match_type": h[5], "n_genes": h[6],
                 "therapeutic_areas": h[7]} for h in hits[:limit]]
