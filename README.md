# RepurposeKG

Type a disease, get back a ranked list of already approved drugs that might treat it. Each candidate comes with a traceable biological reason, a check on whether anyone is already testing it, and a safety snapshot.

Built for **SacHacks HackRx 2026**, **Track 01: Best Translational Science** (sponsored by the Department of Biomedical Engineering).

> RepurposeKG generates research hypotheses for experts. It never gives treatment advice.


## Quick start

The artifacts are committed, so you do **not** need to download the 21.8 GB graph to run this.

**macOS and Linux**

```bash
git clone https://github.com/dixisouls/sachacks_2026.git
cd sachacks_2026
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python -m uvicorn api.main:app --reload --port 8000
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/dixisouls/sachacks_2026.git
cd sachacks_2026
py -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn api.main:app --reload --port 8000
```

Open **http://localhost:8000** and you land on the clickable API docs. Startup takes about 2 seconds, and requests answer in 2 to 4 ms.

> Use `python -m uvicorn`, not bare `uvicorn`. If a system-wide uvicorn was on your PATH before you made the venv, your shell may keep using it and fail with `ModuleNotFoundError: No module named 'polars'`. Running it through `python` always picks the venv.

Try it without the server:

```bash
python scripts/query.py "multiple sclerosis"
python scripts/query.py "Rett syndrome" --explain CHEMBL701
python scripts/rediscovery.py --tune          # the accuracy number, about 90 s
```

### Working on the frontend

The backend is running and ready. Start here:

```bash
curl "http://localhost:8000/api/diseases/search?q=rett"
curl "http://localhost:8000/api/diseases/MONDO_0010726/candidates?limit=10"
curl "http://localhost:8000/api/paths?drug_id=CHEMBL701&disease_id=MONDO_0010726"
```

`candidates` returns **two lists**, `approved` and `investigational`, meant to sit side by side. Response shapes with field descriptions are in `api/models.py`; the page and component plan is in `architecture.md` §10.

Suggested demo disease: **Rett syndrome** (`MONDO_0010726`). Genuinely rare at 18 genes, and the top results hold up.

### Rebuilding the artifacts

Only needed if you change how scoring data is built. This downloads the full graph.

```bash
pip install -r requirements.txt -r requirements-build.txt
python scripts/build_artifacts.py      # ~6 s after download
python scripts/build_similarity.py     # ~35 s; sequence half needs `brew install mmseqs2`
```

---

**`architecture.md` is the current build reference** — data, scoring, API, frontend, hosting, and what is done so far. The Setup and Build steps sections further down this README describe the original plan and have been superseded by it.


## Why this matters

A new drug takes over a decade and billions of dollars to develop. An approved drug already has safety data, so finding a new use for one is the fastest route from discovery to bedside. This matters most for rare and neglected diseases, where nobody is funding the search.

**Who uses it:** a translational researcher or clinician scientist deciding what to investigate next.


## How it meets the Track 01 criteria

| Track 01 criterion | How RepurposeKG meets it |
|:-|:-|
| Connect a research insight to a practical healthcare application | Knowledge graph paths (drug to gene to disease) become ranked repurposing candidates |
| Demo the functional tool, interface, or workflow | Type a disease, see the ranked list, click a drug, see the path and the evidence brief |
| Show a plausible path for validation, feasibility, and adoption | Validation: the rediscovery test number. Feasibility: approved drugs already have safety data. Adoption: hypothesis generation for researchers, with live trial checks |


## The key design rule

**The LLM explains and assembles. It never invents the biology.**

Every claim in a hypothesis brief must point to either a graph edge or a retrieved source (a PubMed ID, a trial ID, an Open Targets score, an openFDA count). If a claim has no source, it does not go in the brief. This is what separates the project from a chatbot guessing at drugs.


## How it works

```
             OFFLINE (on a laptop)                         ONLINE (hosted)
 ┌──────────────────────────────────────┐     ┌──────────────────────────────────────┐
 │ OptimusKG (190k nodes, 21.8M edges)  │     │ Frontend: search, ranked list,       │
 │            │                         │     │ path view, hypothesis brief          │
 │            ▼                         │     │            ▲                         │
 │ Path scoring (sparse matrices)       │     │            │                         │
 │            │                         │     │ Backend API: looks up precomputed    │
 │            ▼                         │     │ candidates, runs the evidence agent  │
 │ candidates.parquet (top 50 per       │ ──▶ │            │                         │
 │ disease, with paths and tags)        │     │            ▼                         │
 └──────────────────────────────────────┘     │ Live APIs: Open Targets, ChEMBL,     │
                                              │ PubMed, ClinicalTrials.gov, openFDA  │
                                              └──────────────────────────────────────┘
```

1. **Knowledge graph core.** OptimusKG connects drugs, genes, diseases, phenotypes, pathways and more.
2. **Candidate scoring.** For a disease, score every drug that does not already treat it by the paths connecting them. More paths, and rarer, more specific paths, mean a higher score.
3. **Exclusion and tagging.** Remove drugs already approved for the disease or its parent and child diseases. Tag drugs already in trials, and flag contraindications.
4. **Evidence agent.** For the top 10 candidates, an LLM agent gathers supporting material from live APIs.
5. **Hypothesis brief.** For each candidate: proposed mechanism, the graph path drawn visually, evidence for and against, and a readiness rating.


## Data: OptimusKG

OptimusKG is a biomedical knowledge graph from Harvard's Zitnik Lab, published April 2026.

| Item | Value |
|:-|:-|
| Nodes | 191,737 (61,306 genes, 36,740 diseases, 17,747 drugs, and more) |
| Edges | 21,833,630 across 66 label and relation pairs |
| Drug to disease edges | 59,264 INDICATION, 19,657 CONTRAINDICATION, 1,028 OFF_LABEL_USE |
| Drug IDs | ChEMBL (for example `CHEMBL1000`) |
| Disease IDs | EFO, MONDO, Orphanet (for example `MONDO_0005301`) |
| Format | Apache Parquet |
| Data | https://doi.org/10.7910/DVN/IYNGEV |
| Code and docs | https://github.com/mims-harvard/optimuskg and https://optimuskg.ai |

Because the IDs are ChEMBL and EFO/MONDO, the evidence agent can call Open Targets and ChEMBL directly with no ID mapping.

### Table schemas

**nodes:** `id`, `label` (node type: GEN, DIS, DRG, BPO, PHE, ANA, MFN, CCO, PWY, EXP), `properties` (JSON string with `name` and metadata)

**edges:** `from`, `to`, `label` (type pair, for example `DIS-GEN`), `relation` (for example `INDICATION`), `undirected`, `properties` (JSON string)

### Edge types used for scoring

| Edge label | Meaning | Used for |
|:-|:-|:-|
| `DRG-GEN` | Drug targets or modulates a gene | Drug to gene to disease paths |
| `DIS-GEN` | Disease is associated with a gene | Drug to gene to disease paths |
| `DRG-DIS` | Drug INDICATION, CONTRAINDICATION, OFF_LABEL_USE | Labels, exclusions, safety flags, readiness |
| `DIS-DIS` | Disease hierarchy (PARENT) | Disease family exclusion and "treats a similar disease" paths |

`DRG-DIS` edge properties include `highest_clinical_trial_phase`, which feeds the readiness rating.


## Repository layout

```
repurposekg/
├── README.md
├── requirements.txt
├── data/                     # not committed, see .gitignore
│   ├── largest_connected_component_nodes.parquet
│   ├── largest_connected_component_edges.parquet
│   └── candidates.parquet    # output of precompute.py
├── scripts/
│   ├── load_graph.py         # load OptimusKG (with the User-Agent fix)
│   ├── precompute.py         # score all diseases, write candidates.parquet
│   └── rediscovery.py        # hide known indications, report hit rate
├── api/
│   ├── main.py               # FastAPI app
│   └── agent/
│       ├── opentargets.py
│       ├── chembl.py
│       ├── pubmed.py
│       ├── clinicaltrials.py
│       ├── openfda.py
│       └── brief.py          # assembles the cited hypothesis brief
└── web/                      # frontend
```


## Setup

### 1. Environment

```bash
python3 -m venv venv
source venv/bin/activate
pip install optimuskg polars scipy numpy fastapi uvicorn httpx
```

### 2. Get the graph

**Option A: Python client.** Harvard Dataverse blocks the default `python-requests` User-Agent with a 403 error, so set a browser User-Agent before loading:

```python
import requests
import optimuskg

_orig_get = requests.get

def _get_with_ua(*args, **kwargs):
    headers = kwargs.setdefault("headers", {})
    headers.setdefault("User-Agent", "Mozilla/5.0 (Macintosh) repurposekg-hackathon")
    return _orig_get(*args, **kwargs)

requests.get = _get_with_ua

nodes, edges = optimuskg.load_graph(lcc=True)
```

`lcc=True` loads only the largest connected component, which drops fragments no path can reach.

**Option B: browser.** Download `largest_connected_component_nodes.parquet` and `largest_connected_component_edges.parquet` from https://doi.org/10.7910/DVN/IYNGEV into `data/`, then:

```python
import polars as pl
nodes = pl.read_parquet("data/largest_connected_component_nodes.parquet")
edges = pl.read_parquet("data/largest_connected_component_edges.parquet")
```

Plan for a few GB of RAM. Do not load the graph into NetworkX for scoring, it is too slow at this size.


## Build steps

### Step 1: Path scoring

Build one sparse adjacency matrix per edge type and multiply them. Weight each matrix by node degree (divide by degree to the power 0.5) so paths through hub genes count for less. This is the degree weighted path count (DWPC) idea from the Hetionet work.

```
score = (DRG-GEN @ DIS-GEN)              drug targets a gene linked to the disease
      + 0.5 * (INDICATION @ DIS-DIS)     drug treats a related disease
```

One matrix product scores every drug against every disease at once. Absolute scores mean nothing on their own; only the ranking matters. Normalize to 0 to 100 for the UI.

### Step 2: Disease selection

Search matches many nodes (for example "multiple sclerosis" matches subtypes, a rare syndrome and a measurement trait). Prefer an exact name match, and show the match list in the UI so the user can pick.

### Step 3: Exclusion and readiness tags

1. Collect the disease family: the disease plus its parents and children through `DIS-DIS` PARENT edges.
2. **Exclude** drugs with an approved INDICATION for any disease in the family.
3. **Tag** drugs that have an INDICATION with a trial phase below approval as "already in trials".
4. **Flag** drugs with a CONTRAINDICATION edge to the disease family as "safety concern".
5. Everything left is "approved and untested" for this disease. These are the interesting ones.

### Step 4: Precompute

Run scoring for every disease offline and save the top 50 candidates per disease into `data/candidates.parquet`, with columns:

`disease_id, disease_name, rank, drug_id, drug_name, score, readiness, top_paths (JSON)`

`top_paths` stores the strongest few paths (for example `drug → GENE_X → disease`) so the frontend can draw them without the full graph. The hosted app only needs this file.

### Step 5: Evidence agent

For the top 10 candidates of a chosen disease, call the APIs below and collect results with their IDs. Start with the three name based sources; add Open Targets and ChEMBL if time allows.

| Source | What it gives | Endpoint |
|:-|:-|:-|
| ClinicalTrials.gov | Whether a trial for this drug and disease already exists | `https://clinicaltrials.gov/api/v2/studies` |
| PubMed (E-utilities) | Papers mentioning the drug and disease pair | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` |
| openFDA | Most reported adverse events for the drug | `https://api.fda.gov/drug/event.json` |
| Open Targets | Strength of the gene and disease association | `https://api.platform.opentargets.org/api/v4/graphql` |
| ChEMBL | Mechanism of action and approval status | `https://www.ebi.ac.uk/chembl/api/data/` |

### Step 6: Hypothesis brief

The LLM receives only the graph paths and the retrieved results, and writes a one page brief:

* **Proposed mechanism**, citing graph edges
* **Graph path**, drawn visually
* **Evidence for**, each line citing a PMID, trial ID or score
* **Evidence against**, including contraindications and adverse events
* **Readiness rating:** approved and untested, already in trials, or safety concern

Validate after generation: any sentence without a source reference gets dropped.

### Step 7: Frontend

1. Disease search box with a match picker
2. Ranked candidate list with readiness badges
3. Click a drug to see the path light up in a graph view (Cytoscape.js or vis-network)
4. The hypothesis brief beside the graph


## Proving it works

### Rediscovery test (the headline number)

1. Pick a random 20% of INDICATION edges and remove them from the graph.
2. Rebuild the matrices and re-score.
3. For each hidden pair, check whether the drug appears in that disease's top 10 and top 50.
4. Report: "X% of hidden known treatments reappear in the top 10, Y% in the top 50."

Add a random ranking baseline next to it so the number has context.

### Famous case

Hide the link for a well known repurposing story, show the system recovers it, then show a novel suggestion for a rare disease.


## Hosting

Judges must test a hosted, interactive app. Do not host the full graph.

* **Backend:** FastAPI serving `candidates.parquet` plus the evidence agent, on Render, Railway or Fly.io
* **Frontend:** any static host (Vercel works well)
* **Secrets:** keep the LLM API key in host environment variables, never in the repo


## Demo script (3 to 4 minutes)

1. **The problem (30 s):** new drugs take a decade and billions; approved drugs already have safety data; rare diseases get no search.
2. **Live demo (2 min):** type a rare disease, show the ranked list, click a candidate, watch the path light up, read the brief and point at a citation.
3. **Proof (30 s):** the rediscovery number versus the random baseline.
4. **Path to adoption (30 s):** hypothesis generation for researchers, trial check shows what is already being tested, every claim is traceable. Not treatment advice.


## Timeline (judging at 7:00 PM)

| Time | Goal |
|:-|:-|
| By 12:00 | Graph loaded, scoring, exclusion and readiness tags working for one disease |
| 12:00 to 1:00 | Lunch; run precompute for all diseases in the background |
| By 3:00 | Rediscovery number; backend API serving candidates |
| By 5:00 | Evidence agent with ClinicalTrials.gov, PubMed and openFDA; brief generation |
| By 6:00 | Frontend with path view; everything hosted |
| 6:00 to 7:00 | Dinner, demo rehearsal, fix whatever broke |

### Scope

| Must have | Nice to have | Skip |
|:-|:-|:-|
| Graph loaded, path scoring, top 10 list | Graph visualization, readiness rating | Training a graph neural network |
| Evidence agent with 2 or 3 sources | All five sources, PDF export | Molecular docking or structure prediction |
| Rediscovery number | Side by side with a plain LLM baseline | Extra datasets beyond OptimusKG |


## Risks

| Risk | Mitigation |
|:-|:-|
| Scoring takes longer than expected | Get it working by noon or simplify to one path type |
| Plausible sounding but wrong mechanisms | The citation rule: no source, no sentence |
| Novelty (repurposing tools exist) | Rare disease focus, live evidence, trial check and readiness layer |
| Known drugs crowding the top of the list | Disease family exclusion and readiness tags |
| Hosting a 21.8M edge graph | Precompute offline and host only the results |


## Acknowledgements

* OptimusKG: Vittor, Noori, Arango, Polonuer, Rodriques, White, Clifton, Zitnik. *OptimusKG: Unifying biomedical knowledge in a modern multimodal graph* (2026). https://optimuskg.ai
* Degree weighted path scoring follows the Hetionet and Project Rephetio work by Himmelstein et al.
* The integrated source datasets keep their own licenses and terms of use.

## Disclaimer

RepurposeKG is a research hypothesis generator. Its output is not medical advice and must not be used to make treatment decisions.