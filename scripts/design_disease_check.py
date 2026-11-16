"""Check the three-track plumbing against the real artifacts, without spending a model call.

    venv/bin/python scripts/design_disease_check.py MONDO_0010726

What it answers: does each pool find a seed it can design from, does each track
get a context built only from its own pool, and does the off-target lookup find
anything for that seed's targets. Everything here is local -- no model, no
network, no server -- so it is the cheapest way to find out that a disease will
produce a thin run before a reader does.

The design loop itself is not run. tests/test_design_disease.py covers that.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api import main as api_main  # noqa: E402
from api.design import build_context  # noqa: E402
from api.design_disease import POOLS, TRACKS, _pick_seed  # noqa: E402
from api.scoring import Scorer  # noqa: E402
from api.workup import homologs  # noqa: E402


def check(disease_id: str) -> int:
    print(f"loading artifacts from {Scorer.__module__}...")
    scorer = Scorer()
    api_main.state["scorer"] = scorer  # what build_context reaches for

    if disease_id not in scorer.disease_idx:
        print(f"no disease with id {disease_id!r}")
        return 2

    result = scorer.candidates(disease_id, limit=10)
    name = result["disease"]["name"]
    print(f"\n{name} ({disease_id}): {len(result['approved'])} approved, "
          f"{len(result['investigational'])} not approved\n")

    smiles_of = dict(zip(scorer.drugs["drug_id"].to_list(), scorer.drugs["smiles"].to_list()))
    problems = 0

    for pool in POOLS:
        print(f"── {pool}: {TRACKS[pool]['label']}")
        row = _pick_seed(result, pool, smiles_of)
        if row is None:
            print("   NO SEED. This track would report an error and the others would carry on.\n")
            problems += 1
            continue

        context = build_context(row["drug_id"], disease_id, pool, result)
        targets = context["targets"]
        print(f"   seed      {context['parent_name']} ({row['drug_id']}), score {row['score']}")
        print(f"   studied   {context['n_approved']} approved, "
              f"{context['n_investigational']} not approved")
        print(f"   prompt    {len(context['text'])} characters")
        print(f"   targets   {', '.join(t['symbol'] for t in targets) or 'none recorded'}")

        # The pool really did restrict what the model will see.
        if pool == "approved" and context["n_investigational"]:
            print("   WRONG: an approved-only track was shown not-approved compounds")
            problems += 1
        if pool == "investigational" and context["n_approved"]:
            print("   WRONG: an investigational-only track was shown approved drugs")
            problems += 1

        found = homologs([t.get("gene_id") for t in targets])
        if found:
            print("   homologs  " + ", ".join(
                f"{h['symbol']} {h['identity']:.0%} of {h['of_target']}" for h in found))
        else:
            print("   homologs  none in the sequence data, so the off-target section "
                  "would be left out")
        print()

    seeds = {pool: (_pick_seed(result, pool, smiles_of) or {}).get("drug_id") for pool in POOLS}
    distinct = len({s for s in seeds.values() if s})
    print(f"seeds: {seeds}")
    print(f"{distinct} distinct starting point(s) across three tracks.")
    if distinct == 1:
        print("The three tracks would start from the same drug and differ only in the "
              "prior art they were shown. That is a thin demo, not a bug.")
    print("problems:", problems)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(check(sys.argv[1] if len(sys.argv) > 1 else "MONDO_0010726"))
