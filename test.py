"""
OptimusKG starter for the drug repurposing hackathon project.

Setup (once):
    pip install optimuskg scipy numpy

Run:
    python optimuskg_starter.py "multiple sclerosis"

First run downloads the graph from Harvard Dataverse into a local cache
(~/.cache/optimuskg on Linux, ~/Library/Caches/optimuskg on macOS).
Later runs read from the cache and are fast.
"""

import sys

import numpy as np
import optimuskg
import polars as pl
import scipy.sparse as sp

import requests

_orig_get = requests.get

def _get_with_ua(*args, **kwargs):
    headers = kwargs.setdefault("headers", {})
    headers.setdefault("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) optimuskg-hackathon")
    return _orig_get(*args, **kwargs)

requests.get = _get_with_ua

# ---------------------------------------------------------------------------
# Step 1: load the graph
# lcc=True keeps only the largest connected component, which drops isolated
# fragments that no path can ever reach. That is what you want for scoring.
# ---------------------------------------------------------------------------
nodes, edges = optimuskg.load_graph(lcc=True)

# nodes columns: id, label, properties (JSON string)
# edges columns: from, to, label, relation, undirected, properties (JSON string)
print("nodes:", nodes.shape, nodes.columns)
print("edges:", edges.shape, edges.columns)

# ---------------------------------------------------------------------------
# Step 2: look at what is in there. Run this first and read the output,
# because the exact label strings decide the filters below.
# ---------------------------------------------------------------------------
print(nodes.group_by("label").len().sort("len", descending=True))
print(edges.group_by(["label", "relation"]).len().sort("len", descending=True))

# Pull the human readable name out of the properties JSON.
# If this comes back null, print one row of nodes["properties"] and adjust the key.
nodes = nodes.with_columns(
    pl.col("properties").str.json_path_match("$.name").alias("name")
)

# ---------------------------------------------------------------------------
# Step 3: the drug to disease edges. These are your labels for the
# rediscovery test (INDICATION) and your safety signal (CONTRAINDICATION).
# ---------------------------------------------------------------------------
drug_disease = edges.filter(
    pl.col("relation").is_in(["INDICATION", "CONTRAINDICATION", "OFF_LABEL_USE"])
)
print(drug_disease.group_by("relation").len())

# Edge properties include highest_clinical_trial_phase, useful for readiness.
print(drug_disease.select("from", "to", "relation", "properties").head(5))

# ---------------------------------------------------------------------------
# Step 4: build sparse matrices for path scoring.
# Do NOT use optimuskg.load_networkx for this: 21M edges in NetworkX is slow
# and memory heavy. Sparse matrix products score every drug at once.
# ---------------------------------------------------------------------------
node_ids = nodes["id"].to_list()
idx = {nid: i for i, nid in enumerate(node_ids)}
N = len(node_ids)


def adjacency(edge_df: pl.DataFrame, damping: float = 0.5) -> sp.csr_matrix:
    """Symmetric, degree weighted adjacency for one edge type.

    Dividing by degree**damping means paths through hub nodes (genes linked
    to everything) count for less, so rarer and more specific paths score
    higher. This is the idea behind DWPC from the Hetionet work.
    """
    rows = np.array([idx[x] for x in edge_df["from"].to_list()])
    cols = np.array([idx[x] for x in edge_df["to"].to_list()])
    data = np.ones(len(rows), dtype=np.float32)
    A = sp.coo_matrix((data, (rows, cols)), shape=(N, N)).tocsr()
    A = A + A.T  # traverse edges in both directions
    A.data[:] = 1.0
    deg = np.asarray(A.sum(axis=1)).ravel()
    deg[deg == 0] = 1
    w = sp.diags(deg ** -damping)
    return (w @ A @ w).tocsr()


# Edge labels follow the pattern shown in the docs (DRG-DIS, DIS-GEN, ...).
# Check Step 2's output and fix these strings if the drug to gene label differs.
drug_gene = adjacency(edges.filter(pl.col("label") == "DRG-GEN"))
disease_gene = adjacency(edges.filter(pl.col("label") == "DIS-GEN"))
treats = adjacency(drug_disease.filter(pl.col("relation") == "INDICATION"))
disease_disease = adjacency(edges.filter(pl.col("label") == "DIS-DIS"))

# Path 1: drug -> gene -> disease  ("drug targets a gene linked to the disease")
# Path 2: drug -> disease -> similar disease  ("drug treats a related disease")
score_matrix = (drug_gene @ disease_gene) + 0.5 * (treats @ disease_disease)

# ---------------------------------------------------------------------------
# Step 5: rank drugs for one disease
# ---------------------------------------------------------------------------
query = sys.argv[1] if len(sys.argv) > 1 else "multiple sclerosis"
match = nodes.filter(pl.col("name").str.to_lowercase().str.contains(query.lower()))
print(match.select("id", "label", "name").head(10))

if match.height:
    disease_id = match["id"][0]
    col = score_matrix[:, idx[disease_id]].toarray().ravel()

    already_treats = set(
        drug_disease.filter(
            (pl.col("to") == disease_id) & (pl.col("relation") == "INDICATION")
        )["from"].to_list()
    )
    drug_ids = set(edges.filter(pl.col("label") == "DRG-GEN")["from"].to_list())

    ranked = [
        (node_ids[i], float(col[i]))
        for i in np.argsort(-col)
        if col[i] > 0 and node_ids[i] in drug_ids and node_ids[i] not in already_treats
    ][:10]

    names = dict(zip(nodes["id"].to_list(), nodes["name"].to_list()))
    print(f"\nTop candidates for {names.get(disease_id, disease_id)}:")
    for drug_id, s in ranked:
        print(f"  {names.get(drug_id, drug_id):40s} {s:.4f}")