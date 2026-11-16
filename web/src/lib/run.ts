// The design run: one disease in, three molecules out.
//
// These shapes are DESIGN_API.md, transcribed. Nothing here may be invented —
// if the frontend needs a field that is not in this file, the contract has to
// change first, and the backend agent has to agree to it.

import type { CheckStatus, DesignEvaluation } from "./types";

/** Which drugs the model was allowed to learn from. */
export type Pool = "approved" | "investigational" | "all";
export const POOLS: Pool[] = ["approved", "investigational", "all"];

export type TrackStatus = "waiting" | "running" | "done" | "error";
export type RunStatus = "running" | "done" | "error";
export type StepStatus = "running" | "done" | "error";
export type WorkupKind = "synthesis" | "admet" | "offtarget" | "case";
export const WORKUP_KINDS: WorkupKind[] = ["synthesis", "admet", "offtarget", "case"];

/** The drug a track started from, scored on the same checks as its designs. */
export interface Seed {
  drug_id: string;
  name: string;
  smiles: string;
  score: number;
  check: DesignEvaluation;
}

/**
 * A protein the seed acts on. At most one per track has `has_structure`, and
 * that one is the pocket every molecule in the track was placed into; the rest
 * carry `pdb_id: null`, because no structure was looked up for them at all.
 */
export interface Protein {
  gene_id: string;
  symbol: string;
  uniprot_id: string | null;
  has_structure: boolean;
  pdb_id: string | null;
}

export interface Pocket {
  pdb_id: string;
  resolution_A: number | null;
}

export interface Attempt {
  id: string;
  track: Pool;
  round: number;
  name: string;
  rationale: string;
  builds_on: string;
  check: DesignEvaluation;
}

export interface WorkupSynthesis {
  difficulty: string;
  steps: { n: number; what: string; why: string }[];
  note: string;
}

export interface WorkupAdmet {
  items: { label: string; value: string; status: CheckStatus; detail: string }[];
  note: string;
}

export interface WorkupOffTarget {
  items: { symbol: string; uniprot_id: string | null; identity: number; concern: string }[];
  note: string;
}

export interface WorkupCase {
  verdict: string;
  for: string[];
  against: string[];
  next_step: string;
}

export interface Workup {
  synthesis: WorkupSynthesis | null;
  admet: WorkupAdmet | null;
  offtarget: WorkupOffTarget | null;
  case: WorkupCase | null;
}

export const EMPTY_WORKUP: Workup = { synthesis: null, admet: null, offtarget: null, case: null };

export interface Track {
  pool: Pool;
  /** Shown on the tab. Comes from the backend; the UI never writes its own. */
  label: string;
  /** One sentence under the tab, same rule. */
  blurb: string;
  status: TrackStatus;
  seed: Seed | null;
  studied: { approved: number; investigational: number };
  pocket: Pocket | null;
  proteins: Protein[];
  /** Ranked best first once the track is done. */
  attempts: Attempt[];
  best: Attempt | null;
  workup: Workup | null;
  error: string | null;
}

export interface Job {
  job_id: string;
  status: RunStatus;
  disease_id: string;
  disease_name: string;
  tracks: Record<Pool, Track>;
  events: RunEvent[];
  /** Share of random molecules that also pass every check. The point of the run. */
  random_pass_rate?: number;
  error: string | null;
  cached: boolean;
}

export interface JobStart {
  job_id: string;
  status: RunStatus;
  cached: boolean;
}

export type EventType =
  | "phase"
  | "seed"
  | "pocket"
  | "round"
  | "thinking"
  | "reasoning"
  | "molecule"
  | "verdict"
  | "note"
  | "best"
  | "workup_step"
  | "workup"
  | "track_done"
  | "done"
  | "error"
  | "end";

/**
 * One line of the run. `i` is the replay index and never repeats; `track` is
 * the pool it belongs to, absent for job-level events. Fields are optional
 * because one event type uses a handful of them, not because they are unknown:
 * the table in DESIGN_API.md says which arrive with which type.
 */
export interface RunEvent {
  i: number;
  type: EventType;
  at: number;
  track?: Pool;
  text?: string;
  seed?: Seed;
  pocket?: Pocket;
  proteins?: Protein[];
  n?: number;
  of?: number;
  round?: number;
  id?: string;
  name?: string;
  smiles?: string;
  rationale?: string;
  builds_on?: string;
  /** A verdict's CheckStatus, a workup_step's StepStatus, or `end`'s run status. */
  status?: CheckStatus | StepStatus | RunStatus;
  summary?: string;
  check?: DesignEvaluation;
  kind?: WorkupKind;
  step?: number;
  label?: string;
  data?: unknown;
  tried?: number;
  accepted?: number;
}
