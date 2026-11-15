"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import ReadinessBadge from "@/components/ReadinessBadge";
import ScoreMeter from "@/components/ScoreMeter";
import { getCandidates } from "@/lib/api";
import { DEMO_DISEASES } from "@/lib/config";
import { drugLabel } from "@/lib/format";

/** A small working slice of the product: pick a disease, see the top approved candidates. */
export default function LiveDemo() {
  const [id, setId] = useState(DEMO_DISEASES[0].disease_id);
  const q = useQuery({ queryKey: ["candidates", id], queryFn: () => getCandidates(id) });
  const top = q.data?.approved.slice(0, 5) ?? [];

  return (
    <div className="panel overflow-hidden">
      <div className="border-b border-line p-3">
        <div role="group" aria-label="Example diseases" className="grid grid-cols-3 gap-1 rounded-[14px] bg-sunken p-1">
          {DEMO_DISEASES.map((d) => (
            <button
              key={d.disease_id}
              aria-pressed={d.disease_id === id}
              onClick={() => setId(d.disease_id)}
              className={`flex h-10 items-center justify-center gap-2 truncate rounded-[11px] px-2 text-[13.5px] font-semibold transition-colors ${
                d.disease_id === id ? "bg-surface text-foreground shadow-soft" : "text-muted hover:text-foreground"
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full bg-disease max-sm:hidden" />
              <span className="truncate">{d.name}</span>
            </button>
          ))}
        </div>
      </div>

      <ol className="divide-y divide-line" aria-live="polite" aria-busy={q.isLoading}>
        {q.isLoading && Array.from({ length: 5 }).map((_, i) => <li key={i} className="m-3 skeleton h-12" />)}
        {q.isError && <li className="p-6 text-center text-sm text-muted">Could not load drugs for this disease.</li>}
        {top.map((c) => (
          <li key={c.drug_id}>
            <Link href={`/d/${id}/${encodeURIComponent(c.drug_id)}`} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-field">
              <span className="w-5 shrink-0 text-right text-[15px] font-semibold tabular-nums text-faint">{c.rank}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-[16px] font-bold">{drugLabel(c.drug_name, c.drug_id)}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {c.top_gene_symbols.slice(0, 2).map((g) => (
                    <span key={g} className="rounded-md bg-gene-soft px-1.5 font-mono text-[11.5px] font-medium text-accent-ink">
                      {g}
                    </span>
                  ))}
                  <ReadinessBadge value={c.readiness} quiet />
                </span>
              </span>
              <ScoreMeter score={c.score} />
            </Link>
          </li>
        ))}
      </ol>

      <div className="flex items-center justify-between gap-3 border-t border-line bg-field px-5 py-3">
        <p className="text-[13px] text-muted">Top 5 of {q.data?.approved.length ?? 50}. Click a drug to see why.</p>
        <Link href={`/d/${id}`} className="inline-flex h-9 shrink-0 items-center rounded-full bg-foreground px-4 text-[13px] font-semibold text-surface hover:bg-accent-ink">
          See all
        </Link>
      </div>
    </div>
  );
}
