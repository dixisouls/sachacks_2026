"""Rediscovery test: hide known treatments, see whether we find them again.

    python scripts/rediscovery.py --sample 300        # quick check
    python scripts/rediscovery.py                     # full run, writes artifacts/eval.json

Method
  1. Positive set = approved INDICATION edges where the drug is approved and not withdrawn.
  2. Hide a random 20 percent of them.
  3. Rebuild the scorer from the remaining 80 percent (Scorer(hide=...)).
  4. For each hidden pair, rank the drug among all approved candidates for that disease.
  5. Report Hits@10, Hits@50, MRR and median rank, against baselines.

Pairs where the drug stays excluded on training data alone (it is approved for a
parent or child of the hidden disease) are reported separately as not recoverable:
the product never shows those drugs, so scoring them would flatter the result.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.scoring import DEFAULT_WEIGHTS, Scorer  # noqa: E402

ART = Path(__file__).resolve().parents[1] / "artifacts"


def positives(scorer: Scorer) -> pl.DataFrame:
    """Approved indications whose drug is itself approved and not withdrawn."""
    ok = scorer.drugs.filter(pl.col("is_approved") & ~pl.col("withdrawn")).select("drug_id")
    return (scorer.drug_disease
            .filter((pl.col("relation") == "INDICATION") & (pl.col("status") == "approved"))
            .select("drug_id", "disease_id")
            .unique()
            .join(ok, on="drug_id", how="inner")
            .sort("drug_id", "disease_id"))


def rank_in_column(scorer: Scorer, j: int, score: np.ndarray, targets: list[int],
                   eligible_base: np.ndarray) -> dict[int, int | None]:
    """Rank each target drug among the approved candidates for disease j.

    Returns {drug idx: 1-based rank} or None when the drug scores zero (unreachable)
    or is excluded by training data (not recoverable).
    """
    fam = scorer.family(j)
    excluded = np.zeros(len(score), dtype=bool)
    if fam.approved:
        excluded[list(fam.approved)] = True

    eligible = eligible_base & ~excluded & (score > 0)
    idx = np.flatnonzero(eligible)
    order = idx[np.argsort(-score[idx], kind="stable")]
    position = {int(d): i + 1 for i, d in enumerate(order)}

    out: dict[int, int | None] = {}
    for d in targets:
        if excluded[d]:
            out[d] = "excluded"
        else:
            out[d] = position.get(d)  # None when score == 0
    return out


def evaluate(scorer: Scorer, hidden: pl.DataFrame, score_fn, label: str,
             verbose: bool = True) -> dict:
    """score_fn(scorer, j) -> score vector over drugs."""
    eligible_base = scorer.is_approved & ~scorer.withdrawn

    by_disease: dict[int, list[int]] = defaultdict(list)
    for drug_id, dis_id in hidden.select("drug_id", "disease_id").iter_rows():
        d, j = scorer.drug_idx.get(drug_id), scorer.disease_idx.get(dis_id)
        if d is not None and j is not None:
            by_disease[j].append(d)

    ranks: list[int] = []
    unreachable = excluded = 0
    t0 = time.time()
    for n, (j, targets) in enumerate(by_disease.items(), 1):
        score = score_fn(scorer, j)
        for d, r in rank_in_column(scorer, j, score, targets, eligible_base).items():
            if r == "excluded":
                excluded += 1
            elif r is None:
                unreachable += 1
            else:
                ranks.append(r)
        if verbose and n % 100 == 0:
            print(f"    {label}: {n}/{len(by_disease)} diseases, {time.time() - t0:.0f}s",
                  flush=True)

    arr = np.array(ranks, dtype=float)
    scored = len(arr) + unreachable  # pairs the product could in principle surface
    if scored == 0:
        return {"label": label, "scored_pairs": 0}
    return {
        "label": label,
        "scored_pairs": scored,
        "not_recoverable": excluded,
        "unreachable": unreachable,
        "hits@10": round(float((arr <= 10).sum()) / scored, 4),
        "hits@50": round(float((arr <= 50).sum()) / scored, 4),
        "hits@100": round(float((arr <= 100).sum()) / scored, 4),
        "mrr": round(float((1.0 / arr).sum()) / scored, 4),
        "median_rank": int(np.median(arr)) if len(arr) else None,
        "seconds": round(time.time() - t0, 1),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, help="evaluate only this many hidden pairs")
    ap.add_argument("--holdout", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    print("loading full scorer...")
    full = Scorer()
    pos = positives(full)
    print(f"positive set: {pos.height} approved indications "
          f"({pos['drug_id'].n_unique()} drugs, {pos['disease_id'].n_unique()} diseases)")

    rng = np.random.default_rng(args.seed)
    mask = rng.random(pos.height) < args.holdout
    hidden = pos.filter(mask)
    print(f"hiding {hidden.height} pairs ({args.holdout:.0%}), "
          f"{pos.height - hidden.height} kept for training")

    hide = set(zip(hidden["drug_id"].to_list(), hidden["disease_id"].to_list()))
    print("rebuilding scorer without them...")
    held = Scorer(hide=hide)

    eval_set = hidden
    if args.sample and args.sample < hidden.height:
        eval_set = hidden.sample(args.sample, seed=args.seed)
        print(f"evaluating a sample of {eval_set.height}")

    result = evaluate(held, eval_set, lambda s, j: s.score_column(j)["total"], "repurposekg")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
