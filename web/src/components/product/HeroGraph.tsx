"use client";

import { useState } from "react";

// Real example from the graph: baclofen reaches Rett syndrome through GABBR2,
// and again through its look-alike arbaclofen. Hover a node to trace its edges.
type N = { id: string; x: number; y: number; r: number; fill: string; label: string; mono?: boolean; note: string };
const NODES: N[] = [
  { id: "bac", x: 60, y: 220, r: 26, fill: "var(--drug)", label: "Baclofen", note: "Approved GABA-B receptor agonist" },
  { id: "gab", x: 215, y: 110, r: 17, fill: "var(--gene)", label: "GABBR2", mono: true, note: "Gene linked to Rett syndrome (evidence 0.55)" },
  { id: "arb", x: 200, y: 330, r: 15, fill: "var(--drug-soft)", label: "Arbaclofen", note: "Its active form: 100% structurally similar" },
  { id: "rett", x: 360, y: 220, r: 30, fill: "var(--disease)", label: "Rett syndrome", note: "Rare neurodevelopmental disorder" },
];
const EDGES = [
  { id: "e1", a: "bac", b: "gab", d: "M60 220 C 140 220, 150 110, 215 110", dashed: false, label: "agonist" },
  { id: "e2", a: "gab", b: "rett", d: "M215 110 C 290 110, 300 220, 360 220", dashed: false, label: "associated" },
  { id: "e3", a: "bac", b: "arb", d: "M60 220 C 120 300, 150 330, 200 330", dashed: true, label: "look-alike" },
  { id: "e4", a: "arb", b: "gab", d: "M200 330 C 250 330, 225 160, 215 110", dashed: false, label: "agonist" },
];

export default function HeroGraph() {
  const [hover, setHover] = useState<string | null>(null);
  const active = (e: (typeof EDGES)[number]) => !hover || e.a === hover || e.b === hover;
  const node = NODES.find((n) => n.id === hover);

  return (
    <div className="relative">
      <svg
        role="img"
        aria-label="Baclofen links to Rett syndrome through the gene GABBR2, and through its look-alike arbaclofen"
        viewBox="0 0 420 440"
        className="w-full"
      >
        {EDGES.map((e, i) => (
          <path
            key={e.id}
            d={e.d}
            pathLength={1}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={e.dashed ? 2.5 : 3}
            strokeLinecap="round"
            className="draw"
            style={{
              animationDelay: `${200 + i * 260}ms`,
              strokeOpacity: active(e) ? 0.45 : 0.08,
              transition: "stroke-opacity .3s",
              ...(e.dashed ? { strokeDasharray: "0.02 0.025", strokeDashoffset: 0, animation: "none" } : {}),
            }}
          />
        ))}
        {NODES.map((n, i) => (
          <g
            key={n.id}
            tabIndex={0}
            role="button"
            aria-label={`${n.label}: ${n.note}`}
            onMouseEnter={() => setHover(n.id)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(n.id)}
            onBlur={() => setHover(null)}
            style={{ cursor: "pointer", outline: "none", opacity: !hover || hover === n.id || EDGES.some((e) => active(e) && (e.a === n.id || e.b === n.id)) ? 1 : 0.3, transition: "opacity .3s" }}
          >
            {(n.id === "bac" || n.id === "rett") && (
              <circle cx={n.x} cy={n.y} r={n.r} fill={n.fill} className="pulse-ring" style={{ animationDelay: `${i * 600}ms` }} />
            )}
            <circle cx={n.x} cy={n.y} r={hover === n.id ? n.r + 4 : n.r} fill={n.fill} style={{ transition: "r .25s" }} />
            <text
              x={n.x}
              y={n.id === "gab" ? n.y - n.r - 14 : n.y + n.r + 24}
              textAnchor="middle"
              className={n.mono ? "font-mono" : "font-sans"}
              fontWeight={n.mono ? 500 : 700}
              fontSize={n.mono ? 13 : 15}
              fill="var(--foreground)"
            >
              {n.label}
            </text>
          </g>
        ))}
      </svg>
      <p className="absolute inset-x-0 -bottom-2 h-6 text-center text-sm text-muted" aria-live="polite">
        {node ? node.note : "Hover a node to trace it"}
      </p>
    </div>
  );
}
