"use client";

// Handles /d/:diseaseId and /d/:diseaseId/:drugId. The URL is the source of
// truth for the selected disease and drug.
//
// The disease page is the design run: it starts as the page opens, and because
// the start call is idempotent, a reload reattaches to the run already going
// instead of beginning a second one. The ranked drugs are still here, one tab
// over, as the evidence the design was built on.

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import CandidateLists from "@/components/CandidateLists";
import DetailPanel from "@/components/DetailPanel";
import DiseaseSearch from "@/components/DiseaseSearch";
import ErrorCard from "@/components/ErrorCard";
import Footer from "@/components/Footer";
import RunView from "@/components/run/RunView";
import { getCandidates } from "@/lib/api";
import { READINESS } from "@/lib/format";
import type { Readiness } from "@/lib/types";
import { useRun } from "@/lib/useRun";

const KEY: Readiness[] = ["APPROVED_UNTESTED", "IN_TRIALS", "OFF_LABEL", "SAFETY_CONCERN"];

type View = "design" | "drugs";

export default function Results() {
  const params = useParams<{ diseaseId: string; drugId?: string[] }>();
  const router = useRouter();
  const diseaseId = decodeURIComponent(params.diseaseId);
  const drugId = params.drugId?.[0] ? decodeURIComponent(params.drugId[0]) : undefined;

  const q = useQuery({ queryKey: ["candidates", diseaseId], queryFn: () => getCandidates(diseaseId) });
  const data = q.data;
  const candidate = data && drugId ? [...data.approved, ...data.investigational].find((c) => c.drug_id === drugId) : undefined;

  // The run lives here rather than inside the tab, so switching to the ranked
  // drugs and back does not tear the stream down and start over.
  const run = useRun(diseaseId);
  const [view, setView] = useState<View>(drugId ? "drugs" : "design");
  useEffect(() => {
    if (drugId) setView("drugs");
  }, [drugId]);

  const name = data?.disease.name ?? run.job?.disease_name ?? "";
  const ranked = data ? data.approved.length + data.investigational.length : null;

  const show = (next: View) => {
    setView(next);
    // keep the URL honest: the design view is not about one drug
    if (next === "design" && drugId) router.push(`/d/${encodeURIComponent(diseaseId)}`, { scroll: false });
  };

  return (
    <div>
      <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
        {/* disease band: what is being designed for, and the search to change it */}
        <section className="flex flex-col items-center pb-7 pt-8 text-center sm:pt-12">
          {!name && (
            <div className="flex w-full flex-col items-center gap-4">
              <div className="skeleton h-4 w-48" />
              <div className="skeleton h-14 w-[min(420px,90%)]" />
            </div>
          )}
          {name && (
            <>
              <p className="flex items-center gap-2 text-[14px] font-semibold text-muted">
                <span className="h-2.5 w-2.5 rounded-full bg-disease" />
                Designing new molecules for
              </p>
              <h1 className="mt-2 max-w-[900px] text-[clamp(36px,5.4vw,64px)] font-extrabold leading-[1] tracking-[-0.045em]">
                {name}
              </h1>
            </>
          )}
          {data && (
            <>
              <div className="mt-7 grid w-full max-w-[640px] grid-cols-3 rounded-[28px] bg-surface shadow-soft">
                <Fact n={data.disease.n_genes} label={data.disease.n_genes === 1 ? "gene linked to it" : "genes linked to it"} />
                <Fact n={data.approved.length} label="approved drugs to build on" />
                <Fact
                  n={data.already_approved_total}
                  label="already approved for it, left out"
                  title="Drugs already approved for this disease or a close relative are hidden, so the design starts from a new idea."
                />
              </div>
              {data.warning === "LOW_GRAPH_COVERAGE" && (
                <p className="mt-5 max-w-[560px] rounded-2xl bg-[#FBEFD9] px-4 py-2.5 text-[14px] font-semibold text-[#6B4A06]">
                  Very few genes are known for this disease, so the drugs the design builds on are ranked weakly.
                </p>
              )}
            </>
          )}
          <div className="mt-6 w-full max-w-[420px]">
            <DiseaseSearch compact initial={name} />
          </div>
        </section>

        {/* the two halves of the page: what was designed, and what it was designed from */}
        <div role="tablist" aria-label="View" className="mx-auto mb-7 grid w-full max-w-[460px] grid-cols-2 gap-1 rounded-full bg-soft p-1 text-[14px] font-semibold">
          {([
            ["design", "Designed molecules", null],
            ["drugs", "Ranked drugs", ranked],
          ] as [View, string, number | null][]).map(([key, label, count]) => (
            <button
              key={key}
              role="tab"
              id={`view-${key}`}
              aria-selected={view === key}
              aria-controls={`view-panel-${key}`}
              tabIndex={view === key ? 0 : -1}
              onClick={() => show(key)}
              className={`flex h-11 items-center justify-center gap-2 rounded-full px-3 transition-colors ${
                view === key ? "bg-surface text-foreground shadow-soft" : "text-muted hover:text-foreground"
              }`}
            >
              <span className="truncate">{label}</span>
              {count != null && (
                <span className="rounded-full bg-accent-soft px-1.5 text-[11.5px] tabular-nums text-accent-ink">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        {view === "design" && (
          <div role="tabpanel" id="view-panel-design" aria-labelledby="view-design">
            <RunView run={run} />
          </div>
        )}

        {view === "drugs" && (
          <div role="tabpanel" id="view-panel-drugs" aria-labelledby="view-drugs">
            {q.isError && (
              <div className="mx-auto max-w-xl">
                <ErrorCard msg="Could not load drugs for this disease." detail={(q.error as Error)?.message} onRetry={() => q.refetch()} />
              </div>
            )}
            {q.isLoading && (
              <div className="space-y-3">
                <div className="skeleton h-16" />
                <div className="skeleton h-16" />
                <div className="skeleton h-16" />
              </div>
            )}
            {data && (
              <>
                <p className="mx-auto mb-5 max-w-[70ch] text-center text-[14.5px] leading-relaxed text-muted">
                  Existing drugs, ranked by how well the biology connects them to {name}. This is the evidence each
                  track reads before it designs anything, and every one of these is a real medicine with a real safety
                  record.
                </p>

                {/* how to read the colours, once, for the whole list */}
                <ul aria-label="What the colours mean" className="mb-5 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[13px] text-muted">
                  {KEY.map((k) => (
                    <li key={k} className="flex items-center gap-1.5" title={READINESS[k].hint}>
                      <span className="h-2 w-2 rounded-full" style={{ background: READINESS[k].dot }} />
                      <span className="font-semibold text-foreground">{READINESS[k].label}</span>
                      <span className="max-md:hidden">{shortHint(k)}</span>
                    </li>
                  ))}
                </ul>

                <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                  <section aria-label="Ranked drugs" className={`min-w-0 ${drugId ? "max-lg:hidden" : ""}`}>
                    <CandidateLists key={diseaseId} data={data} selected={drugId} />
                  </section>

                  <section aria-label="Selected drug" className={`min-w-0 lg:sticky lg:top-24 ${drugId ? "" : "max-lg:hidden"}`}>
                    {drugId && (
                      <Link
                        href={`/d/${encodeURIComponent(diseaseId)}`}
                        className="mb-3 inline-flex h-10 items-center gap-2 text-sm font-semibold text-accent-ink lg:hidden"
                      >
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24">
                          <path d="M19 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Back to the list
                      </Link>
                    )}
                    {!drugId && <EmptyDetail />}
                    {drugId && !candidate && (
                      <ErrorCard msg="This drug is not in the list" detail={`${drugId} is not among the candidates for ${name}.`} />
                    )}
                    {drugId && candidate && <DetailPanel key={drugId} disease={data.disease} candidate={candidate} weights={data.weights} />}
                  </section>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
}

function shortHint(k: Readiness) {
  return {
    APPROVED_UNTESTED: "nobody has tried it",
    IN_TRIALS: "being tested now",
    OFF_LABEL: "doctors already use it",
    SAFETY_CONCERN: "check before going further",
    INVESTIGATIONAL: "",
    WITHDRAWN: "",
  }[k];
}

function Fact({ n, label, title }: { n: number; label: string; title?: string }) {
  return (
    <div className="flex flex-col items-center px-2 py-4 sm:px-4" title={title}>
      <div className="text-[26px] font-bold leading-none tabular-nums tracking-[-0.03em] sm:text-[30px]">{n.toLocaleString()}</div>
      <p className="mt-1.5 text-[12px] leading-tight text-muted sm:text-[13px]">{label}</p>
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="grid min-h-[480px] place-items-center rounded-[36px] bg-soft-2 p-10 text-center">
      <div className="max-w-[340px]">
        <svg aria-hidden="true" viewBox="0 0 200 40" className="mx-auto w-[180px]">
          <path d="M20 20 H 180" stroke="var(--line-strong)" strokeWidth="2" strokeDasharray="5 6" />
          <circle cx="20" cy="20" r="10" fill="var(--drug)" />
          <circle cx="100" cy="20" r="7" fill="var(--gene)" />
          <circle cx="180" cy="20" r="10" fill="var(--disease)" />
        </svg>
        <p className="mt-6 text-[20px] font-bold tracking-[-0.02em]">Pick a drug to see why it is here</p>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">
          You will see the genes that connect it to this disease, the evidence for and against, its 3D structure, and a
          design built from that one drug alone.
        </p>
      </div>
    </div>
  );
}
