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


def methods_for(scorer: Scorer, seed: int) -> dict:
    """name -> f(parts, rng) -> score vector. `parts` are the four components
    for one disease, already computed, so every method shares one matrix pass."""
    popularity = np.asarray(scorer.I.sum(axis=1)).ravel().astype(float)  # training indications

    def w(**over):
        weights = {k: 0.0 for k in DEFAULT_WEIGHTS} | over
        return lambda parts, rng: sum(weights[k] * v for k, v in parts.items())

    return {
        # the shipped model and its ablations
        "repurposekg": w(**DEFAULT_WEIGHTS),
        "graph_only": w(shared_biology=1.0, sibling_disease=0.5),
        "path_a_only": w(shared_biology=1.0),
        "path_b_only": w(sibling_disease=1.0),
        "graph_plus_chem": w(shared_biology=1.0, sibling_disease=0.5, chemical_analog=0.4),
        "graph_plus_homolog": w(shared_biology=1.0, sibling_disease=0.5, protein_homolog=0.4),
        # baselines
        "popularity": lambda parts, rng: popularity,
        "random": lambda parts, rng: rng.random(len(popularity)),
    }


def tuning_grid() -> dict:
    """Weight combinations to sweep. shared_biology is the anchor and stays at 1.0."""
    out = {}
    for sib in (0.25, 0.5, 1.0, 1.5):
        for chem in (0.0, 0.2, 0.4, 0.8):
            for hom in (0.0, 0.1, 0.2, 0.4):
                weights = {"shared_biology": 1.0, "sibling_disease": sib,
                           "chemical_analog": chem, "protein_homolog": hom}
                name = f"sib{sib}_chem{chem}_hom{hom}"
                out[name] = (weights,
                             lambda parts, rng, w=weights: sum(w[k] * v for k, v in parts.items()))
    return out


def evaluate(scorer: Scorer, hidden: pl.DataFrame, methods: dict, seed: int = 0,
             verbose: bool = True) -> dict:
    """Score every method on the same held-out pairs, one matrix pass per disease."""
    eligible_base = scorer.is_approved & ~scorer.withdrawn
    rng = np.random.default_rng(seed)

    by_disease: dict[int, list[int]] = defaultdict(list)
    for drug_id, dis_id in hidden.select("drug_id", "disease_id").iter_rows():
        d, j = scorer.drug_idx.get(drug_id), scorer.disease_idx.get(dis_id)
        if d is not None and j is not None:
            by_disease[j].append(d)

    ranks: dict[str, list[int]] = {m: [] for m in methods}
    unreachable: dict[str, int] = {m: 0 for m in methods}
    first = next(iter(methods))
    excluded = 0
    t0 = time.time()

    for n, (j, targets) in enumerate(by_disease.items(), 1):
        parts = scorer.score_column(j)["parts"]
        for name, fn in methods.items():
            score = fn(parts, rng)
            for d, r in rank_in_column(scorer, j, score, targets, eligible_base).items():
                if r == "excluded":
                    if name == first:
                        excluded += 1  # method-independent, count once
                elif r is None:
                    unreachable[name] += 1
                else:
                    ranks[name].append(r)
        if verbose and n % 100 == 0:
            print(f"    {n}/{len(by_disease)} diseases, {time.time() - t0:.0f}s", flush=True)

    out = {}
    for name in methods:
        arr = np.array(ranks[name], dtype=float)
        scored = len(arr) + unreachable[name]
        if scored == 0:
            out[name] = {"scored_pairs": 0}
            continue
        h10 = float((arr <= 10).sum()) / scored
        out[name] = {
            "scored_pairs": scored,
            "unreachable": unreachable[name],
            "hits@10": round(h10, 4),
            # 1 standard error on a proportion, so close results are not over-read
            "hits@10_se": round(float(np.sqrt(h10 * (1 - h10) / scored)), 4),
            "hits@50": round(float((arr <= 50).sum()) / scored, 4),
            "hits@100": round(float((arr <= 100).sum()) / scored, 4),
            "mrr": round(float((1.0 / arr).sum()) / scored, 4),
            "median_rank": int(np.median(arr)) if len(arr) else None,
        }
    return {"methods": out, "not_recoverable": excluded,
            "diseases": len(by_disease), "seconds": round(time.time() - t0, 1)}


def print_table(res: dict) -> None:
    rows = sorted(res["methods"].items(), key=lambda kv: -(kv[1].get("hits@10") or 0))
    print(f"\n  {'method':20} {'hits@10':>15} {'hits@50':>8} {'hits@100':>9} "
          f"{'MRR':>7} {'median':>7} {'unreach':>8}")
    for name, m in rows:
        if not m.get("scored_pairs"):
            print(f"  {name:20} {'no pairs':>15}")
            continue
        h = f"{m['hits@10']:.3f} +/-{m['hits@10_se']:.3f}"
        print(f"  {name:20} {h:>15} {m['hits@50']:>8.3f} {m['hits@100']:>9.3f} "
              f"{m['mrr']:>7.3f} {str(m['median_rank']):>7} {m['unreachable']:>8}")
    any_m = next(iter(res["methods"].values()))
    print(f"\n  {any_m.get('scored_pairs', 0)} pairs scored over "
          f"{res['diseases']} diseases, {res['not_recoverable']} not recoverable, "
          f"{res['seconds']}s")


def split(pos: pl.DataFrame, holdout: float, seed: int) -> tuple[pl.DataFrame, set]:
    rng = np.random.default_rng(seed)
    hidden = pos.filter(rng.random(pos.height) < holdout)
    return hidden, set(zip(hidden["drug_id"].to_list(), hidden["disease_id"].to_list()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, help="evaluate only this many hidden pairs")
    ap.add_argument("--holdout", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=42, help="tuning split")
    ap.add_argument("--report-seed", type=int, default=7,
                    help="a different split, so the headline number is not the tuned one")
    ap.add_argument("--tune", action="store_true", help="sweep the weight grid first")
    args = ap.parse_args()

    print("loading full scorer...")
    full = Scorer()
    pos = positives(full)
    print(f"positive set: {pos.height} approved indications "
          f"({pos['drug_id'].n_unique()} drugs, {pos['disease_id'].n_unique()} diseases)")

    def make_split(seed: int):
        hidden, hide = split(pos, args.holdout, seed)
        if args.sample and args.sample < hidden.height:
            hidden = hidden.sample(args.sample, seed=seed)
        return hidden, Scorer(hide=hide)

    best = dict(DEFAULT_WEIGHTS)
    tuning = None
    if args.tune:
        print(f"\nTUNING on seed {args.seed}")
        hidden, held = make_split(args.seed)
        print(f"  {hidden.height} held-out pairs")
        grid = tuning_grid()
        res = evaluate(held, hidden, {k: fn for k, (w, fn) in grid.items()}, seed=args.seed)
        # Selected on MRR, not hits@10. MRR uses the whole ranking, so it is far less
        # noisy than a threshold metric; on this grid the top hits@10 values sit well
        # inside one standard error of each other and picking on them is just overfitting.
        ranked = sorted(res["methods"].items(),
                        key=lambda kv: (-(kv[1].get("mrr") or 0), -(kv[1].get("hits@10") or 0)))
        print(f"  {'combination':26} {'MRR':>7} {'hits@10':>8} {'hits@50':>8}")
        for name, m in ranked[:8]:
            print(f"  {name:26} {m['mrr']:>7.3f} {m['hits@10']:>8.3f} {m['hits@50']:>8.3f}")
        best = grid[ranked[0][0]][0]
        tuning = {"split_seed": args.seed, "pairs": hidden.height, "grid_size": len(grid),
                  "best": best, "best_on_tuning_split": ranked[0][1]}
        print(f"  best: {best}")

    print(f"\nREPORT on seed {args.report_seed} (a different split)")
    hidden, held = make_split(args.report_seed)
    print(f"  {hidden.height} held-out pairs")
    methods = methods_for(held, args.report_seed)
    methods["repurposekg"] = lambda parts, rng, w=best: sum(w[k] * v for k, v in parts.items())
    result = evaluate(held, hidden, methods, seed=args.report_seed)
    print_table(result)

    out = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "holdout_fraction": args.holdout,
           "positive_set": {"pairs": pos.height, "drugs": pos["drug_id"].n_unique(),
                            "diseases": pos["disease_id"].n_unique()},
           "sample": args.sample, "weights": best, "tuning": tuning,
           "report_split_seed": args.report_seed, **result}
    (ART / "eval.json").write_text(json.dumps(out, indent=2))
    print(f"\nwrote {ART / 'eval.json'}")


if __name__ == "__main__":
    main()
