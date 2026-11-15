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
      <div className="rounded-[28px] bg-field p-8 text-center">
        <p className="font-bold">Evidence sources unavailable</p>
        <p className="mt-1 text-sm text-muted">The path still works. You can try the brief again.</p>
        <button onClick={onRetry} className="mt-4 min-h-11 rounded-full bg-foreground px-5 text-sm font-bold text-background">
          Retry
        </button>
      </div>
    );
  }

  const byId = new Map(brief.evidence.map((e) => [e.id, e]));
  const sample = !!brief.sample_reason;
  return (
    <div className="space-y-8">
      {sample && (
        <p className="rounded-2xl bg-[#FBEFD9] px-4 py-2.5 text-[13px] font-semibold leading-snug text-[#6B4A06]">
          Sample brief from graph data only: {brief.sample_reason}.
        </p>
      )}
      <Section title="Mechanism" claims={brief.mechanism} byId={byId} onGraph={onGraph} empty="No supported mechanism." />
      <Section title="Evidence for" claims={brief.evidence_for} byId={byId} onGraph={onGraph} empty="No supporting evidence found yet." />
      <Section title="Evidence against" claims={brief.evidence_against} byId={byId} onGraph={onGraph} empty="No contrary evidence found yet." />
      <div>
        <h3 className="mb-3 text-[15px] font-bold">Readiness</h3>
        <ReadinessBadge value={brief.readiness} />
        <p className="mt-2 text-[13px] text-muted">Computed from the graph and trial registry, never by the language model.</p>
      </div>

      {brief.evidence.length > 0 && (
        <details className="group rounded-[24px] bg-field">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-5 py-3 text-[15px] font-bold">
            Sources ({brief.evidence.length})
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" className="transition-transform group-open:rotate-180">
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </summary>
          <ul className="space-y-2 px-5 pb-4 text-sm">
            {brief.evidence.map((e) => (
              <li key={e.id} className="flex items-start gap-3">
                <CitationChip id={e.id} item={e} onGraph={onGraph} />
                <span className="min-w-0 text-muted">{e.title}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-xs text-muted">
        {brief.dropped_claims > 0 && `${brief.dropped_claims} unsupported claim${brief.dropped_claims === 1 ? "" : "s"} removed · `}
        Generated {new Date(brief.generated_at).toLocaleString()} · {brief.model}
        {brief.notes && brief.notes.length > 0 && <> · {brief.notes.join(" · ")}</>}
      </p>
    </div>
  );
}

function Section({ title, claims, byId, onGraph, empty }: { title: string; claims: Claim[]; byId: Map<string, EvidenceItem>; onGraph: (id: string) => void; empty: string }) {
  return (
    <div>
      <h3 className="mb-3 text-[15px] font-bold">{title}</h3>
      {claims.length === 0 ? (
        <p className="text-[15px] text-muted">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {claims.map((c, i) => (
            <li key={i} className="flex gap-3 text-[16px] leading-relaxed">
              <span className="mt-2.5 h-2 w-2 shrink-0 rounded-full bg-gene" />
              <span>
                {c.text}{" "}
                <span className="inline-flex flex-wrap gap-1">
                  {c.source_ids.map((s) => (
                    <CitationChip key={s} id={s} item={byId.get(s)} onGraph={onGraph} />
                  ))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BriefSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Gathering evidence">
      <p className="text-sm text-muted">Gathering evidence…</p>
      {[3, 2, 2].map((n, s) => (
        <div key={s} className="space-y-2.5">
          <div className="skeleton h-3.5 w-28" />
          {Array.from({ length: n }).map((_, i) => (
            <div key={i} className="skeleton h-4" style={{ width: `${92 - i * 14}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}
