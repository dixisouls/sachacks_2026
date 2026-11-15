#!/usr/bin/env python3
"""Measure what passing the design filters is actually worth.

The checks in api/chemcheck.py ask whether something is a plausible small
molecule. They cannot ask whether it suits a particular protein, so a molecule
clearing them has cleared a bar that most molecules clear. This script puts
that number on it, by running the same checks over molecules drawn at random
from the drug table: molecules with no connection to whatever disease the
design feature was aimed at.

    python scripts/filter_baseline.py            # the 60-molecule default
    python scripts/filter_baseline.py -n 500     # tighter, slower

Feed the result back into RANDOM_PASS_RATE in api/chemcheck.py.
"""

from __future__ import annotations

import argparse
import random
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import polars as pl  # noqa: E402

from api import chemcheck  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-n", "--sample", type=int, default=60, help="molecules to draw")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    chemcheck.warm()
    frame = (pl.read_parquet(ROOT / "artifacts" / "drugs.parquet",
                             columns=["name", "smiles", "is_approved"])
             .filter(pl.col("smiles").is_not_null()))
    random.seed(args.seed)
    rows = random.sample(frame.rows(named=True), min(args.sample, frame.height))

    passed = 0
    reasons: Counter[str] = Counter()
    for row in rows:
        result = chemcheck.evaluate(row["smiles"])
        # Novelty is excluded: every one of these is a known drug by construction,
        # which says nothing about whether the other checks discriminate.
        blocking = [c for c in result["checks"] if c["status"] == "fail" and c["id"] != "novel"]
        if blocking:
            reasons.update(c["problem"] for c in blocking)
        else:
            passed += 1

    rate = passed / len(rows)
    print(f"{passed} of {len(rows)} random molecules pass every check: {rate:.0%}")
    print("\nWhy the rest failed:")
    for problem, count in reasons.most_common():
        print(f"  {count:4}  {problem}")
    print(f"\nSet RANDOM_PASS_RATE = {passed} / {len(rows)} in api/chemcheck.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
