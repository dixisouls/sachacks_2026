"use client";

import Link from "next/link";
import { useState } from "react";
import { drugLabel, PATH_LABEL } from "@/lib/format";
import type { Candidate } from "@/lib/types";
import ReadinessBadge from "./ReadinessBadge";
import ScoreMeter from "./ScoreMeter";

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
  if (!items.length) return <p className="px-3 py-10 text-center text-[15px] text-muted">{empty}</p>;
  // each breakpoint hides its own overflow; max-sm = phones, sm = laptops and up
  const rowClass = (i: number) =>
    [i >= phoneShown && "max-sm:hidden", i >= deskShown && "sm:hidden"].filter(Boolean).join(" ") || undefined;
  return (
    <>
      <ol className="flex flex-col gap-1">
        {items.map((c, i) => {
          const isSel = c.drug_id === selected;
          return (
            <li key={c.drug_id} className={rowClass(i)}>
              <Link
                href={`/d/${encodeURIComponent(diseaseId)}/${encodeURIComponent(c.drug_id)}`}
                scroll={false}
                aria-current={isSel ? "true" : undefined}
                className={`flex items-center gap-3 rounded-3xl py-3 pl-2 pr-3 transition-all sm:pr-4 ${
                  isSel ? "bg-surface shadow-soft" : "hover:bg-surface/60"
                }`}
              >
                <span className={`w-6 shrink-0 text-right text-[15px] font-semibold tabular-nums ${isSel ? "text-accent-ink" : "text-faint"}`}>{c.rank}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[16px] font-bold tracking-[-0.01em]">{drugLabel(c.drug_name, c.drug_id)}</span>
                    {c.inferred_only && (
                      <span
                        title="Supported only by structure or sequence similarity, no direct graph path"
                        className="shrink-0 rounded-full border border-dashed border-faint px-1.5 text-[11px] font-semibold text-muted"
                      >
                        inferred
                      </span>
                    )}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {c.top_gene_symbols.length > 0 ? (
                      <span className="flex min-w-0 items-center gap-1 overflow-hidden">
                        {c.top_gene_symbols.slice(0, 3).map((g) => (
                          <span key={g} className="shrink-0 rounded-md bg-gene-soft px-1.5 font-mono text-[11.5px] font-medium text-accent-ink">
                            {g}
                          </span>
                        ))}
                      </span>
                    ) : (
                      c.lead_path && <span className="text-[12.5px] text-muted">via {PATH_LABEL[c.lead_path].toLowerCase()}</span>
                    )}
                    <ReadinessBadge value={c.readiness} quiet />
                    {!c.approved && c.max_phase != null && <span className="text-[12.5px] text-muted">phase {c.max_phase}</span>}
                  </span>
                </span>
                <ScoreMeter score={c.score} />
              </Link>
            </li>
          );
        })}
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
      className={`mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-surface text-[14px] font-semibold shadow-soft transition-colors hover:bg-soft-2 ${className}`}
    >
      Show {Math.min(step, remaining)} more
      <span className="font-normal text-muted">of {remaining} left</span>
    </button>
  );
}
