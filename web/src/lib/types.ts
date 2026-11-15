// Mirrors the pydantic schemas in architecture.md §6.3 and the dicts returned by api/scoring.py.

export type MatchType = "exact" | "synonym" | "prefix" | "substring" | "synonym_substring";

export interface DiseaseHit {
  disease_id: string;
  name: string;
  match_type: MatchType;
  n_genes: number;
  therapeutic_areas: string[];
}

export interface DiseaseSummary {
  disease_id: string;
  name: string;
  n_genes: number;
  description: string | null;
  therapeutic_areas: string[];
}

export type PathType = "shared_biology" | "sibling_disease" | "chemical_analog" | "protein_homolog";

export type Readiness =
  | "APPROVED_UNTESTED"
  | "IN_TRIALS"
  | "OFF_LABEL"
  | "SAFETY_CONCERN"
  | "INVESTIGATIONAL"
  | "WITHDRAWN";

export interface Candidate {
  rank: number;
  drug_id: string;
  drug_name: string | null;
  score: number; // 0..100
  score_components: Record<PathType, number>;
  lead_path: PathType | null;
  inferred_only: boolean;
  readiness: Readiness;
  approved: boolean;
  max_phase: number | null;
  trial_phase: number | null;
  trial_ids: string[];
  top_gene_symbols: string[];
  year_approved: number | null;
  black_box: boolean;
}

export interface CandidatesResponse {
  disease: DiseaseSummary;
  approved: Candidate[];
  investigational: Candidate[];
  excluded_count: number;
  already_approved_total: number;
  family_size: number;
  weights?: Record<PathType, number>;
  layers?: { chemical_analog: boolean; protein_homolog: boolean };
  warning: string | null;
}

export interface PathNode {
  id: string;
  type: "drug" | "gene" | "disease";
  label: string | null;
  uniprot_id?: string | null;
}

export interface PathEdge {
  source: string;
  target: string;
  relation: string;
  weight: number | null;
  citation: string | null;
  inferred: boolean;
}

export interface Path {
  type: PathType;
  nodes: string[];
  contribution: number | null;
  inferred: boolean;
  similarity?: number | null;
  explanation: string;
}

export interface PathsResponse {
  nodes: PathNode[];
  edges: PathEdge[];
  paths: Path[];
}

export type EvidenceSource = "pubmed" | "clinicaltrials" | "openfda" | "chembl" | "graph";

export interface EvidenceItem {
  id: string;
  source: EvidenceSource;
  title: string;
  url: string;
  snippet: string | null;
  data: Record<string, unknown>;
}

export interface Claim {
  text: string;
  source_ids: string[];
}

export interface Brief {
  drug_id: string;
  disease_id: string;
  mechanism: Claim[];
  evidence_for: Claim[];
  evidence_against: Claim[];
  readiness: string;
  evidence: EvidenceItem[];
  dropped_claims: number;
  generated_at: string;
  model: string;
}

export type StructureMode = "BOUND" | "SEPARATE" | "DRUG_ONLY" | "NONE";

export interface StructurePlan {
  mode: StructureMode;
  drug: { format: "sdf"; file_url: string | null; smiles: string };
  protein: {
    source: "PDB" | "AlphaFold";
    id: string;
    format: "cif" | "pdb";
    file_url: string;
    uniprot_id: string;
    gene_symbol: string;
    mean_plddt: number | null;
  } | null;
  ligand_comp_id: string | null;
  resolution_A: number | null;
  caption: string;
}

export interface EvalMetrics {
  "hits@10": number;
  "hits@10_se"?: number;
  "hits@50": number;
  "hits@100"?: number;
  mrr: number;
  median_rank: number;
  scored_pairs?: number;
  unreachable?: number;
}

/** Shape of artifacts/eval.json written by scripts/rediscovery.py. */
export interface EvalResult {
  generated_at?: string;
  holdout_fraction?: number;
  positive_set?: { pairs: number; drugs: number; diseases: number };
  weights?: Record<string, number>;
  tuning?: { split_seed: number; pairs: number; grid_size: number };
  report_split_seed?: number;
  methods: Record<string, EvalMetrics>;
  not_recoverable?: number;
  diseases?: number;
}

/** GET /api/compare (api/compare.py): the chemical look-alike path, drawn. */
export interface MoleculeImage {
  drug_id: string;
  name: string;
  smiles: string;
  svg: string; // inline SVG, shared scaffold greyed, unique atoms coloured
  n_atoms: number;
  n_shared_atoms: number;
}

export interface Comparison {
  tanimoto: number; // flat 2D similarity, what scoring used
  tanimoto_stereo: number; // same comparison including handedness
  stereo_only_difference: boolean;
  shared_atoms: number;
  shared_smarts: string;
  left: MoleculeImage;
  right: MoleculeImage;
  caption: string;
}
