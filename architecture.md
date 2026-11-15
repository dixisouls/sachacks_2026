# RepurposeKG Architecture

This is the build reference for the whole team. It covers the data, the offline pipeline, the scoring math, the backend API, the evidence pipeline, the LLM brief, 3D structure rendering, the frontend, and hosting.

Where this document and the README disagree, this document wins. The main change is that **scoring runs live at query time on small, preprocessed matrices** instead of being precomputed for every disease.

All numbers below were measured on the OptimusKG v3.2 largest connected component (`lcc=True`).

## Build order and status

| # | Piece | Files | Status |
|:-|:-|:-|:-|
| 1 | Artifacts | `scripts/load_graph.py`, `scripts/build_artifacts.py` | Done. 12.6 MB, builds in ~6 s |
| 2 | Scoring core, two lists, search, CLI | `api/scoring.py`, `api/search.py`, `scripts/query.py` | Done. ~3 ms per disease |
| 2b | Compound and sequence similarity layers | `scripts/build_similarity.py` | Done. +0.4 MB, ~35 s |
| 3 | Rediscovery test | `scripts/rediscovery.py` | Done. Hits@10 0.197, see §5.0 |
| 4 | Backend API | `api/main.py`, `api/models.py`, `api/logging_setup.py` | Done. `uvicorn api.main:app --reload`, docs at `/docs` |
| 5 | Frontend skeleton (search, two lists, path graph) | `web/` | Next, and unblocked |
| 6 | Evidence + brief | `api/evidence/`, `api/brief.py` | |
| 7 | 3D structures | `api/structures.py`, `StructureViewer.tsx` | |
| 8 | Hosting + prewarm | `scripts/prewarm.py`, deploy config | |

Setup on any machine (macOS or Windows):

```bash
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python scripts/build_artifacts.py   # downloads the graph on first run
python scripts/build_similarity.py  # optional layers; needs mmseqs for the sequence half
python scripts/query.py "multiple sclerosis"
python scripts/query.py "Rett syndrome" --explain CHEMBL701
```

`mmseqs` is only needed to *build* `S.npz`. Once it is built it ships as an
artifact, so teammates on Windows can pull it and run everything without the
binary. Without `C.npz` or `S.npz` the scorer quietly falls back to graph paths.

---

## 1. System overview

```
┌──────────────────────────── OFFLINE (laptop, run once) ────────────────────────────┐
│                                                                                    │
│  OptimusKG parquet ──▶ scripts/build_artifacts.py ──▶ artifacts/                   │
│  (191,737 nodes,        filter, map IDs, build          drugs.parquet               │
│   21.8M edges)          sparse matrices                 genes.parquet               │
│                                                         diseases.parquet            │
│                         scripts/rediscovery.py ──▶      indications.parquet         │
│                         hide 20%, re-score,             contraindications.parquet   │
│                         compare baselines               T.npz  M.npz  H.npz         │
│                                                         eval.json                   │
└────────────────────────────────────────────────────────────────┬───────────────────┘
                                                                 │ shipped with backend
┌──────────────────────────── ONLINE (hosted) ───────────────────▼───────────────────┐
│                                                                                    │
│  Frontend (React + Vite, Vercel)                                                   │
│   Search ─▶ Ranked list ─▶ Detail panel: [Path graph] [3D structure] [Brief]       │
│        │                                                                           │
│        ▼  HTTPS / JSON                                                             │
│  Backend (FastAPI, Render)                                                         │
│   ├─ search      fuzzy disease lookup over diseases.parquet                        │
│   ├─ scoring     sparse matrix products, exclusion, readiness tags                 │
│   ├─ paths       top drug → gene → disease paths for one pair                      │
│   ├─ evidence    ClinicalTrials.gov, PubMed, openFDA, ChEMBL (parallel, cached)    │
│   ├─ brief       one LLM call, structured JSON, citation validator                 │
│   └─ structures  PubChem (drug 3D), AlphaFold DB (protein), RCSB PDB (co-crystal)  │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Request flow for one demo interaction**

1. User types "multiple sclerosis" → `GET /api/diseases/search` → match list → user picks one.
2. `GET /api/diseases/{id}/candidates` → scored, filtered, tagged list of approved drugs. Takes under 200 ms and needs no external calls.
3. User clicks a drug → three calls run in parallel:
   * `GET /api/paths` → path graph (local, fast)
   * `GET /api/structures` → 3D structure metadata (external, cached)
   * `POST /api/brief` → evidence + LLM brief (external, slowest, cached)

---

## 2. Data layer: OptimusKG

### 2.1 Node types

| Label | Count | Used? | Key properties we keep |
|:-|-:|:-|:-|
| `GEN` | 61,306 | Yes | `symbol`, `name`, `associated_proteins` (UniProt IDs), `tractability` |
| `DIS` | 36,740 | Yes | `name`, `description`, `related_synonyms`, `exact_synonyms`, `therapeutic_areas` |
| `DRG` | 17,747 | Yes | `name`, `canonical_smiles`, `inchi_key`, `is_approved`, `maximum_clinical_trial_phase`, `year_of_first_approval`, `black_box_warning`, `has_been_withdrawn`, `mrdef`, `type`, `synonyms`, `cd_formula`, `cd_mol_weight` |
| `BPO`, `PHE`, `ANA`, `MFN`, `CCO`, `PWY`, `EXP` | 75,944 total | No (v1) | Possible later path types (pathways, phenotypes) |

**Approved vs not approved:** `is_approved == true` matches **3,999** drug nodes (6,927 are false and 6,821 null). Results are always shown as **two separate lists**: approved drugs (the repurposing pitch) and not-approved compounds (investigational or withdrawn, useful for researchers). See §4.3.

**Salt forms:** 3,836 drug nodes are salts linked to a parent by `DRG-DRG PARENT` (from = parent, e.g. METFORMIN → METFORMIN HYDROCHLORIDE). The build merges each salt into its parent: targets and indications are combined, and the parent counts as approved if any form is approved. After merging: **13,911 drugs, 2,924 approved**.

All property values arrive as a JSON string in the `properties` column. Nested values such as `synonyms` and `associated_proteins` are Python-style list strings with single quotes. Parse them with `ast.literal_eval`, not `json.loads`.

### 2.2 ID formats

| Entity | Format | Example | External use |
|:-|:-|:-|:-|
| Drug | ChEMBL | `CHEMBL1000` | ChEMBL API, PubChem via `inchi_key` |
| Gene | Ensembl | `ENSG00000196639` | Symbol for display, UniProt for AlphaFold/PDB |
| Disease | EFO / MONDO / DOID / Orphanet | `EFO_0000274`, `MONDO_0005301` | Name string for trials and PubMed |
| Protein | UniProt (from gene `associated_proteins`, prefer `source == "uniprot_swissprot"`) | `P35367` | AlphaFold DB, RCSB PDB |

### 2.3 Edge types used

| Label | Relation(s) | Count | Direction in file | Role |
|:-|:-|-:|:-|:-|
| `DRG-GEN` | 30 relations: `TARGET`, `INHIBITOR`, `ENZYME`, `TRANSPORTER`, `ANTAGONIST`, `AGONIST`, `BLOCKER`, … | ~37k | from = drug, to = gene | Drug → gene step. The relation becomes the edge label in the path view ("antagonist of HRH1") |
| `DIS-GEN` | `ASSOCIATED_WITH` | 9,734,774 | from = disease, to = gene | Gene → disease step. Weighted by `evidence_score` |
| `DRG-DIS` | `INDICATION` | 58,174 | from = drug, to = disease | Exclusion, trial tags, rediscovery labels, sibling path |
| `DRG-DIS` | `CONTRAINDICATION` | 11,379 | from = drug, to = disease | Safety flag |
| `DRG-DIS` | `OFF_LABEL_USE` | 827 | from = drug, to = disease | Shown as "already used off label" |
| `DIS-DIS` | `PARENT` | 47,886 | **from = parent, to = child** (checked: synucleinopathy → Lewy body dementia) | Disease family and sibling paths |

**Edge properties that matter**

* `DIS-GEN.evidence_score`: float from 0.0009 to 0.95, median 0.026. Most of the 9.7M edges are very weak. **Keep only `evidence_score >= 0.1`**, which leaves 1.84M edges across 18,609 diseases, and use the score as the edge weight. Without this threshold every disease links to thousands of genes and the rankings turn into hub noise.
* `DRG-DIS.highest_clinical_trial_phase`: counts are 4.0 → 7,873; 3.0 → 13,327; 2.0 → 20,354; 1.0 → 12,283; 0.5 → 1,001; -1.0 → 478; null → 2,858.
* `DRG-DIS.reference_ids`: often contains NCT trial IDs. These count as citable evidence.
* `DRG-GEN.source_urls`: sometimes an FDA label URL. Citable.

### 2.4 Indication status rule

```
approved_indication  = INDICATION and phase == 4.0
                       or (phase is null and "DRUG_CENTRAL" in sources.direct)   # label-derived
trial_indication     = INDICATION and phase in {0.5, 1.0, 2.0, 3.0}
ignore               = INDICATION and phase == -1.0  (withdrawn or unknown)
```

Check the null-phase rule on a handful of rows in `build_artifacts.py` before relying on it.

---

## 3. Offline pipeline

### 3.1 `scripts/load_graph.py`

* Loads the two parquet files from the optimuskg cache, or from `data/` if downloaded manually.
* Applies the Dataverse User-Agent fix (see README).
* Returns polars DataFrames and never touches NetworkX.

### 3.2 `scripts/build_artifacts.py`

Produces everything the backend needs. The output must stay under about 150 MB so it ships with the backend.

| Artifact | Contents | Build notes |
|:-|:-|:-|
| `drugs.parquet` | `drug_id, idx, name, synonyms, smiles, inchi_key, is_approved, max_phase, year_approved, black_box, withdrawn, mrdef, type, formula, mol_weight` | All 17,747 drugs. `idx` is the row index in T. Drop `mol_image_base64` and `mol_file_base64` because they are large and not needed |
| `genes.parquet` | `gene_id, idx, symbol, name, uniprot_id` | Only genes that appear in T or M |
| `diseases.parquet` | `disease_id, idx, name, description, synonyms (list), therapeutic_areas, n_genes` | `n_genes` = number of M edges, used to warn about thin diseases |
| `drug_disease.parquet` | `drug_id, disease_id, relation, phase, status (approved/trial/other/n/a), trial_ids` | INDICATION, CONTRAINDICATION and OFF_LABEL_USE in one table, salts merged into parents |
| `drug_gene.parquet` | `drug_id, gene_id, relation (list), source_url` | Path labels ("ANTAGONIST") and FDA label citations |
| `T.npz` | drugs × genes, CSR, binary | 1 if any `DRG-GEN` edge exists |
| `M.npz` | genes × diseases, CSR, float32 | `evidence_score` where ≥ 0.1 |
| `H.npz` | diseases × diseases, CSR, binary | H[parent, child] = 1 |
| `I.npz` | drugs × diseases, CSR, binary | Approved + trial indications (training set for the sibling path) |
| `C.npz`, `chem_pairs.parquet` | drugs × drugs, CSR, Tanimoto | From `build_similarity.py`, see §4.2b |
| `S.npz`, `homolog_pairs.parquet` | genes × genes, CSR, fraction identity | From `build_similarity.py`, see §4.2b |
| `eval.json` | Rediscovery results | See §5 |

Matrix sizes: T is 17.7k × ~20k genes with ~37k nonzeros (tiny). M has ~1.84M nonzeros (~22 MB). Both fit easily in hosted RAM.

---

## 4. Scoring

### 4.1 Degree-weighted matrices

Damping follows the Hetionet DWPC idea: paths through hub nodes count for less.

```
w = 0.5
Tn = D_drug^-w  · T · D_gene,T^-w        # degrees taken from T
Mn = D_gene,M^-w · M · D_dis^-w          # degrees = number of M edges, not the sum of weights
```

### 4.2 Two path types

**Path A, shared biology.** Drug targets a gene that is associated with the disease.

```
A = Tn @ Mn                  # drugs × diseases
```

**Path B, treats a sibling disease.** Drug treats a disease that shares a parent with the target disease.

```
Sib = (Hᵀ @ H), diagonal removed, binarized      # child × child via a shared parent
B   = I @ Sib                                    # drugs × diseases
```

Siblings are used, not parents or children, because §4.3 already excludes drugs indicated for the parent/child family. A one-hop term would only score drugs that get removed anyway.

**Path C, chemical look-alike.** The drug resembles another drug whose target reaches the disease. This finds candidates whose own targets are missing from the graph, which is common for older drugs.

```
C = Cn @ A[:, j]        # Cn = degree-weighted Tanimoto similarity, drugs × drugs
```

**Path D, protein homolog.** The drug hits a protein whose close sequence relative is associated with the disease. This is the "similar targets bind similar drugs" principle, and it is the layer that helps most where the disease gene has no drug at all.

```
D = Tn @ (Sn @ Mn[:, j])    # Sn = degree-weighted sequence identity, genes × genes
```

**Combined score for one disease column `j`:** each component is scaled to 0..1 within the disease, then weighted.

```
score = 1.0·a + 0.5·b + 0.4·c + 0.4·d
display_score = round(100 · score / max(score))
```

The weights live in `DEFAULT_WEIGHTS` in `api/scoring.py` and get tuned by the rediscovery test (§5).

Query time computes one column only, a few sparse matrix-vector products that take about 3 ms. No full drugs × diseases matrix is ever built.

**C and D are inferred, not observed.** Every path, edge and candidate they produce carries `inferred: true` plus the number it rests on (Tanimoto coefficient or percent identity). The UI marks them, and the brief must word them as inference ("X is 62% structurally similar to Y, which targets…"), never as a known fact. A candidate supported *only* by C or D has `inferred_only: true`.

### 4.2b Similarity layers (`scripts/build_similarity.py`)

| Artifact | Built from | Method | Result |
|:-|:-|:-|:-|
| `C.npz` + `chem_pairs.parquet` | `canonical_smiles` on drug nodes (8,342 of 13,911 have one) | RDKit Morgan fingerprints, radius 2, 2048 bits, Tanimoto ≥ 0.55, top 15 per drug. Columns limited to the 5,667 drugs that have a gene target | 10,716 pairs; 3,649 drugs have a look-alike. ~8 s, no download |
| `S.npz` + `homolog_pairs.parquet` | UniProt accessions on gene nodes (18,762 of 19,608 have one) | MMseqs2 `easy-search`, ≥ 40% identity, e-value ≤ 1e-10, ≥ 60% coverage, top 10 per protein. 3,525 drug-target proteins searched against 18,661 disease-associated proteins | 7,519 pairs; 2,155 drug targets have a homolog. ~25 s plus a one-time 7.5 MB UniProt download into `data/` |

Both are optional and loaded only if present. `rdkit` is pip-installable everywhere; `mmseqs` is a build-time-only dependency (see the setup note above).

**Worked examples that show the layers earning their place**

* Multiple sclerosis: **R-406** enters the not-approved list through Path C alone, as the chemical twin of **fostamatinib**, which sits at #3 in the approved list. Fostamatinib is a prodrug of R-406, so the structural link is real.
* Multiple sclerosis: **omipalisib** picks up Path D support because it targets PIK3R1, whose protein is 59% identical to PIK3R2, another MS-associated gene.
* Rett syndrome (18 genes, a genuinely thin rare disease): **baclofen** ranks #1 approved and **arbaclofen**, its active enantiomer, tops the not-approved list. Arbaclofen has in fact been trialled in Rett syndrome, which makes this a good demo case.

**What we deliberately did not build:** patient genomes or variant data, viral genome search, and protein language model embeddings. Each is a separate project, and none fits in the remaining time. The graph holds no DNA sequence, so protein sequence is the right level to compare at; a gene's chromosome location is available in the node properties if the UI ever wants to show it.

### 4.3 Disease family, exclusion and readiness

```
family(j) = {j} ∪ parents(j) ∪ all descendants(j)       # via H; descendants by BFS
```

Every drug with `score > 0` and no approved indication for any disease in the family goes into one of two lists, each ranked separately:

* **Approved list:** `is_approved` and not withdrawn.
* **Not approved list:** everything else (investigational compounds and withdrawn drugs).

Drugs with an approved indication for the family are **excluded** from both (already a treatment). The response reports the total count.

Readiness tags, checked in this order:

| Approved list | Not approved list |
|:-|:-|
| `SAFETY_CONCERN`: contraindication to the family, or black box warning | `WITHDRAWN`: withdrawn from market |
| `IN_TRIALS`: trial indication (phase 0.5–3) for the family, with phase and NCT IDs | `SAFETY_CONCERN`: contraindication to the family |
| `OFF_LABEL`: off-label use for the family | `IN_TRIALS`: trial indication for the family |
| `APPROVED_UNTESTED`: none of the above (the interesting ones) | `INVESTIGATIONAL`: none of the above. `max_phase` shows how far the compound got overall |

The code computes the readiness tag. The LLM never sets it.

Implemented in `api/scoring.py` (`Scorer.candidates`). Check it from the command line with `python scripts/query.py "multiple sclerosis"`.

### 4.4 Path extraction for one pair (drug d, disease j)

```
contrib[g] = Tn[d, g] · Mn[g, j]          for genes g where both are nonzero
top genes  = top 5 by contrib
siblings   = diseases s where I[d, s] = 1 and Sib[s, j] = 1   (up to 3)
```

Each path carries the edge metadata the frontend and brief need: the drug→gene relation (`ANTAGONIST`), the FDA label URL if present, the gene→disease `evidence_score`, and the gene's UniProt ID.

### 4.5 Thin-disease warning

If `n_genes(j) < 5` and there is no sibling signal, the API returns `warning: "LOW_GRAPH_COVERAGE"` and the UI shows "Few known gene associations, results are weak." Many rare diseases fall into this case. Pick demo diseases with good coverage.

---

## 5. Validation: rediscovery test (`scripts/rediscovery.py`) — DONE

### 5.0 Results

Full run, 1,618 held-out pairs, reported on split seed 7 while the weights were tuned on seed 42.

| Method | Hits@10 | Hits@50 | MRR | Median rank |
|:-|-:|-:|-:|-:|
| **RepurposeKG** (shipped weights) | **0.197 ± 0.013** | 0.370 | 0.096 | 55 |
| graph paths + chemical | 0.201 ± 0.013 | 0.371 | 0.094 | 53 |
| graph paths only | 0.184 ± 0.012 | 0.362 | 0.094 | 53 |
| graph paths + homology | 0.184 ± 0.012 | 0.343 | 0.091 | 61 |
| path A alone | 0.135 ± 0.011 | 0.256 | 0.070 | 76 |
| path B alone | 0.096 ± 0.009 | 0.190 | 0.052 | 24 |
| popularity baseline | 0.029 ± 0.005 | 0.074 | 0.013 | 616 |
| random baseline | 0.002 ± 0.001 | 0.015 | 0.003 | 1337 |

**The line for the demo:** about **1 in 5 hidden known treatments comes back in the top 10**, roughly 7× the popularity baseline and 100× random.

What the table also says, and we should say out loud if asked:

* The two graph paths are worth far more together (0.184) than either alone (0.135, 0.096). They find different things.
* Chemical similarity gives a small lift that sits inside one standard error. Honest wording: it helps slightly and clearly does not hurt.
* **Protein homology did not improve ranking, so its weight tuned to 0.** It is kept for explanation only. The reason it cannot win here is structural: the positive set is approved indications, which by definition involve drugs whose targets the graph already records, and that is precisely the case the homology layer is not for. The test cannot measure its intended use, so a zero weight is not the same as a verdict that the idea is wrong.
* Of 1,618 held-out pairs, **616 were not recoverable** because the drug is approved for a parent or child of the hidden disease and stays excluded on training data alone. Those are reported separately, never counted as hits, because the product never shows those drugs. A further 242 scored zero and count as misses.
* Weights were selected on MRR, not Hits@10: on this grid the best Hits@10 values sit well inside one standard error of each other, so selecting on them would be fitting noise.

Reproduce with `python scripts/rediscovery.py --tune` (about 90 s). Results land in `artifacts/eval.json`.

### 5.1 Method

1. Positive set = **approved** indications only (§2.4). Seed = 42.
2. Hide a random 20% of them.
3. Rebuild `I` and the exclusion sets from the remaining 80%. `A` does not use indications, so it does not change.
4. For each hidden pair (d, j): score column j, apply exclusion using training data only, and find the rank of d among approved candidates.
5. Metrics: **Hits@10, Hits@50, MRR**, plus the median rank.
6. Baselines, ranked over the same candidate pool:
   * **Random**: shuffle candidates.
   * **Popularity**: rank by number of training indications per drug. This is the honest baseline that judges will respect.
   * **Path A only** and **Path B only**: ablations that show what each component adds.
7. Write `eval.json`:

```json
{
  "seed": 42, "n_hidden": 1574, "lambda": 0.5,
  "methods": {
    "repurposekg":  {"hits@10": 0.0, "hits@50": 0.0, "mrr": 0.0, "median_rank": 0},
    "path_a_only":  {...}, "path_b_only": {...},
    "popularity":   {...}, "random": {...}
  },
  "famous_cases": [{"drug": "...", "disease": "...", "rank_when_hidden": 0}]
}
```

The values shown are placeholders until the script runs. Use this script to tune λ and the evidence threshold, but report the final numbers on a fresh seed so the tuning isn't graded on itself.

---

## 6. Backend

**Stack:** Python 3.11+, FastAPI, uvicorn, polars, scipy, numpy, httpx (async), pydantic v2, anthropic SDK.

### 6.1 Layout

```
api/
├── main.py                 # app, CORS, startup loads artifacts into memory
├── config.py               # env vars (see §9.3)
├── models.py               # pydantic schemas (§6.3)
├── store.py                # loads artifacts once; id ↔ idx maps; name lookups
├── scoring.py              # §4: score_column, family, readiness, paths
├── search.py               # disease search
├── cache.py                # in-memory LRU + JSON disk cache (cache/ dir)
├── evidence/
│   ├── __init__.py         # gather_evidence(): runs all sources concurrently
│   ├── clinicaltrials.py
│   ├── pubmed.py
│   ├── openfda.py
│   └── chembl.py
├── brief.py                # prompt build, LLM call, citation validator
└── structures.py           # PubChem, AlphaFold, RCSB lookups + file proxy
scripts/
├── load_graph.py
├── build_artifacts.py
├── rediscovery.py
└── prewarm.py              # fills the cache for the demo diseases before judging
tests/
├── test_scoring.py         # toy 4-drug / 5-gene / 3-disease graph with known answers
├── test_validator.py
└── test_api.py             # smoke tests through FastAPI TestClient
```

### 6.2 Endpoints

| Method | Path | Purpose | External calls |
|:-|:-|:-|:-|
| GET | `/api/health` | Liveness check + artifact version | none |
| GET | `/api/diseases/search?q=&limit=10` | Ranked disease matches | none |
| GET | `/api/diseases/{disease_id}` | Disease detail (name, description, n_genes, therapeutic areas) | none |
| GET | `/api/diseases/{disease_id}/candidates?limit=50&include_excluded=false` | Ranked candidates with readiness | none |
| GET | `/api/paths?drug_id=&disease_id=` | Path graph for one pair | none |
| POST | `/api/brief` body `{drug_id, disease_id}` | Evidence + cited brief | trials, PubMed, openFDA, ChEMBL, LLM |
| GET | `/api/structures?drug_id=&gene_id=` | Structure plan (mode + URLs) | PubChem, AlphaFold, RCSB |
| GET | `/api/structures/file?src=&id=` | Proxied, cached structure file | the one source |
| GET | `/api/eval` | Contents of `eval.json` | none |

**Search ranking:** exact name match → exact synonym match → name prefix → substring. Ties go to the higher `n_genes`. Each result returns `n_genes` so the picker can grey out thin diseases.

### 6.3 Core schemas

```python
class DiseaseHit(BaseModel):
    disease_id: str; name: str; match_type: Literal["exact","synonym","prefix","substring"]
    n_genes: int; therapeutic_areas: list[str]

class Candidate(BaseModel):
    rank: int; drug_id: str; drug_name: str     # rank is within its own list
    score: int                                  # 0..100, relative to the best drug across both lists
    score_components: dict[str, float]          # the four components of 4.2, each 0..1
    lead_path: str | None                       # which component contributed most
    inferred_only: bool                         # supported only by similarity, no graph path
    readiness: Literal["APPROVED_UNTESTED","IN_TRIALS","OFF_LABEL","SAFETY_CONCERN",
                       "INVESTIGATIONAL","WITHDRAWN"]
    approved: bool; max_phase: float | None
    trial_phase: float | None; trial_ids: list[str]
    top_gene_symbols: list[str]                 # up to 3, for the list row
    year_approved: int | None; black_box: bool

class CandidatesResponse(BaseModel):
    disease: DiseaseSummary
    approved: list[Candidate]                   # list 1
    investigational: list[Candidate]            # list 2: not approved
    excluded_count: int                         # scored drugs removed as already approved
    already_approved_total: int                 # all drugs approved for the family
    family_size: int; warning: str | None

class PathNode(BaseModel):
    id: str; type: Literal["drug","gene","disease"]; label: str
    uniprot_id: str | None = None

class PathEdge(BaseModel):
    source: str; target: str
    relation: str                               # ANTAGONIST, ASSOCIATED_WITH, INDICATION,
                                                # SIBLING_OF, SIMILAR_STRUCTURE, SIMILAR_SEQUENCE
    weight: float | None                        # evidence score, Tanimoto or identity
    citation: str | None                        # "KG:..", "CHEM:..|tanimoto=0.62", "SEQ:..|identity=0.59"
    inferred: bool                              # true for the two similarity edge types

class Path(BaseModel):
    type: Literal["shared_biology","sibling_disease","chemical_analog","protein_homolog"]
    nodes: list[str]                            # ordered node ids
    contribution: float | None
    inferred: bool; similarity: float | None
    explanation: str                            # one plain sentence, safe to show as-is

class PathsResponse(BaseModel):
    nodes: list[PathNode]; edges: list[PathEdge]
    paths: list[Path]                           # strongest first

class EvidenceItem(BaseModel):
    id: str                                     # "PMID:123", "NCT01234567", "FAERS:cetirizine", "KG:..", "CHEMBL_MOA:.."
    source: Literal["pubmed","clinicaltrials","openfda","chembl","graph"]
    title: str; url: str; snippet: str | None; data: dict

class Claim(BaseModel):
    text: str; source_ids: list[str]            # must be non-empty and all in evidence ids

class Brief(BaseModel):
    drug_id: str; disease_id: str
    mechanism: list[Claim]; evidence_for: list[Claim]; evidence_against: list[Claim]
    readiness: str                              # copied from scoring, not from the LLM
    evidence: list[EvidenceItem]
    dropped_claims: int; generated_at: str; model: str
```

### 6.4 Startup and memory

`store.py` loads all artifacts once at startup (about 300–500 MB RSS), builds `Tn`, `Mn`, `Sib`, the CSC version of `Mn` for fast column access, and the family maps. The first request after a cold start may take a few seconds. A free Render instance sleeps when idle, so keep it awake during judging (paid instance, or ping `/api/health` every 5 min).

---

## 7. Evidence pipeline (`api/evidence/`)

This is a deterministic fetcher, not an agent loop. All sources run concurrently with `asyncio.gather`, each with a 6 s timeout. A failed source returns `[]` plus a note and never fails the whole brief.

| Source | Request | What we keep | Evidence id |
|:-|:-|:-|:-|
| ClinicalTrials.gov v2 | `GET https://clinicaltrials.gov/api/v2/studies?query.cond={disease_name}&query.intr={drug_name}&pageSize=20` | NCT ID, title, overall status, phase, start date | `NCT01234567` |
| PubMed E-utilities | `esearch.fcgi?db=pubmed&term="{drug}"[tiab] AND "{disease}"[tiab]&retmax=10&retmode=json`, then `esummary.fcgi?db=pubmed&id=...&retmode=json` | PMID, title, journal, year, total hit count | `PMID:12345678` |
| openFDA FAERS | `GET https://api.fda.gov/drug/event.json?search=patient.drug.openfda.generic_name:"{drug}"&count=patient.reaction.reactionmeddrapt.exact&limit=10` | Top 10 reactions with counts | `FAERS:{drug}` |
| ChEMBL | `GET https://www.ebi.ac.uk/chembl/api/data/mechanism.json?molecule_chembl_id={drug_id}` | Mechanism of action, action type, target | `CHEMBL_MOA:{mechanism_id}` |
| Graph (local) | from `PathsResponse` and `indications.parquet` | Drug→gene relation, gene→disease score, trial NCT IDs, contraindications | `KG:{from}|{to}|{relation}` |

**Rules**

* PubMed allows 3 req/s without a key and 10 req/s with `NCBI_API_KEY`. Always send `tool=repurposekg`. Leave the `email` parameter empty unless the team decides to add one.
* Search with the drug's generic name. If openFDA returns no hits, retry with the first synonym.
* Cache key = `(source, normalized query)`. Cache entries never expire during the event.
* A trial hit for this exact pair upgrades the displayed readiness to `IN_TRIALS` with the NCT link, even if the graph didn't know about it. Note this in the brief.

---

## 8. Hypothesis brief (`api/brief.py`)

### 8.1 LLM call

* Model from `LLM_MODEL` env var, default `claude-opus-5-5`. Switch to `claude-sonnet-5-5` if latency hurts the demo.
* One call per (drug, disease), cached to disk.
* Input: the paths and the evidence items, each with its `id`. Nothing else is provided.
* Output: JSON matching `{mechanism: Claim[], evidence_for: Claim[], evidence_against: Claim[]}`. Use structured output / tool-use JSON so parsing can't break.

### 8.2 Prompt rules (system prompt summary)

* Use only the provided items. Every claim must list at least one `source_id` from the provided list.
* Mechanism claims must cite at least one `KG:` edge.
* `evidence_against` must include contraindications, black box status and the top adverse events when present.
* Do not give dosing, treatment recommendations or patient advice.
* If evidence is thin, say so in one claim citing the PubMed search with its hit count.

### 8.3 Citation validator (runs after generation)

```
for each claim:
    drop if source_ids is empty
    drop if any source_id not in evidence ids
dropped_claims = number dropped
if mechanism is empty after validation → show "No supported mechanism" rather than retrying
```

The frontend turns each `source_id` into a link: PubMed → `https://pubmed.ncbi.nlm.nih.gov/{pmid}/`, trial → `https://clinicaltrials.gov/study/{nct}`, KG → highlights that edge in the path graph.

---

## 9. 3D structure rendering

### 9.1 What gets shown

The protein shown is always **the gene on the selected path** (the drug's own target in the graph). It is never a protein the model didn't use. For viral diseases, the path still goes through human genes. A viral protein structure would only appear as a separate, clearly labeled context card, which is out of scope for v1.

### 9.2 Structure lookup (`api/structures.py`)

For `(drug_id, gene_id)`:

```
1. drug 3D      PubChem:  GET https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/{inchi_key}/SDF?record_type=3d
                fallback: 2D from SMILES drawn client side (biologics have no small-molecule structure)

2. ligand code  RCSB search, service "text_chem":
                rcsb_chem_comp_descriptor.InChIKey == {inchi_key}  → chem comp id (e.g. "5EH")

3. co-crystal   RCSB search, return_type "entry", AND of:
                  rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession == {uniprot_id}
                  rcsb_nonpolymer_instance_annotation.comp_id == {comp_id}
                → pick the best resolution entry
                file: https://files.rcsb.org/download/{pdb_id}.cif
                (Checked: P35367 + 5EH → 3RZE)

4. no co-crystal → AlphaFold DB:  GET https://alphafold.ebi.ac.uk/api/prediction/{uniprot_id}
                → use the pdbUrl / cifUrl fields from the response (don't hardcode the model version; v6 is current)
```

**Response**

```python
class StructurePlan(BaseModel):
    mode: Literal["BOUND", "SEPARATE", "DRUG_ONLY", "NONE"]
    drug: { "format": "sdf", "file_url": str | None, "smiles": str }
    protein: { "source": "PDB" | "AlphaFold", "id": str, "format": "cif" | "pdb",
               "file_url": str, "uniprot_id": str, "gene_symbol": str,
               "mean_plddt": float | None } | None
    ligand_comp_id: str | None          # only in BOUND mode
    resolution_A: float | None
    caption: str                        # exact UI caption, see 9.4
```

`file_url` always points at `/api/structures/file?...`. The backend proxies and caches the file, which avoids CORS surprises and repeat downloads.

### 9.3 Viewer (frontend)

* Library: **3Dmol.js** via npm (`3dmol`), with the version locked in `package-lock.json`.
* Component: `<StructureViewer plan={StructurePlan} />`, lazy-loaded so it never blocks the list.
* Rendering by mode:

| Mode | Protein | Drug | Camera |
|:-|:-|:-|:-|
| `BOUND` | Cartoon, light grey; residues within 5 Å of the ligand as sticks; transparent surface around the pocket | Ligand selected by `resn = ligand_comp_id`, sticks, green carbons | `zoomTo` the ligand, slow spin off by default |
| `SEPARATE` | Cartoon colored by pLDDT (AlphaFold stores it in the B-factor column): >90 `#0053D6`, 70–90 `#65CBF3`, 50–70 `#FFDB13`, <50 `#FF7D45` | Separate small viewer beside the protein, sticks | Each viewer zooms to its own model |
| `DRUG_ONLY` | none | Sticks | zoomTo |
| `NONE` | none | 2D SMILES drawing (SmilesDrawer) | n/a |

* Controls: rotate/zoom (built in), a "reset view" button, a toggle for the surface, and a legend for the pLDDT colors.
* Clean up the viewer on unmount (`viewer.clear()`) so switching drugs doesn't leak WebGL contexts.
* On phone widths, show one viewer at a time with a toggle.

### 9.4 Captions (must match the data, never stronger)

* `BOUND`: "Experimental structure · PDB {id} · {resolution} Å · {drug} bound to {gene_symbol}"
* `SEPARATE`: "Predicted structure (AlphaFold) · {gene_symbol} · mean pLDDT {x} · no experimental binding structure found"
* Never place the drug inside the protein unless the mode is `BOUND`. No docking, no made-up poses.

---

## 10. Frontend

**Stack:** React 18 + TypeScript + Vite, React Router, TanStack Query (fetching + caching), Tailwind CSS, Cytoscape.js (path graph), 3Dmol.js (structures), SmilesDrawer (2D fallback). Hosted on Vercel. `VITE_API_URL` points at the backend.

### 10.1 Routes

| Route | Page |
|:-|:-|
| `/` | Landing: one-line pitch, search box, 3 example disease chips (the prewarmed demo diseases), disclaimer |
| `/d/:diseaseId` | Results: two ranked lists on the left (Approved / Not approved), empty detail panel on the right |
| `/d/:diseaseId/:drugId` | Same page with the detail panel open. Shareable URLs let judges jump straight in |
| `/validation` | Rediscovery results from `/api/eval`: bar chart of Hits@10 / Hits@50 per method, with the famous case |

### 10.2 Components

```
web/src/
├── api/client.ts              # typed fetchers mirroring §6.3 schemas
├── pages/Landing.tsx  Results.tsx  Validation.tsx
├── components/
│   ├── DiseaseSearch.tsx      # debounced input, dropdown with name, match type, n_genes; thin diseases greyed
│   ├── CandidateLists.tsx     # two sections, "Approved" and "Not approved", each with its own count;
│   │                          # side by side on wide screens, tabs on phones
│   ├── CandidateList.tsx      # rows: rank, drug name, score bar, ReadinessBadge, top genes, max phase
│   ├── ReadinessBadge.tsx     # APPROVED_UNTESTED green · IN_TRIALS blue · OFF_LABEL purple · SAFETY_CONCERN red
│   │                          # INVESTIGATIONAL grey · WITHDRAWN dark red
│   ├── DetailPanel.tsx        # header (drug, disease, score) + tabs
│   ├── PathGraph.tsx          # Cytoscape
│   ├── StructureViewer.tsx    # 3Dmol, §9.3
│   ├── BriefView.tsx          # claims with citation chips; skeleton while loading
│   ├── CitationChip.tsx       # PMID / NCT / FAERS / KG; KG chips highlight edges in PathGraph
│   └── Disclaimer.tsx         # always visible in footer
└── styles/
```

### 10.3 Detail panel tabs

1. **Path** (default): Cytoscape `breadthfirst` layout, drug on the left, genes in the middle, disease on the right, sibling diseases below. Node colors: drug orange, gene teal, disease purple. Edge width = weight, edge label = relation. Clicking a gene node switches the Structure tab to that gene.
2. **Structure**: §9.3. Loads when the tab opens or when a gene is clicked.
3. **Brief**: loads on panel open because it is the slowest call. Shows the skeleton while waiting, then the sections: Mechanism, Evidence for, Evidence against, Readiness. Each claim ends with citation chips. A footer notes "{n} unsupported claims removed" when `dropped_claims > 0`.

### 10.4 Shared state

* Selected disease and drug live in the URL (source of truth).
* Selected gene for the structure view is local state in `DetailPanel` and defaults to the top path gene.
* TanStack Query keys: `["search", q]`, `["candidates", diseaseId]`, `["paths", diseaseId, drugId]`, `["structure", drugId, geneId]`, `["brief", diseaseId, drugId]`. `staleTime: Infinity` because the data doesn't change during a session.

### 10.5 Loading and error states

* The list has to appear fast. If candidates fail, show an error card with a retry button.
* Brief and structure fail independently. A failed brief shows "Evidence sources unavailable" and the path graph still works.
* An empty candidate list with `LOW_GRAPH_COVERAGE` shows the warning and suggests a parent disease.

---

## 11. Hosting and config

### 11.1 Deploy targets

| Part | Host | Build / start |
|:-|:-|:-|
| Backend | Render web service (Railway or Fly.io also work) | `pip install -r requirements.txt` · `uvicorn api.main:app --host 0.0.0.0 --port $PORT` |
| Frontend | Vercel | `npm run build`, output `dist/`, SPA rewrite `/* → /index.html` |
| Artifacts | Committed under `artifacts/` if each file is < 100 MB. Otherwise upload to a Hugging Face dataset and download at startup | |

### 11.2 Never deployed

The raw OptimusKG parquet files, `venv/`, `cache/` (unless prewarmed on purpose), and `.env`.

### 11.3 Environment variables

| Var | Where | Required | Notes |
|:-|:-|:-|:-|
| `ANTHROPIC_API_KEY` | backend | yes | Host env only, never in the repo |
| `LLM_MODEL` | backend | no | Default `claude-opus-5-5` |
| `NCBI_API_KEY` | backend | no | Raises the PubMed limit to 10 req/s |
| `OPENFDA_API_KEY` | backend | no | Raises the openFDA daily limit |
| `ARTIFACT_DIR` | backend | no | Default `artifacts/` |
| `CACHE_DIR` | backend | no | Default `cache/` |
| `CORS_ORIGINS` | backend | yes | The Vercel URL(s) |
| `VITE_API_URL` | frontend | yes | Backend base URL |

---

## 12. Testing and demo readiness

* `tests/test_scoring.py`: a toy graph where the right answer is known by hand. Checks Path A ranking, the sibling path, family exclusion, and readiness tag priority.
* `tests/test_validator.py`: claims with missing or unknown source IDs are dropped.
* `tests/test_api.py`: every endpoint returns 200 and a valid schema on one known disease.
* `scripts/prewarm.py`: for each demo disease, calls candidates, then `/api/brief` and `/api/structures` for the top 10 drugs. That fills the disk cache, so the live demo makes no slow external calls.
* Before judging: open the deployed frontend on a phone and a laptop, run the full click path for each demo disease, and confirm `/validation` shows real numbers.

---

## 13. Known limitations (say these honestly if asked)

* The scores rank candidates. They are not probabilities.
* Graph coverage is weak for many rare diseases (§4.5).
* Name-based PubMed and trial searches can miss synonyms or pick up unrelated hits.
* AlphaFold structures are predictions. Low-pLDDT regions are unreliable.
* No dosing, no patient-level use. This is a research hypothesis generator, not medical advice.
