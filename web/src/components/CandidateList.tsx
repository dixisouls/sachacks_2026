"use client";

import Link from "next/link";
import { useState } from "react";
import { drugLabel, PATH_LABEL, PATH_SHORT } from "@/lib/format";
import type { Candidate } from "@/lib/types";
import ReadinessDot from "./ReadinessDot";
import ScoreRing from "./ScoreRing";

/** On phones only the first few rows show, with "Show more" below. Desktop always shows every row. */
const PHONE_STEP = 6;

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
  const [shown, setShown] = useState(() => Math.max(PHONE_STEP, Math.ceil((selIndex + 1) / PHONE_STEP) * PHONE_STEP));
  if (!items.length) return <p className="px-3 py-8 text-[15px] text-muted">{empty}</p>;
  const remaining = items.length - shown;
  return (
    <>
    <ol className="flex flex-col gap-1">
      {items.map((c, i) => {
        const isSel = c.drug_id === selected;
        return (
          <li key={c.drug_id} className={i >= shown ? "hidden sm:block" : undefined}>
            <Link
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
          </li>
        );
      })}
    </ol>
    {remaining > 0 && (
      <button
        type="button"
        onClick={() => setShown((n) => n + PHONE_STEP)}
        className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-surface text-[15px] font-bold shadow-soft transition-colors hover:bg-soft-2 sm:hidden"
      >
        Show more
        <span className="font-normal text-muted">({remaining} more)</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    )}
    </>
  );
}
