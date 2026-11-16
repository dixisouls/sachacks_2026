"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import DiseaseSearch from "@/components/DiseaseSearch";
import Footer from "@/components/Footer";
import HeroChain from "@/components/product/HeroChain";
import HeroResult from "@/components/product/HeroResult";
import LiveDemo from "@/components/product/LiveDemo";
import PathExplorer from "@/components/product/PathExplorer";
import { getEval } from "@/lib/api";
import { DEMO_DISEASES } from "@/lib/config";

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto mb-10 max-w-[720px] text-center">
      <h2 className="text-[clamp(30px,4.2vw,48px)] font-extrabold leading-[1.05] tracking-[-0.04em]">{title}</h2>
      {children && <p className="mx-auto mt-4 max-w-[580px] text-[17px] leading-relaxed text-muted">{children}</p>}
    </div>
  );
}

const STEPS = [
  ["Name a disease", "Search 36,740 diseases by name or synonym. The run starts as the page opens."],
  [
    "Three tracks design at once",
    "One builds on approved drugs, one on compounds others tried and dropped, one on everything known. Each picks its own drug to start from.",
  ],
  [
    "Judge what came out",
    "Rejected attempts stay on screen next to the one that survived, and the ranked drugs the design learned from are one tab away.",
  ],
];

export default function Home() {
  const ev = useQuery({ queryKey: ["eval"], queryFn: getEval });
  const m = ev.data?.methods;
  const ours = m?.repurposekg?.["hits@10"];
  const pop = m?.popularity?.["hits@10"];
  const rnd = m?.random?.["hits@10"];

  return (
    <div>
      {/* hero: a finished molecule, because that is the product. The search is
          further down, where someone who wants their own disease will look. */}
      <section className="mx-auto max-w-[1180px] px-4 pb-16 pt-14 sm:px-8 sm:pt-20">
        <div className="mx-auto max-w-[860px] text-center">
          <h1 className="text-[clamp(42px,7vw,88px)] font-extrabold leading-[0.94] tracking-[-0.055em]">
            A drug designer that
            <br />
            shows its failures.
          </h1>
          <p className="mx-auto mt-7 max-w-[640px] text-[clamp(17px,1.6vw,20px)] leading-relaxed text-muted">
            Scaffold takes a disease, picks approved drugs that already reach it through biology, and designs new
            molecules from them. A chemistry engine judges every one, and the rejects stay on the page beside the
            survivor.
          </p>
        </div>
        <div className="mt-12">
          <HeroResult />
        </div>
      </section>

      {/* how to read every result */}
      <section className="mx-auto max-w-[1100px] px-4 sm:px-8">
        <div className="panel px-4 py-10 sm:px-10 sm:py-14">
          <p className="mb-10 text-center text-[17px] font-semibold tracking-[-0.01em] sm:text-[19px]">
            What a design learns from is a chain you can read left to right.
          </p>
          <HeroChain />
        </div>
      </section>

      {/* steps: a real sequence, so it is numbered */}
      <section className="mx-auto max-w-[1100px] px-4 pt-28 sm:px-8">
        <SectionHead title="One disease in, three molecules out." />
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="flex flex-col items-center rounded-[28px] bg-surface px-6 py-8 text-center shadow-soft">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-mint text-[16px] font-bold text-accent-ink">{i + 1}</span>
              <h3 className="mt-4 text-[19px] font-bold tracking-[-0.02em]">{t}</h3>
              <p className="mt-2 max-w-[260px] text-[15px] leading-relaxed text-muted">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* four ways */}
      <section id="how" className="mx-auto max-w-[1280px] scroll-mt-24 px-4 pt-28 sm:px-8">
        <SectionHead title="Four ways a drug can reach a disease.">
          The design starts from whichever drug these reasons rank highest. One real example, cannabidiol for Rett
          syndrome, uses all four. Pick one to trace it.
        </SectionHead>
        <PathExplorer />
      </section>

      {/* live */}
      <section className="mx-auto max-w-[760px] px-4 pt-24 sm:px-8">
        <SectionHead title="The evidence underneath.">
          Existing drugs, ranked by those four reasons. This is what each track reads before it designs anything, and it
          stays available beside the result. Drugs already approved for the disease are left out.
        </SectionHead>
        <LiveDemo />
      </section>

      {/* proof */}
      <section className="mx-auto max-w-[1100px] px-4 pt-28 sm:px-8">
        <SectionHead title="Hide what we know. See if it comes back.">
          We removed 20% of known approved treatments from the graph and asked it to rank them back. This tests the
          ranking the design starts from. It does not test the molecules that come out.
        </SectionHead>
        <div className="grid rounded-[32px] bg-surface shadow-float md:grid-cols-3">
          <Stat value={ours != null ? `${(ours * 100).toFixed(1)}%` : "…"} label="of hidden treatments come back in the top 10" accent />
          <Stat value={ours != null && pop ? `${(ours / pop).toFixed(1)}×` : "…"} label="better than ranking by popularity" />
          <Stat value={ours != null && rnd ? `${Math.round(ours / rnd)}×` : "…"} label="better than picking at random" />
        </div>
        <p className="mt-6 text-center">
          <Link href="/validation" className="inline-flex h-10 items-center text-[15px] font-semibold text-accent-ink underline-offset-4 hover:underline">
            See how we tested it
          </Link>
        </p>
      </section>

      {/* where someone who wants their own disease goes */}
      <section id="start" className="mx-auto max-w-[1100px] scroll-mt-24 px-4 pt-28 sm:px-8">
        <SectionHead title="Design for a disease.">
          36,740 diseases. The run starts as the page opens and takes a few minutes; the two below are already
          finished, so they open at once.
        </SectionHead>
        <div className="mx-auto max-w-[680px]">
          <DiseaseSearch />
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[14px]">
            <span className="text-muted">Already run</span>
            {DEMO_DISEASES.slice(0, 2).map((d) => (
              <Link
                key={d.disease_id}
                href={`/d/${d.disease_id}`}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-surface px-3.5 font-semibold shadow-soft transition-colors hover:bg-lilac"
              >
                <span className="h-2 w-2 rounded-full bg-disease" />
                {d.name}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* principle */}
      <section className="mx-auto max-w-[1100px] px-4 pt-24 sm:px-8">
        <div className="rounded-[28px] bg-foreground px-6 py-16 text-center text-surface sm:px-14">
          <h2 className="text-[clamp(32px,4.4vw,52px)] font-extrabold leading-[1.02] tracking-[-0.04em]">
            Nothing here tests binding.
          </h2>
          <p className="mx-auto mt-5 max-w-[640px] text-[17px] leading-relaxed text-surface/75">
            The checks ask whether a structure is real chemistry a chemist could make. 82% of random molecules pass them,
            and so does the approved drug each design started from. They cannot tell you whether a molecule binds
            anything. The model explains and assembles; it never invents the biology, and every claim points to a graph
            edge, a trial or a paper. Scaffold says all of this beside every result, not in a footnote.
          </p>
          <Link
            href="/app"
            className="mt-10 inline-flex h-12 items-center rounded-full bg-surface px-7 text-[15px] font-semibold text-foreground transition-colors hover:bg-accent-soft"
          >
            Design molecules for a disease
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}

function Stat({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className={`text-[clamp(48px,6vw,68px)] font-extrabold leading-none tabular-nums tracking-[-0.045em] ${accent ? "text-accent" : ""}`}>{value}</div>
      <p className="mt-3 max-w-[220px] text-[15px] leading-snug text-muted">{label}</p>
    </div>
  );
}
