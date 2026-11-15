"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import Blobs from "@/components/Blobs";
import Footer from "@/components/Footer";
import HeroGraph from "@/components/product/HeroGraph";
import LiveDemo from "@/components/product/LiveDemo";
import PathExplorer from "@/components/product/PathExplorer";
import { CountUp, Reveal } from "@/components/product/Reveal";
import { getEval } from "@/lib/api";

function TryMe({ big = false }: { big?: boolean }) {
  return (
    <Link
      href="/app"
      className={`group inline-flex items-center gap-3 rounded-full bg-accent font-bold text-white shadow-soft transition-all hover:-translate-y-0.5 hover:bg-accent-ink ${
        big ? "min-h-16 px-9 text-lg" : "min-h-14 px-7 text-base"
      }`}
    >
      Try me
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" className="transition-transform group-hover:translate-x-1">
        <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

export default function Product() {
  const ev = useQuery({ queryKey: ["eval"], queryFn: getEval });
  const m = ev.data?.methods;
  const ours = m?.repurposekg?.["hits@10"];
  const pop = m?.popularity?.["hits@10"];
  const rnd = m?.random?.["hits@10"];

  return (
    <div className="relative isolate overflow-hidden">
      <Blobs variant="both" />

      {/* hero */}
      <section className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-12 px-4 pb-20 pt-10 sm:px-8 sm:pt-16">
        <div className="min-w-0 flex-[999_1_520px]">
          <p className="text-[15px] font-semibold text-accent-ink [animation:fadein_.6s_ease_both]">
            Drug repurposing, traced through biology
          </p>
          <h1 className="mt-5 text-[clamp(44px,7vw,88px)] font-extrabold leading-[0.96] tracking-[-0.045em] [animation:fadein_.7s_.1s_ease_both]">
            Old medicines,
            <br />
            new reasons.
          </h1>
          <p className="mt-7 max-w-[540px] text-[19px] leading-relaxed text-muted [animation:fadein_.7s_.2s_ease_both]">
            Name a disease. RepurposeKG follows a biomedical knowledge graph from approved drugs, through the genes they
            act on, to the condition you care about, and shows every step.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4 [animation:fadein_.7s_.3s_ease_both]">
            <TryMe />
            <a href="#how" className="inline-flex min-h-14 items-center rounded-full px-6 font-bold text-foreground hover:bg-surface/70">
              How it works
            </a>
          </div>
        </div>
        <div className="min-w-0 flex-[1_1_360px] pb-6">
          <HeroGraph />
        </div>
      </section>

      {/* scale */}
      <Reveal className="mx-auto max-w-[1240px] px-4 sm:px-8">
        <div className="flex flex-wrap gap-x-14 gap-y-6">
          {[
            [13911, "drugs scored"],
            [2924, "of them approved"],
            [36740, "diseases searchable"],
          ].map(([n, l]) => (
            <div key={l}>
              <div className="text-4xl font-extrabold tracking-tight">
                <CountUp to={n as number} />
              </div>
              <div className="mt-1 text-sm text-muted">{l}</div>
            </div>
          ))}
        </div>
      </Reveal>

      {/* how */}
      <section id="how" className="mx-auto max-w-[1240px] scroll-mt-8 px-4 pb-8 pt-28 sm:px-8">
        <Reveal>
          <h2 className="max-w-[720px] text-[clamp(32px,4.5vw,52px)] font-extrabold leading-[1.05] tracking-[-0.035em]">
            Four ways a drug can reach a disease.
          </h2>
          <p className="mt-4 max-w-[600px] text-lg text-muted">
            One real example, cannabidiol for Rett syndrome, connects all four ways. Pick one to trace it.
          </p>
        </Reveal>
        <Reveal delay={120} className="mt-12">
          <PathExplorer />
        </Reveal>
      </section>

      {/* live demo */}
      <section className="mx-auto max-w-[1240px] px-4 pt-28 sm:px-8">
        <div className="flex flex-wrap items-start gap-12">
          <Reveal className="min-w-0 flex-[1_1_300px]">
            <h2 className="text-[clamp(32px,4.5vw,52px)] font-extrabold leading-[1.05] tracking-[-0.035em]">Try it right here.</h2>
            <p className="mt-4 max-w-[420px] text-lg text-muted">
              These are real rankings. Drugs already approved for the disease are hidden, so what is left is new.
            </p>
            <ul className="mt-8 space-y-3 text-[15px]">
              {[
                ["#0B7A69", "Untested: approved, nobody has tried it here"],
                ["#2C6FD1", "In trials: someone is already testing it"],
                ["#C8452A", "Safety concern: contraindication or black box"],
              ].map(([c, t]) => (
                <li key={t} className="flex items-center gap-3">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
                  {t}
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={120} className="min-w-0 flex-[2_1_520px]">
            <LiveDemo />
          </Reveal>
        </div>
      </section>

      {/* proof */}
      <section className="mx-auto max-w-[1240px] px-4 pt-28 sm:px-8">
        <Reveal>
          <h2 className="max-w-[760px] text-[clamp(32px,4.5vw,52px)] font-extrabold leading-[1.05] tracking-[-0.035em]">
            It finds treatments we already know about, when we hide them.
          </h2>
          <p className="mt-4 max-w-[640px] text-lg text-muted">
            We removed a random 20% of known approved treatments from the graph and asked it to rank them back.
          </p>
        </Reveal>
        <Reveal delay={100} className="mt-12 flex flex-wrap gap-x-16 gap-y-10">
          <div>
            <div className="text-[64px] font-extrabold leading-none tracking-tight text-accent-ink">
              {ours != null ? <CountUp to={ours * 100} decimals={1} suffix="%" /> : "…"}
            </div>
            <p className="mt-3 max-w-[220px] text-[15px] text-muted">of hidden treatments come back in the top 10</p>
          </div>
          <div>
            <div className="text-[64px] font-extrabold leading-none tracking-tight">
              {ours != null && pop ? <CountUp to={ours / pop} decimals={1} suffix="×" /> : "…"}
            </div>
            <p className="mt-3 max-w-[220px] text-[15px] text-muted">better than ranking by popularity</p>
          </div>
          <div>
            <div className="text-[64px] font-extrabold leading-none tracking-tight">
              {ours != null && rnd ? <CountUp to={Math.round(ours / rnd)} suffix="×" /> : "…"}
            </div>
            <p className="mt-3 max-w-[220px] text-[15px] text-muted">better than random</p>
          </div>
        </Reveal>
        <Reveal delay={160}>
          <Link href="/validation" className="mt-8 inline-flex min-h-11 items-center gap-2 font-bold text-accent-ink hover:underline">
            See the full validation
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </Link>
        </Reveal>
      </section>

      {/* principle */}
      <section className="mx-auto max-w-[1240px] px-4 pt-28 sm:px-8">
        <Reveal className="rounded-[40px] bg-foreground px-6 py-14 text-background sm:px-14">
          <p className="text-sm font-semibold text-mint">The rule we build on</p>
          <h2 className="mt-4 max-w-[780px] text-[clamp(30px,4vw,48px)] font-extrabold leading-[1.08] tracking-[-0.03em]">
            No source, no sentence.
          </h2>
          <p className="mt-5 max-w-[640px] text-lg leading-relaxed text-background/75">
            The language model explains and assembles. It never invents the biology. Every claim in a brief points to a
            graph edge, a trial or a paper, and claims without one are removed before you see them.
          </p>
        </Reveal>
      </section>

      {/* final CTA */}
      <section className="mx-auto flex max-w-[1240px] flex-col items-center px-4 pb-16 pt-28 text-center sm:px-8">
        <Reveal>
          <h2 className="text-[clamp(36px,5vw,64px)] font-extrabold leading-none tracking-[-0.04em]">Pick a disease.</h2>
          <p className="mx-auto mt-4 max-w-[480px] text-lg text-muted">See which approved drugs might help, and exactly why.</p>
          <div className="mt-10 flex justify-center">
            <TryMe big />
          </div>
        </Reveal>
      </section>

      <Footer />
    </div>
  );
}
