"use client";

import Link from "next/link";
import { drugLabel, PATH_LABEL, PATH_SHORT } from "@/lib/format";
import type { Candidate } from "@/lib/types";
import ReadinessDot from "./ReadinessDot";
import ScoreRing from "./ScoreRing";

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
  if (!items.length) return <p className="px-3 py-8 text-[15px] text-muted">{empty}</p>;
  return (
    <ol className="flex flex-col gap-1">
      {items.map((c) => {
        const isSel = c.drug_id === selected;
        return (
          <li key={c.drug_id}>
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
  );
}
