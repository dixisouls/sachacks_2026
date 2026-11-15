"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PathType } from "@/lib/types";

// Real paths from the backend for cannabidiol and Rett syndrome (all four types occur).
const NODES = {
  cbd: { x: 70, y: 190, r: 24, fill: "var(--drug)", label: "Cannabidiol", mono: false },
  rett: { x: 650, y: 190, r: 28, fill: "var(--disease)", label: "Rett syndrome", mono: false },
  cnr1: { x: 430, y: 80, r: 15, fill: "var(--gene)", label: "CNR1", mono: true },
  nabi: { x: 230, y: 56, r: 13, fill: "#F0A46B", label: "Nabiximols", mono: false },
  htr2a: { x: 250, y: 270, r: 14, fill: "var(--gene)", label: "HTR2A", mono: true },
  htr2c: { x: 450, y: 290, r: 14, fill: "var(--gene)", label: "HTR2C", mono: true },
  asd: { x: 360, y: 372, r: 14, fill: "#CF7FB6", label: "Autism spectrum disorder", mono: false },
} as const;
type K = keyof typeof NODES;

const EDGES: { a: K; b: K; dashed?: boolean; tag: string }[] = [
  { a: "cbd", b: "cnr1", tag: "targets" },
  { a: "cnr1", b: "rett", tag: "associated" },
  { a: "cbd", b: "asd", tag: "treats" },
  { a: "asd", b: "rett", tag: "sibling" },
  { a: "cbd", b: "nabi", dashed: true, tag: "73% similar" },
  { a: "nabi", b: "cnr1", tag: "targets" },
  { a: "cbd", b: "htr2a", tag: "targets" },
  { a: "htr2a", b: "htr2c", dashed: true, tag: "61% identical" },
  { a: "htr2c", b: "rett", tag: "associated" },
];

const STORIES: { type: PathType; title: string; chain: K[]; text: string; inferred: boolean }[] = [
  { type: "shared_biology", title: "Shared biology", chain: ["cbd", "cnr1", "rett"], inferred: false, text: "Cannabidiol targets CNR1, which is associated with Rett syndrome." },
  { type: "sibling_disease", title: "Sibling disease", chain: ["cbd", "asd", "rett"], inferred: false, text: "Cannabidiol treats autism spectrum disorder, a sibling of Rett syndrome." },
  { type: "chemical_analog", title: "Look-alike drug", chain: ["cbd", "nabi", "cnr1", "rett"], inferred: true, text: "Cannabidiol is 73% structurally similar to nabiximols, which targets CNR1, a gene associated with Rett syndrome." },
  { type: "protein_homolog", title: "Related protein", chain: ["cbd", "htr2a", "htr2c", "rett"], inferred: true, text: "Cannabidiol targets HTR2A, whose protein is 61% identical to HTR2C, a gene associated with Rett syndrome." },
];

function curve(a: K, b: K) {
  const p = NODES[a], q = NODES[b];
  const mx = (p.x + q.x) / 2;
  return `M${p.x} ${p.y} C ${mx} ${p.y}, ${mx} ${q.y}, ${q.x} ${q.y}`;
}

export default function PathExplorer() {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  // the 720-wide drawing shrinks to ~0.45x on a phone; scale labels and nodes back up so they stay readable
  const [fs, setFs] = useState(1);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setFs(mq.matches ? 1.9 : 1);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => setI((x) => (x + 1) % STORIES.length), 3800);
    return () => clearInterval(t);
  }, [auto]);

  const s = STORIES[i];
  const onChain = (a: K, b: K) => s.chain.some((k, j) => (k === a && s.chain[j + 1] === b) || (k === b && s.chain[j + 1] === a));

  return (
    <div className="flex flex-col items-center">
      <div role="group" aria-label="Path types" className="grid w-full max-w-[760px] grid-cols-2 gap-1 rounded-[16px] border border-line bg-surface p-1 sm:grid-cols-4">
        {STORIES.map((st, j) => (
          <button
            key={st.type}
            aria-pressed={j === i}
            onClick={() => {
              setI(j);
              setAuto(false);
            }}
            className={`flex h-11 items-center justify-center gap-2 rounded-[12px] px-3 text-[14px] font-semibold transition-colors ${
              j === i ? "bg-foreground text-surface" : "text-muted hover:bg-sunken hover:text-foreground"
            }`}
          >
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={st.inferred ? { border: "2px dashed currentColor" } : { background: "currentColor" }}
            />
            {st.title}
          </button>
        ))}
      </div>

      <div className="panel mt-6 w-full max-w-[960px] p-2 sm:p-4">
        <svg viewBox={fs > 1 ? "-50 -30 830 480" : "0 0 720 420"} className="w-full" role="img" aria-label={s.text}>
          {EDGES.map((e) => {
            const on = onChain(e.a, e.b);
            return (
              <path
                key={e.a + e.b}
                d={curve(e.a, e.b)}
                fill="none"
                stroke={on ? "var(--accent)" : "var(--foreground)"}
                strokeOpacity={on ? 0.9 : 0.1}
                strokeWidth={(on ? 4 : 2) * Math.min(fs, 1.5)}
                strokeDasharray={e.dashed ? "7 7" : undefined}
                strokeLinecap="round"
                style={{ transition: "all .5s ease" }}
              />
            );
          })}
          {(Object.keys(NODES) as K[]).map((k) => {
            const n = NODES[k];
            const on = s.chain.includes(k);
            return (
              <g key={k} style={{ opacity: on ? 1 : 0.25, transition: "opacity .5s ease" }}>
                <circle cx={n.x} cy={n.y} r={(on ? n.r + 2 : n.r) * Math.min(fs, 1.35)} fill={n.fill} style={{ transition: "r .4s" }} />
                <text
                  x={n.x}
                  y={n.y < 120 ? n.y - n.r * Math.min(fs, 1.35) - 12 * fs : n.y + n.r * Math.min(fs, 1.35) + 20 * fs}
                  textAnchor="middle"
                  fontSize={(n.mono ? 13 : 14) * fs}
                  fontWeight={n.mono ? 500 : 700}
                  className={n.mono ? "font-mono" : "font-sans"}
                  fill="var(--foreground)"
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-8 flex min-h-[150px] max-w-[680px] flex-col items-center text-center">
        <p key={s.type} className="fadein text-[clamp(20px,2.4vw,26px)] font-semibold leading-snug tracking-[-0.02em]">
          {s.text}
        </p>
        <p className="mt-3 text-[14px] text-muted">
          {s.inferred ? "Inferred from similarity, so it is drawn dashed and never stated as fact." : "Recorded in the knowledge graph."}
        </p>
        <Link href="/d/MONDO_0010726/CHEMBL190461" className="mt-4 inline-flex h-10 items-center text-[14px] font-semibold text-accent-ink underline-offset-4 hover:underline">
          Open cannabidiol for Rett syndrome
        </Link>
      </div>
    </div>
  );
}
