"use client";

import type { Brief, Claim, EvidenceItem } from "@/lib/types";
import CitationChip from "./CitationChip";
import ReadinessBadge from "./ReadinessBadge";

type Props = {
  brief: Brief | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onGraph: (kgId: string) => void;
};

export default function BriefView({ brief, loading, error, onRetry, onGraph }: Props) {
  if (loading) return <BriefSkeleton />;
  if (error || !brief) {
    return (
      <div className="rounded-3xl bg-soft-2 p-8 text-center">
        <p className="font-bold">Evidence sources are not reachable right now</p>
        <p className="mt-1 text-sm text-muted">The reasons and the map still work. You can load the evidence again.</p>
        <button onClick={onRetry} className="mt-4 h-10 rounded-full bg-accent px-5 text-sm font-semibold text-white hover:bg-accent-ink">
          Load evidence again
        </button>
      </div>
    );
  }

  const byId = new Map(brief.evidence.map((e) => [e.id, e]));
  const sample = brief.model.startsWith("sample");
  return (
    <div className="space-y-8">
      {sample && (
        <p className="rounded-full bg-[#FBEFD9] px-4 py-2.5 text-[13.5px] font-semibold text-[#6B4A06]">
          Sample brief built from graph data only. Literature and safety evidence arrive with the live brief.
        </p>
      )}

      <p className="flex items-start gap-3 rounded-3xl bg-accent-soft/70 px-4 py-3 text-[14px] leading-relaxed text-accent-ink">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" className="mt-0.5 shrink-0">
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>
          Every sentence below links to its source: a paper, a trial, a safety report or a graph edge.
          {brief.dropped_claims > 0 && (
            <>
              {" "}
              {brief.dropped_claims} {brief.dropped_claims === 1 ? "sentence had" : "sentences had"} no source and {brief.dropped_claims === 1 ? "was" : "were"}{" "}
              removed.
            </>
          )}
        </span>
      </p>

      <Section title="How it might work" claims={brief.mechanism} byId={byId} onGraph={onGraph} empty="No supported mechanism found." />

      <div className="grid gap-4 md:grid-cols-2">
        <Column title="Evidence for" tone="for" claims={brief.evidence_for} byId={byId} onGraph={onGraph} empty="No supporting evidence found yet." />
        <Column title="Evidence against" tone="against" claims={brief.evidence_against} byId={byId} onGraph={onGraph} empty="No contrary evidence found yet." />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-3xl bg-soft-2 px-4 py-3">
        <span className="text-[14px] font-bold">Readiness</span>
        <ReadinessBadge value={brief.readiness} />
        <span className="text-[13px] text-muted">Worked out from the graph and trial registry, never by the language model.</span>
      </div>

      {brief.evidence.length > 0 && (
        <details className="group rounded-3xl bg-soft-2">
          <summary className="flex h-12 cursor-pointer list-none items-center justify-between px-4 text-[14px] font-bold">
            All {brief.evidence.length} sources
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" className="transition-transform group-open:rotate-180">
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </summary>
          <ul className="space-y-2.5 px-4 pb-4 pt-1 text-sm">
            {brief.evidence.map((e) => (
              <li key={e.id} className="flex items-start gap-3">
                <CitationChip id={e.id} item={e} onGraph={onGraph} />
                <span className="min-w-0 text-muted">{e.title}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-center text-xs text-faint">
        Written {new Date(brief.generated_at).toLocaleString()} by {brief.model}
      </p>
    </div>
  );
}

function Claims({ claims, byId, onGraph, empty, dot }: { claims: Claim[]; byId: Map<string, EvidenceItem>; onGraph: (id: string) => void; empty: string; dot: string }) {
  if (claims.length === 0) return <p className="text-[14.5px] text-muted">{empty}</p>;
  return (
    <ul className="space-y-3">
      {claims.map((c, i) => (
        <li key={i} className="flex gap-3 text-[15.5px] leading-relaxed">
          <span className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
          <span>
            {c.text}{" "}
            {c.source_ids.map((s) => (
              <span key={s} className="mr-1 inline-block">
                <CitationChip id={s} item={byId.get(s)} onGraph={onGraph} />
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Section(props: { title: string; claims: Claim[]; byId: Map<string, EvidenceItem>; onGraph: (id: string) => void; empty: string }) {
  return (
    <section>
      <h3 className="mb-3 text-[18px] font-bold tracking-[-0.015em]">{props.title}</h3>
      <Claims {...props} dot="bg-gene" />
    </section>
  );
}

function Column({ tone, ...props }: { title: string; tone: "for" | "against"; claims: Claim[]; byId: Map<string, EvidenceItem>; onGraph: (id: string) => void; empty: string }) {
  const isFor = tone === "for";
  return (
    <section className="rounded-3xl bg-soft-2 p-4 sm:p-5">
      <h3 className="mb-3 flex items-center gap-2 text-[16px] font-bold">
        <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${isFor ? "bg-accent" : "bg-[#C8452A]"}`} />
        <span className="flex-1">{props.title}</span>
        <span className="text-[13px] font-semibold tabular-nums text-faint">{props.claims.length}</span>
      </h3>
      <Claims {...props} dot={isFor ? "bg-accent" : "bg-[#C8452A]"} />
    </section>
  );
}

function BriefSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Gathering evidence">
      <p className="text-center text-sm text-muted">Reading papers, trials and safety reports. This takes a few seconds.</p>
      <div className="space-y-2.5">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-4 w-[92%]" />
        <div className="skeleton h-4 w-[78%]" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="skeleton h-40" />
        <div className="skeleton h-40" />
      </div>
    </div>
  );
}
