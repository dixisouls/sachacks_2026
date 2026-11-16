# Scaffold: the design run contract

The shared agreement between `api/` and `web/`. Both sides build against this
document. Changing anything here means telling the other side before you do it,
not after.

**Product name: Scaffold.** In medicinal chemistry the scaffold is the core you
keep while you change everything around it, which is what this does. The old
name, RepurposeKG, is gone from the interface.

---

## What a run is

One disease in, three designed molecules out. The three differ only in which
drugs the model was allowed to learn from:

| track | learns from | the question it answers |
|:-|:-|:-|
| `approved` | approved drugs for this disease | build on what is already safe in people |
| `investigational` | not-approved compounds | build on what others tried and dropped |
| `all` | both lists together | build on everything known |

The three run **at the same time**, in one job, over one event stream. Each
picks its own starting drug from its own pool, so they usually diverge
immediately.

After a track picks a winner, the workup runs on it: synthesis, ADMET,
off-target, and the case for taking it forward.

---

## Endpoints

```
POST /api/design/disease?disease_id=MONDO_0010726[&force=true]
  -> { job_id, status, cached }

GET  /api/design/{job_id}
  -> Job                       the whole thing, for reconnects

GET  /api/design/{job_id}/stream?since=0
  -> text/event-stream         live; `since` replays from an event index
```

The per-drug route stays as it is for the ranked-list tab:
`POST /api/design?drug_id=&disease_id=`.

---

## Shapes

```ts
type Pool = "approved" | "investigational" | "all";
type Status = "waiting" | "running" | "done" | "error";
type CheckStatus = "pass" | "warn" | "fail";

interface Job {
  job_id: string;
  status: "running" | "done" | "error";
  disease_id: string;
  disease_name: string;
  tracks: Record<Pool, Track>;   // always all three keys
  events: Event[];
  random_pass_rate?: number;     // 0.815: what passing the checks is worth
  error: string | null;
  cached: boolean;
}

interface Track {
  pool: Pool;
  label: string;                 // "Built on approved drugs"
  blurb: string;                 // one sentence, shown under the tab
  status: Status;
  seed: Seed | null;             // the drug it started from
  studied: { approved: number; investigational: number };
  pocket: { pdb_id: string; resolution_A: number | null } | null;
  proteins: Protein[];           // selectable in the viewer
  attempts: Attempt[];           // ranked best first once done
  best: Attempt | null;
  workup: Workup | null;
  error: string | null;
}

interface Seed {
  drug_id: string;
  name: string;
  smiles: string;
  score: number;
  check: Evaluation;             // the seed scored on the same checks
}

interface Protein {
  gene_id: string;
  symbol: string;
  uniprot_id: string | null;
  // true for the one protein a measured pose of the seed was found in, and
  // placed into. At most one protein per track has it. Every other protein has
  // false and a null pdb_id: the lookup stops at the first structure it finds,
  // so for the rest nothing is known and nothing is claimed.
  has_structure: boolean;
  pdb_id: string | null;         // always an RCSB entry; never an AlphaFold model
}

interface Attempt {
  id: string;                    // unique across the whole job
  track: Pool;
  round: number;
  name: string;
  rationale: string;
  builds_on: string;
  check: Evaluation;
}

interface Evaluation {           // unchanged from the current api/chemcheck.py
  smiles: string;
  valid: boolean;
  status: CheckStatus;
  summary: string;
  checks: Check[];
  properties: Record<string, unknown>;   // includes `pocket` when placed
  pose_sdf?: string;             // the molecule in the pocket, SDF
}

interface Check {
  id: string; label: string; status: CheckStatus;
  value: string; detail: string; problem: string;
}
```

### Workup

Runs once per track, on that track's winner. Every number in it is computed;
the model only explains. A section that could not be produced is `null`.

```ts
interface Workup {
  synthesis: {
    difficulty: string;          // "3.4 of 10, routine medicinal chemistry"
    steps: { n: number; what: string; why: string }[];
    note: string;
  } | null;

  admet: {
    items: {
      label: string;             // "Reaches the brain"
      value: string;             // "likely, CNS MPO 4.8 of 6"
      status: CheckStatus;
      detail: string;
    }[];
    note: string;
  } | null;

  offtarget: {
    items: {
      symbol: string;            // a protein similar to the target
      uniprot_id: string | null;
      identity: number;          // 0..1 sequence identity, from S.npz
      concern: string;           // what hitting it would mean
    }[];
    note: string;
  } | null;

  case: {
    verdict: string;             // one honest sentence
    for: string[];
    against: string[];
    next_step: string;           // the single experiment that would settle it
  } | null;
}
```

---

## Events

One stream carries all three tracks. Every event has `i` (replay index), `type`,
`at` (seconds since the run began), and **`track`** — the pool it belongs to, or
absent for job-level events.

| type | fields | meaning |
|:-|:-|:-|
| `phase` | `text` | job-level progress |
| `seed` | `track`, `seed` | the track chose its starting drug |
| `pocket` | `track`, `text`, `pocket?`, `proteins` | a measured pose was found, or was not |
| `round` | `track`, `n`, `of` | a round began |
| `thinking` | `track`, `text` | the reasoning so far, **resent whole as it grows** |
| `reasoning` | `track`, `round`, `text` | the finished reasoning for a round |
| `molecule` | `track`, `id`, `round`, `name`, `smiles`, `rationale`, `builds_on` | proposed, not yet judged |
| `verdict` | `track`, `id`, `status`, `summary`, `check` | judged |
| `note` | `track?`, `text` | anything worth saying |
| `best` | `track`, `id`, `name`, `status` | the track picked its winner |
| `workup_step` | `track`, `step`, `label`, `status`, `text?` | a workup section started or finished |
| `workup` | `track`, `kind`, `data` | a finished workup section |
| `track_done` | `track`, `tried`, `accepted` | a track finished |
| `done` | `tried`, `accepted` | every track finished |
| `error` | `track?`, `text` | something failed |
| `end` | `status` | **stream only**, never stored: nothing follows |

`workup_step.status` is `"running"` when a section starts and `"done"` or
`"error"` when it stops. A section that errored sends no `workup` event and
stays `null` on the track, and its `workup_step` carries `text`: the reason it
failed, written for a reader rather than for a log. `text` is present only on
an `"error"` step. Showing it is better than showing a shrug.
`workup.kind` is one of `synthesis`, `admet`,
`offtarget`, `case`, and `data` is that key's object, never null.

Rules the frontend can rely on:

- Events never arrive out of order and `i` never repeats.
- Exactly one `pocket` event per track, after its `seed` and before its first
  `round`, whether or not a structure was found. It carries that track's
  `proteins`, so the viewer never has to re-fetch the job to populate the
  protein selector.
- `pose_sdf` is one pose in one PDB entry's frame, the entry named by
  `properties.pocket.pdb_id`. There is no per-protein pose.
- An `Evaluation` carries a check with `id: "pocket"` only when that track found
  a measured position, which is to say only when its `pocket` is not null. With
  no structure there is nothing to place a molecule into, so nothing is claimed
  per molecule and the track says it once, in its `pocket` event and in
  `case.against`. Do not read a missing pocket check as a molecule that failed
  one: with no structure, a molecule can still pass every check.
- `case.against` always contains the three honest facts (nothing tests binding,
  most random molecules pass these checks, the pocket result is a placement and
  not a docking). The backend adds them in code; the model can lengthen that
  list but cannot shorten it.
- `since` is inclusive: the stream sends every event with `i >= since`.
- `POST` without `force` never starts a second run for a disease that already
  has one; it returns the running job, or a finished one with `cached: true`
  under a job id that is stable across restarts.
- A `molecule` always precedes its `verdict`. Render the card on `molecule` and
  flip it on `verdict`; that gap is the backtracking the run is meant to show.
- `thinking` carries the whole text each time, so replace rather than append.
  Show only the newest per track.
- One track failing does not stop the others. The job is `done` when all three
  have stopped, whatever state each reached.
- A heartbeat comment (`: still running`) arrives at least every 15 seconds.
  `EventSource` ignores it; it exists so Heroku does not hang up.

---

## Who owns what

- `api/`, `scripts/` — backend agent.
- `web/` — frontend agent.
- This file — whoever needs to change it, after telling the other.

Until the backend is ready, the frontend builds against this document and the
fixtures in `web/src/lib/fixtures`.
