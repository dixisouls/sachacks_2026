"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import Blobs from "@/components/Blobs";
import ErrorCard from "@/components/ErrorCard";
import Footer from "@/components/Footer";
import { CountUp, Reveal } from "@/components/product/Reveal";
import { getEval } from "@/lib/api";
import type { EvalMetrics } from "@/lib/types";

const METHOD_LABEL: Record<string, string> = {
  repurposekg: "RepurposeKG (shipped)",
  graph_plus_chem: "Graph paths + chemical",
  graph_only: "Graph paths only",
  graph_plus_homolog: "Graph paths + homology",
  path_a_only: "Shared biology alone",
  path_b_only: "Sibling disease alone",
  popularity: "Popularity baseline",
  random: "Random baseline",
};

// validated categorical pair (dataviz reference palette, slots 1 and 2)
const SERIES = [
  { key: "hits@10" as const, label: "Hits@10", color: "#2a78d6" },
  { key: "hits@50" as const, label: "Hits@50", color: "#eb6834" },
];

const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 1 : 1)}%`;

export default function Validation() {
  const q = useQuery({ queryKey: ["eval"], queryFn: getEval });
  const [view, setView] = useState<"chart" | "table">("chart");
  const [hover, setHover] = useState<{ m: string; label: string; color: string; v: number; se?: number; x: number; y: number } | null>(null);

  return (
    <div className="relative isolate overflow-hidden">
      <Blobs variant="mint" still />
      <div className="mx-auto max-w-[1000px] px-4 pb-16 pt-8 sm:px-8">
        <p className="text-[15px] font-semibold text-accent-ink">Validation</p>
        <h1 className="mt-3 text-[clamp(38px,5vw,60px)] font-extrabold leading-[1.02] tracking-[-0.04em]">
          Hide what we know.
          <br />
          See if it comes back.
        </h1>

        {q.isLoading && <div className="skeleton mt-10 h-80" />}
        {q.isError && (
          <div className="mt-10">
            <ErrorCard msg="Could not load rediscovery results." detail={(q.error as Error)?.message} onRetry={() => q.refetch()} />
          </div>
        )}

        {q.data && (() => {
          const e = q.data;
          const methods = Object.entries(e.methods).sort(([a], [b]) => order(a) - order(b)) as [string, EvalMetrics][];
          const ours = e.methods.repurposekg;
          const pop = e.methods.popularity;
          const rnd = e.methods.random;
          const scored = ours?.scored_pairs;
          const hidden = scored != null && e.not_recoverable != null ? scored + e.not_recoverable : undefined;
          const max = Math.max(...methods.flatMap(([, m]) => SERIES.map((s) => m[s.key])), 0.01);

          return (
            <>
              <p className="mt-6 max-w-[680px] text-lg leading-relaxed text-muted">
                We hid {Math.round((e.holdout_fraction ?? 0.2) * 100)}% of known approved treatments
                {hidden ? ` (${hidden.toLocaleString()} drug–disease pairs)` : ""} and asked the system to rank them back.
                Weights were tuned on one split{e.tuning ? ` (seed ${e.tuning.split_seed})` : ""} and reported on another
                {e.report_split_seed != null ? ` (seed ${e.report_split_seed})` : ""}, so the numbers are not graded on themselves.
              </p>

              {ours && (
                <Reveal className="mt-12 flex flex-wrap gap-x-16 gap-y-8">
                  <Stat value={<CountUp to={ours["hits@10"] * 100} decimals={1} suffix="%" />} label="of hidden treatments return in the top 10" accent />
                  {pop && <Stat value={<CountUp to={ours["hits@10"] / pop["hits@10"]} decimals={1} suffix="×" />} label="the popularity baseline" />}
                  {rnd && <Stat value={<CountUp to={Math.round(ours["hits@10"] / rnd["hits@10"])} suffix="×" />} label="the random baseline" />}
                  <Stat value={<span>{ours.median_rank}</span>} label="median rank of a hidden treatment" />
                </Reveal>
              )}

              <Reveal delay={100} className="mt-14 rounded-[36px] bg-surface p-6 shadow-float sm:p-10">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <h2 className="text-lg font-extrabold tracking-tight">Every method, same held-out pairs</h2>
                  <div className="flex items-center gap-4 text-[13px] text-muted" aria-label="Legend">
                    {SERIES.map((s) => (
                      <span key={s.key} className="flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                        {s.label}
                      </span>
                    ))}
                  </div>
                  <div className="ml-auto inline-flex gap-1 rounded-full bg-soft-2 p-1 text-[13px] font-bold">
                    {(["chart", "table"] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setView(v)}
                        aria-pressed={view === v}
                        className={`min-h-9 rounded-full px-4 capitalize ${view === v ? "bg-foreground text-background" : "text-muted"}`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>

                {view === "chart" ? (
                  <div className="relative mt-8 space-y-5" onMouseLeave={() => setHover(null)}>
                    {methods.map(([m, v]) => (
                      <div key={m} className="grid grid-cols-[130px_1fr] items-center gap-4 sm:grid-cols-[200px_1fr]">
                        <div className={`text-right text-sm ${m === "repurposekg" ? "font-extrabold" : "text-muted"}`}>{METHOD_LABEL[m] ?? m}</div>
                        <div className="space-y-[3px]">
                          {SERIES.map((s) => {
                            const val = v[s.key];
                            const se = s.key === "hits@10" ? v["hits@10_se"] : undefined;
                            const w = (val / max) * 88;
                            return (
                              <div
                                key={s.key}
                                className="relative flex h-3.5 items-center gap-2"
                                onMouseMove={(ev) => {
                                  const r = (ev.currentTarget.closest(".relative.mt-8") as HTMLElement).getBoundingClientRect();
                                  setHover({ m, label: s.label, color: s.color, v: val, se, x: ev.clientX - r.left, y: ev.clientY - r.top });
                                }}
                              >
                                <div className="h-3 rounded-full transition-[width] duration-700" style={{ width: `${Math.max(0.6, w)}%`, background: s.color }} />
                                {se != null && se > 0 && (
                                  <span
                                    aria-hidden="true"
                                    className="absolute h-[2px] bg-foreground/50"
                                    style={{ left: `${((val - se) / max) * 88}%`, width: `${((2 * se) / max) * 88}%` }}
                                  />
                                )}
                                {m === "repurposekg" && (
                                  <span
                                    className="text-[12px] font-semibold tabular-nums text-muted"
                                    style={{ marginLeft: se ? `calc(${(se / max) * 88}% + 4px)` : undefined }}
                                  >
                                    {pct(val)}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {hover && (
                      <div
                        className="pointer-events-none absolute z-10 rounded-2xl bg-foreground px-3.5 py-2 text-xs text-background shadow-soft"
                        style={{ left: Math.min(hover.x + 14, 9999), top: hover.y - 44 }}
                      >
                        <div className="font-bold">{METHOD_LABEL[hover.m] ?? hover.m}</div>
                        <div className="flex items-center gap-1.5 opacity-90">
                          <span className="h-2 w-2 rounded-full" style={{ background: hover.color }} />
                          {hover.label}: {pct(hover.v)}
                          {hover.se != null && ` ± ${(hover.se * 100).toFixed(1)}`}
                        </div>
                      </div>
                    )}
                    <p className="pt-2 text-[13px] text-muted">The thin line on each Hits@10 bar is ±1 standard error.</p>
                  </div>
                ) : (
                  <div className="mt-6 overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead className="text-left text-xs text-muted">
                        <tr>
                          <th className="py-2 font-semibold">Method</th>
                          <th className="py-2 text-right font-semibold">Hits@10</th>
                          <th className="py-2 text-right font-semibold">Hits@50</th>
                          <th className="py-2 text-right font-semibold">MRR</th>
                          <th className="py-2 text-right font-semibold">Median rank</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {methods.map(([m, v]) => (
                          <tr key={m} className="border-t border-soft">
                            <td className={`py-2.5 ${m === "repurposekg" ? "font-extrabold" : ""}`}>{METHOD_LABEL[m] ?? m}</td>
                            <td className="py-2.5 text-right">
                              {pct(v["hits@10"])}
                              {v["hits@10_se"] != null && <span className="text-muted"> ± {(v["hits@10_se"] * 100).toFixed(1)}</span>}
                            </td>
                            <td className="py-2.5 text-right">{pct(v["hits@50"])}</td>
                            <td className="py-2.5 text-right">{v.mrr.toFixed(3)}</td>
                            <td className="py-2.5 text-right">{v.median_rank.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Reveal>

              <Reveal delay={150} className="mt-14 grid gap-8 sm:grid-cols-2">
                <Note title="The two graph paths find different things">
                  Together they beat either one alone. Shared biology and sibling diseases each recover treatments the other misses.
                </Note>
                <Note title="Homology is shown, not scored">
                  Protein homology did not improve ranking here, so its weight is 0. This test only asks about drugs whose targets
                  are already known, which is exactly where homology is not needed.
                </Note>
                {e.not_recoverable != null && (
                  <Note title={`${e.not_recoverable.toLocaleString()} pairs could not come back`}>
                    Those drugs are approved for a parent or child of the hidden disease, so the product hides them by design.
                    They are reported separately and never counted as hits.
                  </Note>
                )}
                <Note title="Scores rank, they do not predict">
                  A score of 90 means “near the top of this list”, not a 90% chance of working.
                </Note>
              </Reveal>
            </>
          );
        })()}
      </div>
      <Footer />
    </div>
  );
}

function order(m: string) {
  const i = Object.keys(METHOD_LABEL).indexOf(m);
  return i < 0 ? 99 : i;
}

function Stat({ value, label, accent = false }: { value: React.ReactNode; label: string; accent?: boolean }) {
  return (
    <div>
      <div className={`text-[56px] font-extrabold leading-none tracking-tight ${accent ? "text-accent-ink" : ""}`}>{value}</div>
      <p className="mt-2 max-w-[200px] text-[15px] text-muted">{label}</p>
    </div>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
      <div>
        <h3 className="font-extrabold tracking-tight">{title}</h3>
        <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}
