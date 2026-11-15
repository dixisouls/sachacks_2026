"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import ErrorCard from "@/components/ErrorCard";
import Footer from "@/components/Footer";
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
    <div>
      <div className="mx-auto max-w-[1000px] px-4 pt-14 sm:px-8 sm:pt-20">
        <h1 className="text-center text-[clamp(40px,6vw,72px)] font-extrabold leading-[0.98] tracking-[-0.05em]">
          Does it work?
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
              <p className="mx-auto mt-6 max-w-[640px] text-center text-[17px] leading-relaxed text-muted">
                We hid {Math.round((e.holdout_fraction ?? 0.2) * 100)}% of known approved treatments
                {hidden ? ` (${hidden.toLocaleString()} drug–disease pairs)` : ""} and asked the system to rank them back.
                Weights were tuned on one split{e.tuning ? ` (seed ${e.tuning.split_seed})` : ""} and reported on another
                {e.report_split_seed != null ? ` (seed ${e.report_split_seed})` : ""}, so the numbers are not graded on themselves.
              </p>

              {ours && (
                <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-[24px] border border-line bg-line md:grid-cols-4">
                  <Stat value={`${(ours["hits@10"] * 100).toFixed(1)}%`} label="of hidden treatments come back in the top 10" accent />
                  {pop && <Stat value={`${(ours["hits@10"] / pop["hits@10"]).toFixed(1)}×`} label="better than ranking by popularity" />}
                  {rnd && <Stat value={`${Math.round(ours["hits@10"] / rnd["hits@10"])}×`} label="better than picking at random" />}
                  <Stat value={String(ours.median_rank)} label="median rank of a hidden treatment" />
                </div>
              )}

              <div className="panel mt-8 p-5 sm:p-10">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <h2 className="text-[18px] font-bold tracking-[-0.015em]">Every method, tested on the same hidden pairs</h2>
                  <div className="flex items-center gap-4 text-[13px] text-muted" aria-label="Legend">
                    {SERIES.map((s) => (
                      <span key={s.key} className="flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                        {s.label}
                      </span>
                    ))}
                  </div>
                  <div className="ml-auto inline-flex gap-1 rounded-[12px] bg-sunken p-1 text-[13px] font-semibold">
                    {(["chart", "table"] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setView(v)}
                        aria-pressed={view === v}
                        className={`h-8 rounded-[9px] px-4 capitalize ${view === v ? "bg-surface text-foreground shadow-soft" : "text-muted"}`}
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
              </div>

              <div className="mt-8 grid gap-4 sm:grid-cols-2">
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
                  A score of 90 means near the top of this list. It does not mean a 90% chance of working.
                </Note>
              </div>
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

function Stat({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center bg-surface px-4 py-8 text-center">
      <div className={`text-[clamp(36px,4.6vw,52px)] font-extrabold leading-none tabular-nums tracking-[-0.045em] ${accent ? "text-accent" : ""}`}>{value}</div>
      <p className="mt-2.5 max-w-[180px] text-[14px] leading-snug text-muted">{label}</p>
    </div>
  );
}

function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[20px] border border-line bg-surface/60 p-6">
      <h3 className="text-[17px] font-bold tracking-[-0.015em]">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}
