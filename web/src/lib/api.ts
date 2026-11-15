// Typed fetchers for the endpoints in architecture.md §6.2.
// Set NEXT_PUBLIC_API_URL (web/.env.local) to the FastAPI backend, e.g. http://localhost:8000.
// Without it (or with NEXT_PUBLIC_USE_MOCKS=true) the app runs on the offline snapshot in ./mock.

import * as mock from "./mock";
import type {
  Brief,
  Comparison,
  CandidatesResponse,
  DiseaseHit,
  DiseaseSummary,
  EvalResult,
  PathsResponse,
} from "./types";

const BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
export const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "true" || !BASE;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, `Could not reach the backend at ${BASE}. Is it running?`);
  }
  if (!res.ok) {
    // backend errors look like {error, detail, request_id} (api/main.py)
    let detail = `${res.status} ${res.statusText}`;
    let rid: string | undefined;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      rid = body?.request_id;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, rid ? `${detail} (request ${rid})` : detail, rid);
  }
  return res.json() as Promise<T>;
}

const qs = (o: Record<string, string | number | boolean>) =>
  new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export function searchDiseases(q: string, limit = 10): Promise<DiseaseHit[]> {
  if (USE_MOCKS) return mock.mockSearch(q, limit);
  return request(`/api/diseases/search?${qs({ q, limit })}`);
}

export async function getDisease(id: string): Promise<DiseaseSummary> {
  if (USE_MOCKS) return (await mock.mockCandidates(id)).disease;
  return request(`/api/diseases/${encodeURIComponent(id)}`);
}

export function getCandidates(diseaseId: string, limit = 50): Promise<CandidatesResponse> {
  if (USE_MOCKS) return mock.mockCandidates(diseaseId);
  return request(`/api/diseases/${encodeURIComponent(diseaseId)}/candidates?${qs({ limit })}`);
}

export function getPaths(drugId: string, diseaseId: string): Promise<PathsResponse> {
  if (USE_MOCKS) return mock.mockPaths(drugId, diseaseId);
  return request(`/api/paths?${qs({ drug_id: drugId, disease_id: diseaseId })}`);
}

export async function getBrief(drugId: string, diseaseId: string): Promise<Brief> {
  if (USE_MOCKS) return mock.mockBrief(drugId, diseaseId);
  try {
    return await request<Brief>(`/api/brief`, {
      method: "POST",
      body: JSON.stringify({ drug_id: drugId, disease_id: diseaseId }),
    });
  } catch (e) {
    // /api/brief is not built yet (architecture.md step 6). Until it is, show a sample built from live paths.
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e;
    const [paths, cands] = await Promise.all([getPaths(drugId, diseaseId), getCandidates(diseaseId)]);
    const cand = [...cands.approved, ...cands.investigational].find((c) => c.drug_id === drugId);
    return mock.sampleBrief(drugId, diseaseId, paths, cand);
  }
}

/** Side-by-side structure comparison for a chemical look-alike pair. Needs the live backend (rdkit). */
export function getComparison(drugId: string, otherDrugId: string): Promise<Comparison> {
  if (USE_MOCKS) {
    return Promise.reject(new ApiError(0, "The structure comparison needs the live backend. Set NEXT_PUBLIC_API_URL."));
  }
  return request(`/api/compare?${qs({ drug_id: drugId, other_drug_id: otherDrugId })}`);
}

export function getEval(): Promise<EvalResult> {
  if (USE_MOCKS) return mock.mockEval();
  return request(`/api/eval`);
}
