"use client";

// Handles /d/:diseaseId and /d/:diseaseId/:drugId (architecture.md §10.1).
// The URL is the source of truth for the selected disease and drug.

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import Blobs from "@/components/Blobs";
import CandidateLists from "@/components/CandidateLists";
import DetailPanel from "@/components/DetailPanel";
import DiseaseSearch from "@/components/DiseaseSearch";
import ErrorCard from "@/components/ErrorCard";
import Footer from "@/components/Footer";
import { getCandidates } from "@/lib/api";

export default function Results() {
  const params = useParams<{ diseaseId: string; drugId?: string[] }>();
  const diseaseId = decodeURIComponent(params.diseaseId);
  const drugId = params.drugId?.[0] ? decodeURIComponent(params.drugId[0]) : undefined;

  const q = useQuery({ queryKey: ["candidates", diseaseId], queryFn: () => getCandidates(diseaseId) });
  const data = q.data;
  const candidate = data && drugId ? [...data.approved, ...data.investigational].find((c) => c.drug_id === drugId) : undefined;

  return (
    <div className="relative isolate overflow-hidden">
      <Blobs variant="lilac" />
      <div className="mx-auto max-w-[1320px] px-4 pb-10 sm:px-8">
        <div className="max-w-[460px]">
          <DiseaseSearch compact initial={data?.disease.name ?? ""} />
        </div>

        {q.isLoading && (
          <div className="mt-10 space-y-3">
            <div className="skeleton h-14 w-80" />
            <div className="skeleton h-4 w-96" />
          </div>
        )}
        {q.isError && (
          <div className="mt-10 max-w-xl">
            <ErrorCard msg="Could not load candidates." detail={(q.error as Error)?.message} onRetry={() => q.refetch()} />
          </div>
        )}

        {data && (
          <>
            <header className="mt-10">
              <p className="text-sm font-semibold text-muted">
                <span className="font-mono font-normal">{data.disease.disease_id}</span> · {data.disease.n_genes} associated genes ·{" "}
                {data.already_approved_total} {data.already_approved_total === 1 ? "drug" : "drugs"} already approved for this family, hidden
              </p>
              <h1 className="mt-2 text-[clamp(38px,5vw,60px)] font-extrabold leading-none tracking-[-0.04em]">{data.disease.name}</h1>
              {data.warning === "LOW_GRAPH_COVERAGE" && (
                <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#FBEFD9] px-4 py-2 text-sm font-semibold text-[#6B4A06]">
                  Few known genes for this disease, so results are weak. Try a broader parent disease.
                </p>
              )}
            </header>

            <div className="mt-8 flex flex-wrap items-start gap-8">
              <section aria-label="Candidates" className={`min-w-0 flex-[1_1_380px] lg:max-w-[480px] ${drugId ? "hidden lg:block" : ""}`}>
                <CandidateLists key={diseaseId} data={data} selected={drugId} />
              </section>

              <section className={`min-w-0 flex-[999_1_560px] lg:sticky lg:top-6 ${drugId ? "" : "hidden lg:block"}`}>
                {drugId && (
                  <Link href={`/d/${encodeURIComponent(diseaseId)}`} className="mb-3 inline-flex min-h-11 items-center gap-2 text-sm font-bold text-accent-ink lg:hidden">
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    All candidates
                  </Link>
                )}
                {!drugId && (
                  <div className="grid min-h-[420px] place-items-center rounded-[36px] border-2 border-dashed border-soft p-10 text-center">
                    <div>
                      <p className="text-xl font-extrabold tracking-tight">Pick a drug to see why</p>
                      <p className="mt-2 text-[15px] text-muted">The path from drug to disease, and the evidence brief.</p>
                    </div>
                  </div>
                )}
                {drugId && !candidate && (
                  <ErrorCard msg="Not in this list" detail={`${drugId} is not among the candidates for ${data.disease.name}.`} />
                )}
                {drugId && candidate && (
                  <DetailPanel key={drugId} disease={data.disease} candidate={candidate} weights={data.weights} />
                )}
              </section>
            </div>
          </>
        )}
      </div>
      <Footer />
    </div>
  );
}
