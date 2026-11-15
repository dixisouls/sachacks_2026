"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getBrief, getPaths } from "@/lib/api";
import { drugLabel, PATH_LABEL, softenNames } from "@/lib/format";
import type { Candidate, DiseaseSummary, PathNode, PathType } from "@/lib/types";
import BriefView from "./BriefView";
import ErrorCard from "./ErrorCard";
import PathGraph from "./PathGraph";
import ReadinessBadge from "./ReadinessBadge";
import StructurePanel from "./StructurePanel";

type Tab = "path" | "structure" | "brief";

export default function DetailPanel({
  disease,
  candidate,
  weights,
}: {
  disease: DiseaseSummary;
  candidate: Candidate;
  weights?: Partial<Record<PathType, number>>;
}) {
  const drugId = candidate.drug_id;
  const diseaseId = disease.disease_id;
  const [tab, setTab] = useState<Tab>("path");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [gene, setGene] = useState<string | null>(null);

  const paths = useQuery({ queryKey: ["paths", diseaseId, drugId], queryFn: () => getPaths(drugId, diseaseId) });
  // brief is the slowest call, so it starts as soon as the sheet opens (architecture.md §10.3)
  const brief = useQuery({ queryKey: ["brief", diseaseId, drugId], queryFn: () => getBrief(drugId, diseaseId) });

  useEffect(() => {
    setHighlight(null);
    setGene(null);
  }, [drugId, diseaseId]);

  const genes = useMemo(() => paths.data?.nodes.filter((n) => n.type === "gene") ?? [], [paths.data]);
  const defaultGene = useMemo(() => {
    const first = paths.data?.paths.flatMap((p) => p.nodes).find((id) => genes.some((g) => g.id === id));
    return first ?? genes[0]?.id ?? null;
  }, [paths.data, genes]);
  const selectedGene: PathNode | null = genes.find((g) => g.id === (gene ?? defaultGene)) ?? null;
  const name = drugLabel(candidate.drug_name, drugId);

  const tabs: { key: Tab; label: string; busy?: boolean }[] = [
    { key: "path", label: "Path" },
    { key: "structure", label: "Structure" },
    { key: "brief", label: "Brief", busy: brief.isLoading },
  ];

  return (
    <div className="rounded-[36px] bg-surface p-6 shadow-float sm:p-10 [animation:fadein_.35s_ease]">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-[220px] flex-1">
          <h2 className="text-[clamp(30px,3.5vw,42px)] font-extrabold leading-[1.05] tracking-[-0.035em]">{name}</h2>
          <p className="mt-2 text-[15px] text-muted">
            for {disease.name} · <span className="font-mono text-[13px]">{drugId}</span>
          </p>
        </div>
        <div className="text-right">
          <div className="text-[44px] font-extrabold leading-none tracking-[-0.04em]">{candidate.score}</div>
          <div className="mt-1 text-xs text-muted">relative score</div>
        </div>
        <Link
          href={`/d/${encodeURIComponent(diseaseId)}`}
          scroll={false}
          aria-label="Close"
          className="-mr-2 -mt-2 grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-soft-2 hover:text-foreground"
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </Link>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 text-[13px] font-semibold">
        <ReadinessBadge value={candidate.readiness} />
        <span className="rounded-full bg-soft-2 px-3 py-1.5 text-muted">{candidate.approved ? "Approved drug" : `Not approved${candidate.max_phase != null ? ` · max phase ${candidate.max_phase}` : ""}`}</span>
        {candidate.year_approved && <span className="rounded-full bg-soft-2 px-3 py-1.5 text-muted">since {candidate.year_approved}</span>}
        {candidate.black_box && <span className="rounded-full bg-[#FBE4DE] px-3 py-1.5 text-[#8A2A14]">Black box warning</span>}
        {candidate.trial_ids.map((t) => (
          <a key={t} href={`https://clinicaltrials.gov/study/${t}`} target="_blank" rel="noreferrer" className="rounded-full bg-[#DFE9FA] px-3 py-1.5 font-mono text-[12px] text-[#1D4E99] hover:underline">
            {t}
          </a>
        ))}
      </div>

      <ScoreBreakdown c={candidate} weights={weights} />

      <div role="tablist" aria-label="Detail" className="mt-7 inline-flex gap-1 rounded-full bg-soft-2 p-1.5 text-sm font-bold">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`flex min-h-11 items-center gap-2 rounded-full px-5 transition-all ${
              tab === t.key ? "bg-foreground text-background" : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
            {t.busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "path" &&
          (paths.isLoading ? (
            <div className="skeleton h-[400px]" />
          ) : paths.isError || !paths.data ? (
            <ErrorCard msg="Could not load the path." detail={(paths.error as Error)?.message} onRetry={() => paths.refetch()} />
          ) : (
            <div className="space-y-7">
              <PathGraph
                data={paths.data}
                drugId={drugId}
                diseaseId={diseaseId}
                highlight={highlight}
                selectedGene={selectedGene?.id ?? null}
                onGeneClick={(g) => {
                  setGene(g);
                  setTab("structure");
                }}
              />
              {highlight && (
                <button onClick={() => setHighlight(null)} className="min-h-11 text-sm font-bold text-accent-ink hover:underline">
                  Clear highlight
                </button>
              )}
              <div>
                <h3 className="mb-3 text-[15px] font-bold">Why {name.toLowerCase()}</h3>
                <ul className="space-y-3.5">
                  {paths.data.paths.map((p, i) => (
                    <li key={i} className="flex gap-3 text-[16px] leading-relaxed">
                      <span
                        className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full"
                        style={p.inferred ? { border: "2px dashed var(--drug)" } : { background: p.type === "sibling_disease" ? "var(--disease)" : "var(--gene)" }}
                      />
                      <span>
                        <span className="font-semibold">{PATH_LABEL[p.type]}{p.inferred && " (inferred)"}:</span> {softenNames(p.explanation, paths.data.nodes)}.
                      </span>
                    </li>
                  ))}
                  {paths.data.paths.length === 0 && <li className="text-[15px] text-muted">No paths returned.</li>}
                </ul>
              </div>
            </div>
          ))}

        {tab === "structure" && (
          <StructurePanel drugId={drugId} diseaseId={diseaseId} gene={selectedGene} genes={genes} onGeneChange={setGene} />
        )}

        {tab === "brief" && (
          <BriefView
            brief={brief.data}
            loading={brief.isLoading}
            error={brief.isError}
            onRetry={() => brief.refetch()}
            onGraph={(id) => {
              setHighlight(id);
              setTab("path");
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Each component's share, honest about weights: a weight of 0 means "shown for context, not scored". */
function ScoreBreakdown({ c, weights }: { c: Candidate; weights?: Partial<Record<PathType, number>> }) {
  const parts = (Object.entries(c.score_components) as [PathType, number][]).filter(([, v]) => v > 0);
  if (!parts.length) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-muted">
      {parts.map(([k, v]) => {
        const w = weights?.[k];
        const unscored = w === 0;
        return (
          <span key={k} className="flex items-center gap-2" title={unscored ? "Weight 0: shown as context, does not change the ranking" : undefined}>
            <span className="h-1.5 w-14 overflow-hidden rounded-full bg-soft">
              <span className={`block h-full rounded-full ${unscored ? "bg-faint/50" : "bg-accent"}`} style={{ width: `${Math.round(v * 100)}%` }} />
            </span>
            {PATH_LABEL[k]} {v.toFixed(2)}
            {unscored && <span className="text-faint">· context only</span>}
          </span>
        );
      })}
    </div>
  );
}
