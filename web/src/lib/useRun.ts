"use client";

// Following a design run: one EventSource, three tracks.
//
// The stream carries every track at once, so there is exactly one connection
// and the reducer sorts events into tracks by `event.track`. Three rules from
// DESIGN_API.md are load-bearing here:
//
//   - `i` never repeats and never arrives out of order, so a dedupe on the
//     highest index seen makes replays idempotent. That is what lets a
//     reconnect ask for `since=lastSeen+1` and not care whether the backend
//     treats it as inclusive (it does) or exclusive.
//   - `thinking` resends the whole text as it grows, so it replaces.
//   - one track failing does not stop the others, so an error is recorded on
//     the track it belongs to and nowhere else.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { getRun, runStreamUrl, startRun, USE_MOCKS } from "./api";
import { fixtureJob } from "./fixtures/run";
import { EMPTY_WORKUP, POOLS } from "./run";
import type { Job, Pocket, Pool, Protein, RunEvent, RunStatus, Seed, StepStatus, TrackStatus, Workup, WorkupAdmet, WorkupCase, WorkupKind, WorkupOffTarget, WorkupSynthesis } from "./run";
import type { CheckStatus, DesignEvaluation } from "./types";

/** A molecule on screen: proposed first, judged a moment later. */
export interface LiveMolecule {
  id: string;
  round: number;
  name: string;
  smiles: string;
  rationale: string;
  builds_on: string;
  /** "pending" until its verdict arrives. The gap is the point. */
  status: CheckStatus | "pending";
  summary: string;
  check: DesignEvaluation | null;
  at: number;
}

export interface LogLine {
  i: number;
  at: number;
  text: string;
  kind: RunEvent["type"];
}

export interface TrackState {
  pool: Pool;
  status: TrackStatus;
  seed: Seed | null;
  pocket: Pocket | null;
  /** The pocket event's own words, which say either what was found or why not. */
  pocketNote: string;
  proteins: Protein[];
  round: { n: number; of: number } | null;
  thinking: string;
  lines: LogLine[];
  /** Molecule ids in the order they were proposed. */
  order: string[];
  molecules: Record<string, LiveMolecule>;
  bestId: string | null;
  workup: Workup;
  /** Each workup section's progress, and the reason when one failed. */
  steps: Partial<Record<WorkupKind, { label: string; status: StepStatus; note?: string }>>;
  tried: number;
  accepted: number;
  error: string | null;
}

export interface RunState {
  lastIndex: number;
  status: RunStatus;
  phase: string;
  error: string | null;
  tracks: Record<Pool, TrackState>;
}

/** How the live link is doing. Shown, because a silent stall is worse. */
export type Link = "starting" | "live" | "retrying" | "closed" | "offline" | "failed";

function emptyTrack(pool: Pool): TrackState {
  return {
    pool,
    status: "waiting",
    seed: null,
    pocket: null,
    pocketNote: "",
    proteins: [],
    round: null,
    thinking: "",
    lines: [],
    order: [],
    molecules: {},
    bestId: null,
    workup: { ...EMPTY_WORKUP },
    steps: {},
    tried: 0,
    accepted: 0,
    error: null,
  };
}

function emptyRun(): RunState {
  return {
    lastIndex: -1,
    status: "running",
    phase: "",
    error: null,
    tracks: {
      approved: emptyTrack("approved"),
      investigational: emptyTrack("investigational"),
      all: emptyTrack("all"),
    },
  };
}

type Action = { type: "reset" } | { type: "hydrate"; job: Job } | { type: "event"; event: RunEvent };

const LINE_TYPES = new Set<RunEvent["type"]>(["pocket", "note", "reasoning", "round", "best", "track_done", "error"]);

/** The words a log line shows for the events that become one. */
function lineText(event: RunEvent): string {
  if (event.type === "round") return `Round ${event.n} of ${event.of} began`;
  if (event.type === "best") return `Kept ${event.name ?? event.id} and moved to the workup`;
  if (event.type === "track_done") {
    const tried = event.tried ?? 0;
    const accepted = event.accepted ?? 0;
    return `Finished: ${accepted} of ${tried} ${tried === 1 ? "molecule" : "molecules"} passed every check`;
  }
  return event.text ?? "";
}

function applyEvent(state: RunState, event: RunEvent): RunState {
  // Replays are idempotent: anything at or below the highest index is already in.
  if (event.i <= state.lastIndex) return state;
  const next: RunState = { ...state, lastIndex: event.i };

  // Job-level events carry no track.
  if (!event.track) {
    switch (event.type) {
      case "phase":
        return { ...next, phase: event.text ?? "" };
      case "note":
        return { ...next, phase: event.text ?? next.phase };
      case "done":
        return { ...next, status: "done" };
      case "error":
        return { ...next, status: "error", error: event.text ?? "The run failed." };
      default:
        return next;
    }
  }

  const pool = event.track;
  const track = { ...next.tracks[pool] };
  track.status = track.status === "waiting" ? "running" : track.status;

  switch (event.type) {
    case "seed":
      if (event.seed) track.seed = event.seed;
      break;
    case "pocket":
      track.pocket = event.pocket ?? null;
      track.pocketNote = event.text ?? "";
      // The one event that carries the selectable proteins.
      if (event.proteins) track.proteins = event.proteins;
      break;
    case "round":
      if (event.n != null && event.of != null) track.round = { n: event.n, of: event.of };
      // A new round means the previous round's thinking is spent.
      track.thinking = "";
      break;
    case "thinking":
      // Resent whole as it grows, so it replaces rather than appends.
      track.thinking = event.text ?? "";
      break;
    case "molecule":
      if (event.id) {
        track.molecules = {
          ...track.molecules,
          [event.id]: {
            id: event.id,
            round: event.round ?? track.round?.n ?? 0,
            name: event.name ?? event.id,
            smiles: event.smiles ?? "",
            rationale: event.rationale ?? "",
            builds_on: event.builds_on ?? "",
            status: "pending",
            summary: "",
            check: null,
            at: event.at,
          },
        };
        if (!track.order.includes(event.id)) track.order = [...track.order, event.id];
        track.tried += 1;
      }
      break;
    case "verdict": {
      const id = event.id;
      const existing = id ? track.molecules[id] : undefined;
      if (id && existing) {
        const status = (event.status ?? existing.check?.status ?? "warn") as CheckStatus;
        track.molecules = {
          ...track.molecules,
          [id]: { ...existing, status, summary: event.summary ?? "", check: event.check ?? existing.check },
        };
        if (status === "pass") track.accepted += 1;
      }
      break;
    }
    case "best":
      track.bestId = event.id ?? null;
      break;
    case "workup_step":
      if (event.kind) {
        track.steps = {
          ...track.steps,
          [event.kind]: {
            label: event.label ?? event.kind,
            status: (event.status ?? "running") as StepStatus,
            // a failed section says why, when the backend gives a reason
            note: event.text,
          },
        };
      }
      break;
    case "workup":
      // `data` is the Workup key named by `kind`, and is never null: a section
      // that failed sends no workup event at all, only a step with "error".
      if (event.kind && event.data != null) {
        const workup: Workup = { ...track.workup };
        if (event.kind === "synthesis") workup.synthesis = event.data as WorkupSynthesis;
        if (event.kind === "admet") workup.admet = event.data as WorkupAdmet;
        if (event.kind === "offtarget") workup.offtarget = event.data as WorkupOffTarget;
        if (event.kind === "case") workup.case = event.data as WorkupCase;
        track.workup = workup;
      }
      break;
    case "track_done":
      track.status = track.error ? "error" : "done";
      track.thinking = "";
      if (event.tried != null) track.tried = Math.max(track.tried, event.tried);
      if (event.accepted != null) track.accepted = Math.max(track.accepted, event.accepted);
      break;
    case "error":
      track.error = event.text ?? "This track failed.";
      track.status = "error";
      track.thinking = "";
      break;
    default:
      break;
  }

  if (LINE_TYPES.has(event.type)) {
    const text = lineText(event);
    if (text) track.lines = [...track.lines, { i: event.i, at: event.at, text, kind: event.type }];
  }

  return { ...next, tracks: { ...next.tracks, [pool]: track } };
}

/**
 * Rebuild everything from a fetched Job. The Job is authoritative — it carries
 * the whole event list, so replaying it reconstructs the live view exactly as
 * the stream would have, and whatever the tracks already settled on wins.
 */
function fromJob(job: Job): RunState {
  let state = emptyRun();
  state.status = job.status;
  state.error = job.error;
  for (const event of job.events) state = applyEvent(state, event);

  const tracks = { ...state.tracks };
  for (const pool of POOLS) {
    const stored = job.tracks[pool];
    if (!stored) continue;
    const track = { ...tracks[pool] };
    // Stored fields beat replayed ones: proteins and the seed survive a
    // reconnect this way even if the events that announced them are gone.
    track.status = stored.status;
    track.seed = stored.seed ?? track.seed;
    track.pocket = stored.pocket ?? track.pocket;
    track.proteins = stored.proteins?.length ? stored.proteins : track.proteins;
    track.error = stored.error ?? track.error;
    if (stored.workup) {
      track.workup = {
        synthesis: stored.workup.synthesis ?? track.workup.synthesis,
        admet: stored.workup.admet ?? track.workup.admet,
        offtarget: stored.workup.offtarget ?? track.workup.offtarget,
        case: stored.workup.case ?? track.workup.case,
      };
    }
    track.bestId = stored.best?.id ?? track.bestId;
    // A finished track's ranked attempts fill in any verdict the stream missed.
    for (const attempt of stored.attempts ?? []) {
      const live = track.molecules[attempt.id];
      if (live && live.status !== "pending") continue;
      track.molecules = {
        ...track.molecules,
        [attempt.id]: {
          id: attempt.id,
          round: attempt.round,
          name: attempt.name,
          smiles: attempt.check.smiles,
          rationale: attempt.rationale,
          builds_on: attempt.builds_on,
          status: attempt.check.status,
          summary: attempt.check.summary,
          check: attempt.check,
          at: live?.at ?? 0,
        },
      };
      if (!track.order.includes(attempt.id)) track.order = [...track.order, attempt.id];
    }
    const tried = track.order.length;
    track.tried = Math.max(track.tried, tried);
    track.accepted = Math.max(
      track.accepted,
      track.order.filter((id) => track.molecules[id]?.status === "pass").length,
    );
    tracks[pool] = track;
  }
  return { ...state, tracks };
}

function reduce(state: RunState, action: Action): RunState {
  switch (action.type) {
    case "reset":
      return emptyRun();
    case "hydrate":
      return fromJob(action.job);
    case "event":
      return applyEvent(state, action.event);
  }
}

const highestIndex = (events: RunEvent[]) => events.reduce((n, e) => (e.i > n ? e.i : n), -1);

/** Replay speed for the offline snapshot, so a 90 second run plays in a few. */
const MOCK_SPEED = 12;

export interface Run {
  job: Job | null;
  state: RunState;
  link: Link;
  error: string | null;
  /** Start over from scratch, spending a new run rather than reusing the cache. */
  again: () => void;
  retry: () => void;
}

export function useRun(diseaseId: string): Run {
  const [state, dispatch] = useReducer(reduce, undefined, emptyRun);
  const [job, setJob] = useState<Job | null>(null);
  const [link, setLink] = useState<Link>("starting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const force = useRef(false);

  const again = useCallback(() => {
    force.current = true;
    setAttempt((n) => n + 1);
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!diseaseId) return;
    let cancelled = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let tries = 0;
    let ended = false;
    const seen = { i: -1 };
    const forced = force.current;
    force.current = false;

    dispatch({ type: "reset" });
    setJob(null);
    setError(null);
    setLink("starting");

    const take = (job: Job) => {
      setJob(job);
      dispatch({ type: "hydrate", job });
      seen.i = Math.max(seen.i, highestIndex(job.events));
    };

    // No backend: replay the saved run so the view still works end to end.
    if (USE_MOCKS) {
      const { initial, events, final } = fixtureJob(diseaseId);
      setJob(initial);
      setLink("offline");
      for (const event of events) {
        timers.push(
          setTimeout(() => {
            if (cancelled) return;
            seen.i = event.i;
            dispatch({ type: "event", event });
          }, (event.at * 1000) / MOCK_SPEED),
        );
      }
      timers.push(
        setTimeout(
          () => {
            if (!cancelled) take(final);
          },
          (highestIndex(events) >= 0 ? (events[events.length - 1].at * 1000) / MOCK_SPEED : 0) + 400,
        ),
      );
      return () => {
        cancelled = true;
        for (const t of timers) clearTimeout(t);
      };
    }

    const connect = (jobId: string) => {
      if (cancelled) return;
      const url = runStreamUrl(jobId, seen.i + 1);
      if (!url) return;
      const stream = new EventSource(url);
      source = stream;

      stream.onopen = () => {
        if (!cancelled) setLink("live");
      };

      stream.onmessage = (message) => {
        if (cancelled) return;
        let event: RunEvent;
        try {
          event = JSON.parse(message.data) as RunEvent;
        } catch {
          return;
        }
        tries = 0;
        if (event.type === "end") {
          // Never stored, so nothing replays it: close cleanly and take the
          // finished job, which carries the ranked attempts and the workup.
          ended = true;
          stream.close();
          setLink("closed");
          getRun(jobId)
            .then((latest) => !cancelled && take(latest))
            .catch(() => {});
          return;
        }
        setLink("live");
        if (event.i > seen.i) seen.i = event.i;
        dispatch({ type: "event", event });
      };

      stream.onerror = () => {
        stream.close();
        if (cancelled || ended) return;
        tries += 1;
        if (tries > 6) {
          setLink("failed");
          setError("Lost the live connection. This is the run as far as it got.");
          getRun(jobId)
            .then((latest) => !cancelled && take(latest))
            .catch(() => {});
          return;
        }
        setLink("retrying");
        timer = setTimeout(
          () => {
            if (cancelled) return;
            // Refresh from the job first: it is authoritative, and it tells us
            // whether the run is even still going before we reopen the stream.
            getRun(jobId)
              .then((latest) => {
                if (cancelled) return;
                take(latest);
                if (latest.status === "running") connect(jobId);
                else setLink("closed");
              })
              .catch(() => !cancelled && connect(jobId));
          },
          Math.min(8000, 500 * 2 ** (tries - 1)),
        );
      };
    };

    (async () => {
      try {
        const started = await startRun(diseaseId, forced);
        if (cancelled) return;
        const first = await getRun(started.job_id);
        if (cancelled) return;
        take(first);
        if (first.status === "running") connect(started.job_id);
        else setLink("closed");
      } catch (exc) {
        if (cancelled) return;
        setLink("failed");
        setError((exc as Error).message || "Could not start the design run.");
      }
    })();

    return () => {
      cancelled = true;
      source?.close();
      clearTimeout(timer);
      for (const t of timers) clearTimeout(t);
    };
  }, [diseaseId, attempt]);

  return { job, state, link, error, again, retry };
}
