"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getBrief, getPaths } from "@/lib/api";
import { drugLabel, PATH_HINT, PATH_LABEL, softenNames, titleCase } from "@/lib/format";
import type { Candidate, DiseaseSummary, Path, PathNode, PathsResponse, PathType } from "@/lib/types";
import BriefView from "./BriefView";
import Chain, { type ChainLink, type ChainNode } from "./Chain";
import DesignPanel from "./DesignPanel";
import ErrorCard from "./ErrorCard";
import LookAlikeCompare, { type Analog } from "./LookAlikeCompare";
import PathGraph from "./PathGraph";
import ReadinessBadge from "./ReadinessBadge";
import ScoreMeter from "./ScoreMeter";
import StructurePanel from "./StructurePanel";

type Tab = "why" | "evidence" | "structure" | "design";

/** One path from the API as chain nodes and labelled links. */
function toChain(p: Path, data: PathsResponse): { nodes: ChainNode[]; links: ChainLink[] } {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const nodes: ChainNode[] = p.nodes.map((id) => {
    const n = byId.get(id);
    const type = n?.type ?? "gene";
    return { id, type, label: type === "gene" ? n?.label ?? id : titleCase(n?.label) || id };
  });
  const links: ChainLink[] = p.nodes.slice(1).map((b, i) => {
    const a = p.nodes[i];
    const e = data.edges.find((x) => (x.source === a && x.target === b) || (x.source === b && x.target === a));
    if (!e) return { dashed: p.inferred };
    const pct = e.weight != null ? `${Math.round(e.weight * 100)}%` : "";
    const label =
      e.relation === "ASSOCIATED_WITH"
        ? "linked to"
        : e.relation === "SIMILAR_STRUCTURE"
          ? `${pct} same shape`
          : e.relation === "SIMILAR_SEQUENCE"
            ? `${pct} same sequence`
            : e.relation.toLowerCase().replace(/_/g, " ");
    return { label, dashed: e.inferred };
  });
  return { nodes, links };
}

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
  const [tab, setTab] = useState<Tab>("why");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [gene, setGene] = useState<string | null>(null);
  const [allReasons, setAllReasons] = useState(false);
  const [extras, setExtras] = useState(false);

  const paths = useQuery({ queryKey: ["paths", diseaseId, drugId], queryFn: () => getPaths(drugId, diseaseId) });
  // brief is the slowest call, so it starts as soon as the panel opens (architecture.md §10.3)
  const brief = useQuery({ queryKey: ["brief", diseaseId, drugId], queryFn: () => getBrief(drugId, diseaseId) });

  useEffect(() => {
    setHighlight(null);
    setGene(null);
    setAllReasons(false);
    setExtras(false);
  }, [drugId, diseaseId]);

  // Only the drug's own targets: proteins it touches directly. Genes reached through a
  // look-alike drug or a related protein are not where this drug acts, so they are not offered.
  const genes = useMemo(() => {
    const d = paths.data;
    if (!d) return [];
    const direct = new Set(d.edges.flatMap((e) => (e.source === drugId ? [e.target] : e.target === drugId ? [e.source] : [])));
    return d.nodes.filter((n) => n.type === "gene" && direct.has(n.id));
  }, [paths.data, drugId]);
  const isTarget = (n: ChainNode) => genes.some((g) => g.id === n.id);
  const defaultGene = useMemo(() => {
    const first = paths.data?.paths.flatMap((p) => p.nodes).find((id) => genes.some((g) => g.id === id));
    return first ?? genes[0]?.id ?? null;
  }, [paths.data, genes]);
  const selectedGene: PathNode | null = genes.find((g) => g.id === (gene ?? defaultGene)) ?? null;
  // look-alike drugs from the chemical-analog paths: drug -> analog -> gene -> disease
  const analogs = useMemo<Analog[]>(() => {
    const out: Analog[] = [];
    for (const p of paths.data?.paths ?? []) {
      const id = p.type === "chemical_analog" ? p.nodes[1] : undefined;
      if (!id || out.some((a) => a.id === id)) continue;
      const node = paths.data?.nodes.find((n) => n.id === id);
      out.push({ id, label: node?.label ?? null, similarity: p.similarity ?? null });
    }
    return out.sort((x, y) => (y.similarity ?? 0) - (x.similarity ?? 0));
  }, [paths.data]);
  const name = drugLabel(candidate.drug_name, drugId);
  const lead = paths.data?.paths[0];
  const openGene = (id: string) => {
    setGene(id);
    setTab("structure");
  };

  const nReasons = paths.data?.paths.length;
  const tabs: { key: Tab; label: string; note?: string; tag?: string; busy?: boolean }[] = [
    { key: "why", label: "Why it's here", note: nReasons != null ? String(nReasons) : undefined },
    { key: "evidence", label: "Evidence", busy: brief.isLoading },
    { key: "structure", label: "3D structure" },
    { key: "design", label: "Design new", tag: "AI" },
  ];

  return (
    <article className="panel fadein relative overflow-hidden" aria-labelledby="drug-h">
      {/* header: who, for what, how strong */}
      <header className="relative p-5 sm:p-8">
        <Link
          href={`/d/${encodeURIComponent(diseaseId)}`}
          scroll={false}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full text-faint transition-colors hover:bg-soft-2 hover:text-foreground max-lg:hidden"
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </Link>
        <div className="flex items-start gap-5 lg:pr-10">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] text-muted">
              Could it help <span className="font-semibold text-disease">{disease.name}</span>?
            </p>
            <h2 id="drug-h" className="mt-1 break-words text-[clamp(30px,3.6vw,44px)] font-extrabold leading-[1.02] tracking-[-0.035em]">
              {name}
            </h2>
            <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
              <ReadinessBadge value={candidate.readiness} />
              <Fact>
                {candidate.approved
                  ? `Approved${candidate.year_approved ? ` in ${candidate.year_approved}` : ""}`
                  : `Reached phase ${candidate.max_phase ?? "?"}`}
              </Fact>
              {candidate.black_box && <Fact tone="red">Black box warning</Fact>}
              {candidate.trial_ids.map((t) => (
                <a
                  key={t}
                  href={`https://clinicaltrials.gov/study/${t}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full bg-[#DFE9FA] px-2.5 py-1 font-mono text-[11.5px] text-[#1D4E99] hover:underline"
                  title="Open the trial on ClinicalTrials.gov"
                >
                  {t}
                </a>
              ))}
            </div>
          </div>
          <div className="flex flex-col items-center">
            <ScoreMeter score={candidate.score} size="lg" />
            <span className="mt-1.5 text-[11.5px] text-faint" title="Relative rank within this list, not a probability">
              out of 100
            </span>
          </div>
        </div>
      </header>

      {/* the short version: the strongest path, drawn big */}
      <section aria-label="Strongest reason" className="mx-3 rounded-[28px] bg-soft-2 px-4 py-6 sm:mx-5 sm:px-6">
        {paths.isLoading && <div className="skeleton h-[74px]" />}
        {paths.data && lead && (
          <div key={drugId}>
            <Chain size="lg" {...toChain(lead, paths.data)} onNode={(n) => openGene(n.id)} canClick={isTarget} />
            <p className="mx-auto mt-4 max-w-[640px] text-center text-[15.5px] leading-relaxed text-muted">
              {softenNames(lead.explanation, paths.data.nodes)}.
            </p>
          </div>
        )}
        {paths.data && !lead && <p className="text-center text-[15px] text-muted">No path returned for this pair.</p>}
        {paths.isError && <p className="text-center text-[15px] text-muted">Could not load the path.</p>}
      </section>

      {/* tabs: three equal parts */}
      <div className="px-5 pt-5 sm:px-8">
        <div role="tablist" aria-label="Details" className="grid grid-cols-2 gap-1 rounded-full bg-soft p-1 text-[13.5px] font-semibold sm:grid-cols-4 sm:text-[14px]">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`flex h-10 items-center justify-center gap-1.5 rounded-full px-2 transition-colors ${
                tab === t.key ? "bg-surface text-foreground shadow-soft" : "text-muted hover:text-foreground"
              }`}
            >
              <span className="truncate">{t.label}</span>
              {t.note && <span className="rounded-full bg-accent-soft px-1.5 text-[11.5px] tabular-nums text-accent-ink max-sm:hidden">{t.note}</span>}
              {t.tag && (
                <span className="rounded-full bg-[#FBEFD9] px-1.5 text-[10.5px] font-bold text-[#6B4A06]" title="Proposes a molecule that does not exist yet">
                  {t.tag}
                </span>
              )}
              {t.busy && <span aria-label="Loading" className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5 sm:p-8">
        {tab === "why" &&
          (paths.isLoading ? (
            <div className="space-y-3">
              <div className="skeleton h-28" />
              <div className="skeleton h-28" />
            </div>
          ) : paths.isError || !paths.data ? (
            <ErrorCard msg="Could not load the path." detail={(paths.error as Error)?.message} onRetry={() => paths.refetch()} />
          ) : (
            <div className="space-y-10">
              <section aria-labelledby="reasons-h">
                <Heading id="reasons-h" title={`${paths.data.paths.length} ${paths.data.paths.length === 1 ? "way" : "ways"} ${name} reaches ${disease.name}`}>
                  Dashed lines are inferred from similarity. Click a target gene to see where the drug binds.
                </Heading>
                <ol className="space-y-3">
                  {paths.data.paths.slice(0, allReasons ? undefined : REASONS_SHOWN).map((p, i) => (
                    <li key={i} className="rounded-3xl bg-soft-2 p-4">
                      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="text-[14px] font-bold">
                          {PATH_LABEL[p.type]}
                          {p.inferred && <span className="ml-1.5 font-semibold text-faint">inferred</span>}
                        </span>
                        <span className="text-[12.5px] text-muted">{PATH_HINT[p.type]}</span>
                      </div>
                      <Chain {...toChain(p, paths.data)} onNode={(n) => openGene(n.id)} canClick={isTarget} selected={null} />
                    </li>
                  ))}
                  {paths.data.paths.length === 0 && <li className="text-[15px] text-muted">No paths returned.</li>}
                </ol>
                {paths.data.paths.length > REASONS_SHOWN && (
                  <MoreButton open={allReasons} onClick={() => setAllReasons((v) => !v)}>
                    {allReasons ? "Show fewer reasons" : `Show ${paths.data.paths.length - REASONS_SHOWN} more reasons`}
                  </MoreButton>
                )}
              </section>

              <ScoreBreakdown c={candidate} weights={weights} />

              <MoreButton
                open={extras || !!highlight}
                onClick={() => {
                  if (extras || highlight) {
                    setExtras(false);
                    setHighlight(null);
                  } else setExtras(true);
                }}
              >
                {extras || highlight ? "Hide the full map" : analogs.length ? "Show the full map and look-alike comparison" : "Show the full map"}
              </MoreButton>

              {(extras || !!highlight) && (
              <>
              <section aria-labelledby="map-h">
                <Heading id="map-h" title="The whole map">
                  Every path above drawn together. Drag to move around.
                </Heading>
                <PathGraph
                  data={paths.data}
                  drugId={drugId}
                  diseaseId={diseaseId}
                  highlight={highlight}
                  selectedGene={selectedGene?.id ?? null}
                  onGeneClick={openGene}
                />
                {highlight && (
                  <button onClick={() => setHighlight(null)} className="mt-2 h-10 text-sm font-semibold text-accent-ink hover:underline">
                    Clear highlight
                  </button>
                )}
              </section>

              {analogs.length > 0 && <LookAlikeCompare key={drugId} drugId={drugId} drugName={name} analogs={analogs} />}
              </>
              )}
            </div>
          ))}

        {tab === "structure" && (
          <StructurePanel drugId={drugId} diseaseId={diseaseId} gene={selectedGene} genes={genes} onGeneChange={setGene} />
        )}

        {tab === "design" && (
          <DesignPanel drugId={drugId} diseaseId={diseaseId} drugName={name} diseaseName={disease.name} />
        )}

        {tab === "evidence" && (
          <BriefView
            brief={brief.data}
            loading={brief.isLoading}
            error={brief.isError}
            onRetry={() => brief.refetch()}
            onGraph={(id) => {
              setHighlight(id);
              setTab("why");
            }}
          />
        )}
      </div>
    </article>
  );
}

const REASONS_SHOWN = 3;

function MoreButton({ open, onClick, children }: { open: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-soft-2 text-[14px] font-semibold text-accent-ink transition-colors hover:bg-mint"
    >
      {children}
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" className={`transition-transform ${open ? "rotate-180" : ""}`}>
        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function Fact({ children, tone }: { children: React.ReactNode; tone?: "red" }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[12.5px] font-semibold ${
        tone === "red" ? "bg-[#FBE4DE] text-[#8A2A14]" : "bg-soft-2 text-muted"
      }`}
    >
      {children}
    </span>
  );
}

export function Heading({ id, title, children }: { id?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 id={id} className="text-[18px] font-bold tracking-[-0.015em]">
        {title}
      </h3>
      {children && <p className="mt-1 text-[14px] leading-relaxed text-muted">{children}</p>}
    </div>
  );
}

/** What drove the score. A weight of 0 means "shown for context, not scored". */
function ScoreBreakdown({ c, weights }: { c: Candidate; weights?: Partial<Record<PathType, number>> }) {
  const parts = (Object.entries(c.score_components) as [PathType, number][]).filter(([, v]) => v > 0);
  if (!parts.length) return null;
  return (
    <section aria-labelledby="score-h">
      <Heading id="score-h" title={`Where the score of ${c.score} comes from`}>
        How strongly each kind of path supports this drug, from 0 to 1.
      </Heading>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {parts.map(([k, v]) => {
          const unscored = weights?.[k] === 0;
          return (
            <div key={k} title={unscored ? "Weight 0: shown as context, does not change the ranking" : undefined}>
              <div className="flex items-baseline justify-between text-[14px]">
                <dt className="font-semibold">
                  {PATH_LABEL[k]}
                  {unscored && <span className="ml-1.5 font-normal text-faint">context only</span>}
                </dt>
                <dd className="tabular-nums text-muted">{v.toFixed(2)}</dd>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken">
                <div className={`h-full rounded-full ${unscored ? "bg-faint/40" : "bg-accent"}`} style={{ width: `${Math.round(v * 100)}%` }} />
              </div>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
