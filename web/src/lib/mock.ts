// Offline backend used when NEXT_PUBLIC_API_URL is not set.
// Search, candidates, paths and eval come from a real snapshot of the FastAPI backend
// (src/lib/fixtures, captured from api/main.py for the three demo diseases).
// The brief is still a SAMPLE: /api/brief does not exist yet.

import type {
  Brief,
  Candidate,
  CandidatesResponse,
  DiseaseHit,
  EvalResult,
  PathsResponse,
} from "./types";
import { softenNames } from "./format";

type Snapshot = {
  diseases: DiseaseHit[];
  candidates: Record<string, CandidatesResponse>;
  paths: Record<string, PathsResponse>;
};

let snap: Promise<Snapshot> | null = null;
// code-split: the snapshot only loads when mocks are actually used
const load = () => (snap ??= import("./fixtures/snapshot.json").then((m) => m.default as unknown as Snapshot));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockSearch(q: string, limit = 10): Promise<DiseaseHit[]> {
  const [{ diseases }] = await Promise.all([load(), sleep(120)]);
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const rank = (h: DiseaseHit) => {
    const n = h.name.toLowerCase();
    if (n === s) return 0;
    if (n.startsWith(s)) return 2;
    if (n.includes(s)) return 3;
    return -1;
  };
  return diseases
    .map((h) => ({ h, r: rank(h) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || b.h.n_genes - a.h.n_genes)
    .slice(0, limit)
    .map((x) => ({ ...x.h, match_type: (["exact", "synonym", "prefix", "substring"] as const)[x.r] }));
}

export async function mockCandidates(diseaseId: string): Promise<CandidatesResponse> {
  const [{ candidates }] = await Promise.all([load(), sleep(250)]);
  const c = candidates[diseaseId];
  if (!c) throw new Error("The offline demo only covers the three example diseases. Connect the backend for the rest.");
  return c;
}

export async function mockPaths(drugId: string, diseaseId: string): Promise<PathsResponse> {
  const [{ paths }] = await Promise.all([load(), sleep(200)]);
  const p = paths[`${drugId}|${diseaseId}`];
  if (!p) throw new Error("Paths for this drug are not in the offline snapshot.");
  return p;
}

export async function mockEval(): Promise<EvalResult> {
  const [m] = await Promise.all([import("./fixtures/eval.json"), sleep(120)]);
  return m.default as unknown as EvalResult;
}

/** SAMPLE brief built only from real path data and trial ids. No literature search happens here.
 *  Used until the backend exposes /api/brief. */
export function sampleBrief(drugId: string, diseaseId: string, p: PathsResponse | undefined, cand: Candidate | undefined): Brief {
  const evidence: Brief["evidence"] = [];
  const mechanism: Brief["mechanism"] = [];
  for (const path of (p?.paths ?? []).filter((x) => !x.inferred).slice(0, 3)) {
    const [a, b] = path.nodes;
    const id = `KG:${a}|${b}`;
    if (!evidence.some((e) => e.id === id)) {
      evidence.push({ id, source: "graph", title: softenNames(path.explanation, p?.nodes ?? []), url: "", snippet: "OptimusKG edge", data: {} });
    }
    mechanism.push({ text: softenNames(path.explanation, p?.nodes ?? []) + ".", source_ids: [id] });
  }
  const trials = cand?.trial_ids ?? [];
  for (const t of trials.slice(0, 2)) {
    evidence.push({ id: t, source: "clinicaltrials", title: `Registered trial ${t}`, url: `https://clinicaltrials.gov/study/${t}`, snippet: null, data: {} });
  }
  return {
    drug_id: drugId,
    disease_id: diseaseId,
    mechanism,
    evidence_for: trials.length
      ? [{ text: trials.length === 1 ? "This pair already has a registered trial." : `This pair already has ${trials.length} registered trials.`, source_ids: trials.slice(0, 2) }]
      : [],
    evidence_against: [],
    readiness: cand?.readiness ?? "APPROVED_UNTESTED",
    evidence,
    dropped_claims: 0,
    generated_at: new Date().toISOString(),
    model: "sample, brief endpoint not built yet",
  };
}

export async function mockBrief(drugId: string, diseaseId: string): Promise<Brief> {
  const [s] = await Promise.all([load(), sleep(1600)]);
  const c = s.candidates[diseaseId];
  const cand = [...(c?.approved ?? []), ...(c?.investigational ?? [])].find((x) => x.drug_id === drugId);
  return sampleBrief(drugId, diseaseId, s.paths[`${drugId}|${diseaseId}`], cand);
}
