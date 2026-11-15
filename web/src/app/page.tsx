"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import DiseaseSearch from "@/components/DiseaseSearch";
import Footer from "@/components/Footer";
import HeroChain from "@/components/product/HeroChain";
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
  ["Name a disease", "Search 36,740 diseases by name or synonym."],
  ["Scan the ranked drugs", "Approved drugs, best-supported first. Each shows the genes it reaches."],
  ["Open one to see why", "The chain from drug to disease, the evidence for and against, and the 3D structure."],
];

export default function Home() {
  const ev = useQuery({ queryKey: ["eval"], queryFn: getEval });
  const m = ev.data?.methods;
  const ours = m?.repurposekg?.["hits@10"];
  const pop = m?.popularity?.["hits@10"];
  const rnd = m?.random?.["hits@10"];

  return (
    <div>
      {/* hero: the search is the product, so it is the hero */}
      <section className="mx-auto flex max-w-[1280px] flex-col items-center px-4 pb-20 pt-16 text-center sm:px-8 sm:pt-24">
        <h1 className="max-w-[900px] text-[clamp(46px,8vw,100px)] font-extrabold leading-[0.92] tracking-[-0.055em]">
          Old medicines,
          <br />
          new reasons.
        </h1>
        <p className="mt-7 max-w-[600px] text-[clamp(17px,1.6vw,20px)] leading-relaxed text-muted">
          Name a disease. See which approved drugs might treat it, and the chain of biology that connects each one.
        </p>
        <div className="mt-10 w-full max-w-[680px]">
          <DiseaseSearch />
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[14px]">
          <span className="text-muted">Or try</span>
          {DEMO_DISEASES.map((d) => (
            <Link
              key={d.disease_id}
              href={`/d/${d.disease_id}`}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3.5 font-semibold transition-colors hover:border-disease"
            >
              <span className="h-2 w-2 rounded-full bg-disease" />
              {d.name}
            </Link>
          ))}
        </div>
      </section>

      {/* how to read every result */}
      <section className="mx-auto max-w-[1100px] px-4 sm:px-8">
        <div className="panel px-4 py-10 sm:px-10 sm:py-14">
          <p className="mb-10 text-center text-[17px] font-semibold tracking-[-0.01em] sm:text-[19px]">Every result is a chain you can read left to right.</p>
          <HeroChain />
        </div>
      </section>

      {/* steps: a real sequence, so it is numbered */}
      <section className="mx-auto max-w-[1100px] px-4 pt-28 sm:px-8">
        <SectionHead title="Three steps, about a minute." />
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map(([t, d], i) => (
            <li key={t} className="flex flex-col items-center rounded-[20px] border border-line bg-surface/60 px-6 py-8 text-center">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-foreground text-[16px] font-bold text-surface">{i + 1}</span>
              <h3 className="mt-4 text-[19px] font-bold tracking-[-0.02em]">{t}</h3>
              <p className="mt-2 max-w-[260px] text-[15px] leading-relaxed text-muted">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* four ways */}
      <section id="how" className="mx-auto max-w-[1280px] scroll-mt-24 px-4 pt-28 sm:px-8">
        <SectionHead title="Four ways a drug can reach a disease.">
          One real example, cannabidiol for Rett syndrome, uses all four. Pick one to trace it.
        </SectionHead>
        <PathExplorer />
      </section>

      {/* live */}
      <section className="mx-auto max-w-[760px] px-4 pt-24 sm:px-8">
        <SectionHead title="Try it right here.">
          Real rankings. Drugs already approved for the disease are left out, so everything you see is a new idea.
        </SectionHead>
        <LiveDemo />
      </section>

      {/* proof */}
      <section className="mx-auto max-w-[1100px] px-4 pt-28 sm:px-8">
        <SectionHead title="Hide what we know. See if it comes back.">
          We removed 20% of known approved treatments from the graph and asked it to rank them back.
        </SectionHead>
        <div className="grid divide-line rounded-[24px] border border-line bg-surface max-md:divide-y md:grid-cols-3 md:divide-x">
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

      {/* principle */}
      <section className="mx-auto max-w-[1100px] px-4 pt-24 sm:px-8">
        <div className="rounded-[28px] bg-foreground px-6 py-16 text-center text-surface sm:px-14">
          <h2 className="text-[clamp(32px,4.4vw,52px)] font-extrabold leading-[1.02] tracking-[-0.04em]">No source, no sentence.</h2>
          <p className="mx-auto mt-5 max-w-[620px] text-[17px] leading-relaxed text-surface/75">
            The language model explains and assembles. It never invents the biology. Every claim points to a graph edge, a
            trial or a paper, and claims without one are removed before you see them.
          </p>
          <Link
            href="/app"
            className="mt-10 inline-flex h-12 items-center rounded-full bg-surface px-7 text-[15px] font-semibold text-foreground transition-colors hover:bg-accent-soft"
          >
            Find drugs for a disease
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
