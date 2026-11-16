"use client";

// The run, as it happens.
//
// Three tracks, one stream, all three moving at once. Only one is on screen,
// so each tab carries its own live state: a track that is still working, one
// that has finished, and one that has failed all look different from across
// the room, and none of them is waiting on the others.

import { useState } from "react";
import ErrorCard from "@/components/ErrorCard";
import { POOLS } from "@/lib/run";
import type { Pool } from "@/lib/run";
import type { Run } from "@/lib/useRun";
import TrackPanel from "./TrackPanel";

export default function RunView({ run }: { run: Run }) {
  const { job, state, link, error } = run;
  const [pool, setPool] = useState<Pool>("approved");
  const live = state.tracks[pool];
  const track = job?.tracks?.[pool];
  const allFailed = state.status !== "running" && POOLS.every((p) => state.tracks[p].status === "error");

  // Arrow keys move the selection and the focus together, so the tab that is
  // announced is the tab that is showing.
  const move = (delta: number) => {
    const next = POOLS[(POOLS.indexOf(pool) + delta + POOLS.length) % POOLS.length];
    setPool(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <div className="space-y-5">
      <p className="max-w-[72ch] text-[14.5px] leading-relaxed text-muted">
        <span className="font-semibold text-foreground">These molecules have never been made.</span> Three tracks are
        designing at the same time, each allowed to learn from a different set of existing drugs, and each keeps
        whatever survives its own checks. Passing those checks is a low bar, and it is spelled out beside every result.
      </p>

      {state.phase && state.status === "running" && (
        <p className="flex items-center gap-2.5 text-[15px] font-semibold" aria-live="polite">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {state.phase}
        </p>
      )}

      <div>
        <div
          role="tablist"
          aria-label="Design tracks"
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              move(-1);
            }
          }}
          className="grid gap-1 rounded-[28px] bg-soft p-1 sm:grid-cols-3"
        >
          {POOLS.map((p) => {
            const t = state.tracks[p];
            const stored = job?.tracks?.[p];
            const active = p === pool;
            return (
              <button
                key={p}
                role="tab"
                id={`tab-${p}`}
                aria-selected={active}
                aria-controls={`panel-${p}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setPool(p)}
                className={`flex flex-col items-start gap-1 rounded-[24px] px-3.5 py-2.5 text-left transition-colors ${
                  active ? "bg-surface shadow-soft" : "hover:bg-soft-2"
                }`}
              >
                <span className={`text-[14.5px] font-bold leading-tight ${active ? "" : "text-muted"}`}>
                  {/* the label is the backend's, never the interface's */}
                  {stored?.label ?? p}
                </span>
                <TrackPip status={t.status} tried={t.tried} accepted={t.accepted} round={t.round} />
              </button>
            );
          })}
        </div>
        {track?.blurb && (
          <p className="mt-2.5 max-w-[70ch] px-1 text-[14px] leading-relaxed text-muted">{track.blurb}</p>
        )}
      </div>

      {(link === "retrying" || link === "offline" || link === "closed") && (
        <p className="px-1 text-[13px] text-muted" aria-live="polite">
          {link === "retrying" && "Lost the live connection. Reconnecting, and nothing already shown will be lost."}
          {link === "offline" &&
            "No backend is configured, so this is a saved run being replayed at the speed it happened."}
          {link === "closed" && state.status === "running" && "The stream closed. Reload to pick the run back up."}
        </p>
      )}

      {error && link === "failed" && (
        <ErrorCard msg="The design run could not be followed" detail={error} onRetry={run.retry} />
      )}

      {state.error && <ErrorCard msg="The run failed" detail={state.error} onRetry={run.again} />}

      {/* Every track failing still counts as a finished job, so without this
          the page is three separate error cards and a cheerful line about a
          saved run. Say it once, at the top, with the way out. */}
      {allFailed && (
        <ErrorCard
          msg="All three tracks stopped early"
          detail="Nothing was designed for this disease. Each track's own reason is on its tab. This is usually the model being unavailable rather than the disease being impossible, so it is worth designing again."
          onRetry={run.again}
        />
      )}

      <div role="tabpanel" id={`panel-${pool}`} aria-labelledby={`tab-${pool}`} className="pt-1">
        <TrackPanel key={pool} live={live} track={track} rate={job?.random_pass_rate} />
      </div>

      {state.status !== "running" && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <p className="text-[13px] text-muted">
            {allFailed
              ? "This run is saved as it stands, so opening the page again will show the same failure until you design again."
              : job?.cached
                ? "A saved run, reused so nothing is spent repeating it."
                : "Run finished. Every attempt above is kept."}
          </p>
          {link !== "offline" && (
            <button
              onClick={run.again}
              className="h-10 rounded-full bg-soft-2 px-4 text-[14px] font-semibold text-accent-ink transition-colors hover:bg-mint"
            >
              Design again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A track's state, small enough to sit on a tab that is not selected. */
function TrackPip({
  status,
  tried,
  accepted,
  round,
}: {
  status: "waiting" | "running" | "done" | "error";
  tried: number;
  accepted: number;
  round: { n: number; of: number } | null;
}) {
  const word =
    status === "waiting"
      ? "waiting to start"
      : status === "running"
        ? round
          ? `round ${round.n} of ${round.of}, ${tried} proposed`
          : `${tried} proposed`
        : status === "error"
          ? "stopped early"
          : `${accepted} of ${tried} kept`;

  return (
    <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
      {status === "running" ? (
        <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      ) : (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            status === "done" ? "bg-accent" : status === "error" ? "bg-[#C8452A]" : "bg-line-strong"
          }`}
        />
      )}
      {word}
    </span>
  );
}
