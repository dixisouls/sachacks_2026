"use client";

// The one place in the product that shows a molecule nobody has made.
// It is kept apart from the ranked drugs on purpose: those are approved
// medicines with real safety records, this is a proposal. The run is shown
// as it happens, rejections included, because the discarded attempts are
// what make the accepted one mean anything.

import { useCallback, useEffect, useRef, useState } from "react";
import { designStreamUrl, getDesign, startDesign, USE_MOCKS } from "@/lib/api";
import type { CheckStatus, DesignAttempt, DesignEvaluation, DesignEvent, DesignJob } from "@/lib/types";
import ErrorCard from "./ErrorCard";
import Molecule2D from "./Molecule2D";

const TONE: Record<CheckStatus, { dot: string; chip: string; word: string }> = {
  pass: { dot: "bg-[#0B7A69]", chip: "bg-mint text-accent-ink", word: "Nothing wrong found" },
  warn: { dot: "bg-[#B07A00]", chip: "bg-[#FBEFD9] text-[#6B4A06]", word: "Questions" },
  fail: { dot: "bg-[#C8452A]", chip: "bg-[#FBE4DE] text-[#8A2A14]", word: "Rejected" },
};

export default function DesignPanel({
  drugId,
  diseaseId,
  drugName,
  diseaseName,
}: {
  drugId: string;
  diseaseId: string;
  drugName: string;
  diseaseName: string;
}) {
  const [job, setJob] = useState<DesignJob | null>(null);
  const [events, setEvents] = useState<DesignEvent[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // A run belongs to one drug. Opening another drug starts over.
  useEffect(() => {
    setJob(null);
    setEvents([]);
    setError(null);
    setOpen(null);
  }, [drugId, diseaseId]);

  useEffect(() => () => esRef.current?.close(), []);

  /** Follow a running job. Falls back to one last fetch if the stream cannot open. */
  const follow = useCallback((jobId: string) => {
    esRef.current?.close();
    const url = designStreamUrl(jobId, 0);
    if (!url) return;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (message) => {
      const event = JSON.parse(message.data) as DesignEvent;
      if (event.type === "end") {
        es.close();
        // the stream carries the story; this pulls the finished attempts and the winner
        getDesign(jobId).then(setJob).catch(() => {});
        return;
      }
      setEvents((prev) => (prev.some((e) => e.i === event.i) ? prev : [...prev, event]));
    };
    es.onerror = () => {
      es.close();
      getDesign(jobId)
        .then((latest) => {
          setJob(latest);
          setEvents(latest.events);
          if (latest.status === "running") setError("Lost the live connection. Showing the run so far.");
        })
        .catch(() => setError("Lost the connection to the design run."));
    };
  }, []);

  const begin = async (force = false) => {
    setStarting(true);
    setError(null);
    setEvents([]);
    try {
      const started = await startDesign(drugId, diseaseId, force);
      const latest = await getDesign(started.job_id);
      setJob(latest);
      setEvents(latest.events);
      if (latest.status === "running") follow(started.job_id);
    } catch (exc) {
      setError((exc as Error).message || "Could not start the design run.");
    } finally {
      setStarting(false);
    }
  };

  if (USE_MOCKS) {
    return (
      <Intro drugName={drugName} diseaseName={diseaseName}>
        <p className="rounded-3xl bg-[#FBEFD9] px-4 py-3 text-[14px] font-semibold text-[#6B4A06]">
          Designing needs the live backend and a Gemini key. The offline snapshot cannot run it.
        </p>
      </Intro>
    );
  }

  const running = job?.status === "running";
  // While it runs, the story is the event stream. Once done, the ranked attempts.
  const live = buildLive(events);
  const attempts = job && job.status !== "running" ? job.attempts : live.attempts;
  const best = job?.best ?? null;

  return (
    <div className="space-y-6">
      {!job && !running && (
        <Intro drugName={drugName} diseaseName={diseaseName}>
          <button
            onClick={() => begin(false)}
            disabled={starting}
            className="h-12 rounded-full bg-accent px-6 text-[15px] font-semibold text-white transition-colors hover:bg-accent-ink disabled:opacity-60"
          >
            {starting ? "Starting…" : `Design a molecule from ${drugName}`}
          </button>
        </Intro>
      )}

      {error && <ErrorCard msg="Design run problem" detail={error} onRetry={() => begin(true)} />}

      {(running || events.length > 0) && (
        <Progress events={events} running={!!running} drugName={drugName} />
      )}

      {best && (
        <section aria-labelledby="best-h" className="rounded-3xl bg-surface p-5 shadow-float sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="best-h" className="text-[18px] font-bold tracking-[-0.015em]">
              Best of {attempts.length}: {best.name}
            </h3>
            <Badge status={best.check.status} />
          </div>
          <AttemptBody attempt={best} big />
        </section>
      )}

      {(job?.parent?.check || job?.random_pass_rate != null) && (
        <WhatPassingMeans parent={job?.parent} rate={job?.random_pass_rate} />
      )}

      {attempts.length > 0 && (
        <section aria-labelledby="tried-h">
          <h3 id="tried-h" className="mb-1 text-[18px] font-bold tracking-[-0.015em]">
            Everything it tried
          </h3>
          <p className="mb-3 text-[14px] text-muted">
            {attempts.filter((a) => a.check.status === "pass").length} of {attempts.length} passed every
            check. The rejected ones are kept so you can see what the chemistry engine threw out.
          </p>
          <ul className="space-y-2">
            {attempts.map((attempt) => (
              <li key={attempt.id}>
                <AttemptRow
                  attempt={attempt}
                  isBest={best?.id === attempt.id}
                  open={open === attempt.id}
                  onToggle={() => setOpen(open === attempt.id ? null : attempt.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {job?.status === "done" && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted">
            {job.cached ? "A saved run, reused so nothing is spent repeating it." : "Run finished."}
          </p>
          <button
            onClick={() => begin(true)}
            className="h-10 rounded-full bg-soft-2 px-4 text-[14px] font-semibold text-accent-ink hover:bg-mint"
          >
            Design again
          </button>
        </div>
      )}

      {job?.status === "error" && (
        <ErrorCard msg="The design run failed" detail={job.error ?? undefined} onRetry={() => begin(true)} />
      )}
    </div>
  );
}

/** Rebuild the attempt list from the events, so the page fills in as the run goes. */
function buildLive(events: DesignEvent[]): { attempts: DesignAttempt[] } {
  const byId = new Map<string, DesignAttempt>();
  for (const event of events) {
    if (event.type === "molecule" && event.id) {
      byId.set(event.id, {
        id: event.id,
        round: event.round ?? 0,
        name: event.name ?? event.id,
        rationale: event.rationale ?? "",
        builds_on: event.builds_on ?? "",
        check: {
          smiles: event.smiles ?? "",
          valid: true,
          status: "warn",
          summary: "Checking…",
          checks: [],
          properties: {},
        },
      });
    }
    if (event.type === "verdict" && event.id && event.check) {
      const existing = byId.get(event.id);
      if (existing) byId.set(event.id, { ...existing, check: event.check });
    }
  }
  return { attempts: [...byId.values()] };
}

function Intro({ drugName, diseaseName, children }: { drugName: string; diseaseName: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div className="rounded-3xl bg-[#FBEFD9] px-4 py-3">
        <p className="text-[14px] font-bold text-[#6B4A06]">Designed by AI. Never made, never tested.</p>
        <p className="mt-1 text-[13.5px] leading-relaxed text-[#6B4A06]">
          Everything else in this product is an approved medicine with a real safety record. What this tab
          produces is a suggestion for a chemist, and nothing more. It is not a repurposing candidate.
        </p>
      </div>
      <div>
        <h3 className="text-[18px] font-bold tracking-[-0.015em]">
          Design a new molecule from {drugName}
        </h3>
        <p className="mt-1.5 max-w-[620px] text-[15px] leading-relaxed text-muted">
          Gemini studies {drugName}, the proteins it acts on, and every other drug ranked for{" "}
          {diseaseName} — approved and not approved alike — then proposes molecules over three rounds.
          After each round RDKit checks them and hands back what was wrong, so the next round is better
          informed. Takes a minute or two.
        </p>
        <p className="mt-2 max-w-[620px] text-[14px] leading-relaxed text-muted">
          The checks are a sieve, not a verdict. They catch structures that are not real chemistry,
          that copy an existing drug, or that no chemist could make. They cannot tell you whether a
          molecule binds anything, and 82% of random molecules pass them.
        </p>
      </div>
      {children}
    </div>
  );
}

function Progress({ events, running, drugName }: { events: DesignEvent[]; running: boolean; drugName: string }) {
  const scroller = useRef<HTMLOListElement>(null);
  // "thinking" is shown on its own line below, live; the rest is the record.
  const lines = events.filter(
    (e) => e.type !== "molecule" && e.type !== "verdict" && e.type !== "thinking",
  );
  const thinking = running ? [...events].reverse().find((e) => e.type === "thinking") : undefined;
  const round = [...events].reverse().find((e) => e.type === "round");
  const tried = events.filter((e) => e.type === "molecule").length;
  const verdicts = events.filter((e) => e.type === "verdict");
  const accepted = verdicts.filter((e) => e.status === "pass").length;
  const rejected = verdicts.filter((e) => e.status === "fail").length;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lines.length]);

  return (
    <section aria-label="Design progress" className="rounded-3xl bg-soft-2 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex items-center gap-2 text-[15px] font-bold">
          {running && <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
          {running
            ? round?.n
              ? `Round ${round.n} of ${round.of}, designing from ${drugName}`
              : `Studying ${drugName}`
            : "Run finished"}
        </p>
        <p className="text-[13px] tabular-nums text-muted" aria-live="polite">
          {tried} proposed · {accepted} accepted · {rejected} rejected
        </p>
      </div>
      <ol ref={scroller} className="mt-3 max-h-44 space-y-1.5 overflow-y-auto pr-1 text-[13.5px] leading-relaxed">
        {lines.map((event) => (
          <li key={event.i} className="flex gap-2.5">
            <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-faint">
              {event.at.toFixed(0)}s
            </span>
            <span className={event.type === "reasoning" ? "text-foreground" : "text-muted"}>
              {event.type === "round" ? `Round ${event.n} of ${event.of}` : event.text}
            </span>
          </li>
        ))}
      </ol>
      {thinking?.text && (
        <p className="mt-2 border-t border-border pt-2 text-[13.5px] leading-relaxed text-muted" aria-live="polite">
          {thinking.text}
          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-accent" />
        </p>
      )}
    </section>
  );
}

/** Passing these checks is a low bar. Saying so beside the result is the only
 *  way the result means anything: the starting drug clears them, and so does
 *  most of the drug table. */
function WhatPassingMeans({
  parent,
  rate,
}: {
  parent?: { name: string; smiles: string; check?: DesignEvaluation };
  rate?: number;
}) {
  const parentStatus = parent?.check?.status;
  return (
    <section aria-labelledby="bar-h" className="rounded-3xl bg-soft-2 p-4 sm:p-5">
      <h3 id="bar-h" className="text-[16px] font-bold tracking-[-0.015em]">
        What passing these checks is worth
      </h3>
      <dl className="mt-3 grid gap-4 sm:grid-cols-2">
        {parent?.check && (
          <div>
            <dt className="text-[13px] text-muted">The drug it was designed from</dt>
            <dd className="mt-1 flex items-center gap-2 text-[15px] font-semibold">
              {parent.name}
              {parentStatus && <Badge status={parentStatus} />}
            </dd>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              {parentStatus === "pass"
                ? `${parent.name} is an approved medicine and it clears every check too. A design that only matches it has not improved on anything.`
                : `${parent.name} does not clear every check itself, so a design that does has at least beaten its starting point on paper.`}
            </p>
          </div>
        )}
        {rate != null && (
          <div>
            <dt className="text-[13px] text-muted">Random unrelated molecules</dt>
            <dd className="mt-1 text-[15px] font-semibold tabular-nums">{Math.round(rate * 100)}% also pass</dd>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Measured over 200 molecules drawn at random from the drug table. These checks ask whether
              something is a plausible molecule, not whether it suits this protein. Nothing here tests
              binding, and nothing here tests safety.
            </p>
          </div>
        )}
      </dl>
    </section>
  );
}

function Badge({ status }: { status: CheckStatus }) {
  const tone = TONE[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold ${tone.chip}`}>
      <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
      {tone.word}
    </span>
  );
}

function AttemptRow({ attempt, isBest, open, onToggle }: {
  attempt: DesignAttempt;
  isBest: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const failed = attempt.check.status === "fail";
  return (
    <div className={`rounded-3xl transition-colors ${open ? "bg-surface shadow-soft" : "bg-soft-2"}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 font-mono text-[11.5px] text-muted">
          R{attempt.round}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className={`truncate text-[15px] font-bold ${failed ? "text-muted line-through decoration-[#C8452A]/50" : ""}`}>
              {attempt.name}
            </span>
            {isBest && (
              <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">best</span>
            )}
          </span>
          <span className="truncate text-[13px] text-muted">{attempt.check.summary}</span>
        </span>
        <Badge status={attempt.check.status} />
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" className={`shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <AttemptBody attempt={attempt} />
        </div>
      )}
    </div>
  );
}

function AttemptBody({ attempt, big = false }: { attempt: DesignAttempt; big?: boolean }) {
  const { check, rationale, builds_on: buildsOn } = attempt;
  const props = check.properties;
  return (
    <div className="mt-3 space-y-4">
      <div className={`grid gap-4 ${big ? "sm:grid-cols-[260px_1fr]" : "sm:grid-cols-[200px_1fr]"}`}>
        <div className="rounded-2xl bg-field p-2">
          <Molecule2D smiles={check.smiles} className="mx-auto h-44 w-full" />
        </div>
        <div className="min-w-0 space-y-2.5">
          {rationale && <p className="text-[15px] leading-relaxed">{rationale}</p>}
          {buildsOn && <p className="text-[13px] text-muted">Builds on {buildsOn}.</p>}
          <p className="break-all font-mono text-[11.5px] text-muted">{check.smiles}</p>
          {props.formula && (
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
              <Prop label="Formula" value={props.formula} />
              {props.mol_weight != null && <Prop label="Weight" value={`${props.mol_weight}`} />}
              {props.qed != null && <Prop label="Drug-likeness" value={props.qed.toFixed(2)} />}
              {props.sa_score != null && <Prop label="Ease of making" value={`${props.sa_score}/10`} />}
            </dl>
          )}
        </div>
      </div>

      {check.checks.length > 0 && (
        <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {check.checks.map((item) => (
            <li key={item.id} className="flex items-start gap-2 text-[13.5px]" title={item.detail}>
              <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${TONE[item.status].dot}`} />
              <span className="min-w-0">
                <span className={item.status === "pass" ? "" : "font-semibold"}>
                  {item.status === "pass" ? item.label : item.problem}
                </span>{" "}
                <span className="text-muted">{item.value}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex gap-1.5">
      <dt>{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </span>
  );
}
