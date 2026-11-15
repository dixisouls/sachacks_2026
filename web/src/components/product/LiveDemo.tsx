"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import ScoreRing from "@/components/ScoreRing";
import ReadinessDot from "@/components/ReadinessDot";
import { getCandidates } from "@/lib/api";
import { DEMO_DISEASES } from "@/lib/config";
import { drugLabel } from "@/lib/format";

/** A small working slice of the product: pick a disease, see the top approved candidates. */
export default function LiveDemo() {
  const [id, setId] = useState(DEMO_DISEASES[0].disease_id);
  const q = useQuery({ queryKey: ["candidates", id], queryFn: () => getCandidates(id) });
  const top = q.data?.approved.slice(0, 5) ?? [];

  return (
    <div className="rounded-[28px] bg-surface p-4 shadow-float sm:rounded-[36px] sm:p-10">
      <div role="group" aria-label="Example diseases" className="flex flex-wrap gap-2">
        {DEMO_DISEASES.map((d) => (
          <button
            key={d.disease_id}
            aria-pressed={d.disease_id === id}
            onClick={() => setId(d.disease_id)}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-bold transition-colors ${
              d.disease_id === id ? "bg-foreground text-background" : "bg-soft-2 text-foreground hover:bg-soft"
            }`}
          >
            <span className="h-2 w-2 rounded-full bg-disease" />
            {d.name}
          </button>
        ))}
      </div>

      <ol className="mt-6 flex flex-col gap-1" aria-live="polite" aria-busy={q.isLoading}>
        {q.isLoading &&
          Array.from({ length: 5 }).map((_, i) => <li key={i} className="skeleton h-16" />)}
        {q.isError && <li className="py-6 text-sm text-muted">Could not load candidates.</li>}
        {top.map((c, i) => (
          <li
            key={c.drug_id}
            className="reveal in"
            style={{ transitionDelay: `${i * 70}ms` }}
          >
            <Link
              href={`/d/${id}/${encodeURIComponent(c.drug_id)}`}
              className="flex min-h-11 items-center gap-4 rounded-3xl px-3 py-2.5 transition-colors hover:bg-field"
            >
              <span className="w-5 shrink-0 text-right text-xl font-light text-faint sm:w-6">{c.rank}</span>
              <ScoreRing score={c.score} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[17px] font-bold">{drugLabel(c.drug_name, c.drug_id)}</span>
                <span className="block truncate font-mono text-xs text-muted">{c.top_gene_symbols.join(" · ") || "—"}</span>
                <span className="mt-0.5 block sm:hidden">
                  <ReadinessDot value={c.readiness} />
                </span>
              </span>
              <span className="hidden sm:inline-flex">
                <ReadinessDot value={c.readiness} />
              </span>
            </Link>
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Top approved drugs, ranked by graph paths. Click one to see why.</p>
        <Link
          href={`/d/${id}`}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-bold text-white hover:bg-accent-ink"
        >
          Open full results
        </Link>
      </div>
    </div>
  );
}
