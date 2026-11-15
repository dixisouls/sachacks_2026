"""Command line check of the scoring core.

    python scripts/query.py "multiple sclerosis"
    python scripts/query.py "multiple sclerosis" --pick 2 --top 15
    python scripts/query.py --id MONDO_0005301
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.scoring import Scorer  # noqa: E402
from api.search import DiseaseSearch  # noqa: E402


LEAD = {"shared_biology": "gene", "sibling_disease": "sibling", "chemical_analog": "chem",
        "protein_homolog": "homolog", None: "-"}


def show(title: str, rows: list[dict]) -> None:
    print(f"\n{title}")
    print(f"  {'#':>3}  {'drug':30} {'score':>5}  {'readiness':18} {'via':>8}  top genes")
    for r in rows:
        via = LEAD.get(r["lead_path"], "-")
        if r["inferred_only"]:
            via += "*"
        print(f"  {r['rank']:>3}  {(r['drug_name'] or r['drug_id'])[:30]:30} {r['score']:>5}  "
              f"{r['readiness']:18} {via:>8}  {', '.join(r['top_gene_symbols'])}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="?")
    ap.add_argument("--id", help="disease id, skips search")
    ap.add_argument("--pick", type=int, default=0, help="which search match to use")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--explain", metavar="DRUG_ID", help="print the paths for one drug")
    args = ap.parse_args()

    t0 = time.time()
    scorer = Scorer()
    print(f"loaded in {time.time() - t0:.1f}s")

    disease_id = args.id
    if not disease_id:
        matches = DiseaseSearch(scorer.diseases).search(args.query or "multiple sclerosis")
        if not matches:
            raise SystemExit("no disease matches")
        for i, m in enumerate(matches):
            print(f"  [{i}] {m['name']} ({m['disease_id']}) {m['match_type']}, {m['n_genes']} genes")
        disease_id = matches[args.pick]["disease_id"]

    t1 = time.time()
    res = scorer.candidates(disease_id, limit=args.top)
    print(f"\n{res['disease']['name']} ({disease_id}), {res['disease']['n_genes']} genes, "
          f"family {res['family_size']}, {res['already_approved_total']} drugs already approved "
          f"({res['excluded_count']} of them scored and were excluded), "
          f"scored in {(time.time() - t1) * 1000:.0f} ms")
    if res["warning"]:
        print("WARNING:", res["warning"])
    layers = ", ".join(k for k, on in res["layers"].items() if on) or "none"
    print(f"extra layers: {layers}   (* = inferred only, no direct graph path)")
    show("APPROVED DRUGS", res["approved"])
    show("NOT APPROVED (investigational / withdrawn)", res["investigational"])

    if args.explain:
        p = scorer.paths(args.explain, disease_id)
        print(f"\nPATHS for {args.explain}")
        for path in p["paths"]:
            flag = "inferred" if path["inferred"] else "graph   "
            print(f"  [{flag}] {path['type']}: {path['explanation']}")


if __name__ == "__main__":
    main()
