"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { memo, useCallback, useState } from "react";
import { getPaths } from "@/lib/api";
import { drugLabel, PATH_LABEL, PATH_SHORT } from "@/lib/format";
import type { Candidate } from "@/lib/types";
import ReadinessDot from "./ReadinessDot";
import ScoreRing from "./ScoreRing";

/** Rows show a page at a time, with "Show more" below: 6 per page on phones, 10 on laptops and up. */
const PHONE_STEP = 6;
const DESKTOP_STEP = 10;

/** Enough pages of `step` to include row `index` (so a selected drug ranked further down stays visible). */
const pagesFor = (index: number, step: number) => Math.max(step, Math.ceil((index + 1) / step) * step);

export default function CandidateList({
  items,
  diseaseId,
  selected,
  empty,
}: {
  items: Candidate[];
  diseaseId: string;
  selected?: string;
  empty: string;
}) {
  // start with the selected drug in view, even when it ranks below the first page
  const selIndex = items.findIndex((c) => c.drug_id === selected);
  const [phoneShown, setPhoneShown] = useState(() => pagesFor(selIndex, PHONE_STEP));
  const [deskShown, setDeskShown] = useState(() => pagesFor(selIndex, DESKTOP_STEP));
  // load a drug's paths as soon as the pointer or keyboard lands on it, so opening it feels instant
  const qc = useQueryClient();
  const prefetch = useCallback(
    (drugId: string) => qc.prefetchQuery({ queryKey: ["paths", diseaseId, drugId], queryFn: () => getPaths(drugId, diseaseId) }),
    [qc, diseaseId],
  );
  if (!items.length) return <p className="px-3 py-8 text-[15px] text-muted">{empty}</p>;
  // each breakpoint hides its own overflow; max-sm = phones, sm = laptops and up
  const rowClass = (i: number) =>
    [i >= phoneShown && "max-sm:hidden", i >= deskShown && "sm:hidden"].filter(Boolean).join(" ") || undefined;
  return (
    <>
    <ol className="flex flex-col gap-1">
      {items.map((c, i) => (
        <li key={c.drug_id} className={rowClass(i)}>
          <Row c={c} diseaseId={diseaseId} isSel={c.drug_id === selected} onIntent={prefetch} />
        </li>
      ))}
    </ol>
    <ShowMore remaining={items.length - phoneShown} step={PHONE_STEP} onClick={() => setPhoneShown((n) => n + PHONE_STEP)} className="sm:hidden" />
    <ShowMore remaining={items.length - deskShown} step={DESKTOP_STEP} onClick={() => setDeskShown((n) => n + DESKTOP_STEP)} className="max-sm:hidden" />
    </>
  );
}

function ShowMore({ remaining, step, onClick, className }: { remaining: number; step: number; onClick: () => void; className: string }) {
  if (remaining <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-surface text-[15px] font-bold shadow-soft transition-colors hover:bg-soft-2 ${className}`}
    >
      Show {Math.min(step, remaining)} more
      <span className="font-normal text-muted">({remaining} left)</span>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24">
        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** One candidate row. Memoised: selecting a drug re-renders only the two rows whose `isSel` changed. */
const Row = memo(function Row({
  c,
  diseaseId,
  isSel,
  onIntent,
}: {
  c: Candidate;
  diseaseId: string;
  isSel: boolean;
  onIntent: (drugId: string) => void;
}) {
  return (
    <Link
      onMouseEnter={() => onIntent(c.drug_id)}
      onFocus={() => onIntent(c.drug_id)}
      onTouchStart={() => onIntent(c.drug_id)}
      href={`/d/${encodeURIComponent(diseaseId)}/${encodeURIComponent(c.drug_id)}`}
      scroll={false}
      aria-current={isSel ? "true" : undefined}
      className={`flex min-h-11 items-center gap-3 rounded-3xl py-2.5 pl-1 pr-3 transition-all sm:gap-3.5 sm:pl-2 sm:pr-4 ${
        isSel ? "bg-surface shadow-soft" : "hover:bg-surface/60"
      }`}
    >
      <span className="w-6 shrink-0 text-right text-xl font-light text-faint sm:w-7 sm:text-[22px]">{c.rank}</span>
      <ScoreRing score={c.score} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-[17px] font-bold">{drugLabel(c.drug_name, c.drug_id)}</span>
          {c.inferred_only && (
            <span
              title="Supported only by structure or sequence similarity, no direct graph path"
              className="shrink-0 rounded-full border border-dashed border-faint px-2 text-[11px] font-semibold text-muted"
            >
              inferred
            </span>
          )}
        </span>
        <span className="truncate text-[13px] text-muted">
          {c.top_gene_symbols.length > 0 && <span className="font-mono">{c.top_gene_symbols.join(" · ")}</span>}
          {c.lead_path && (
            <span title={`Strongest support: ${PATH_LABEL[c.lead_path]}`}>
              {c.top_gene_symbols.length > 0 && " · "}via {PATH_SHORT[c.lead_path]}
            </span>
          )}
          {!c.approved && c.max_phase != null && <span> · phase {c.max_phase}</span>}
        </span>
        <span className="sm:hidden">
          <ReadinessDot value={c.readiness} />
        </span>
      </span>
      <span className="hidden sm:inline-flex">
        <ReadinessDot value={c.readiness} />
      </span>
    </Link>
  );
});
