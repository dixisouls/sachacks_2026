"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Core, ElementDefinition } from "cytoscape";
import { kgKey, titleCase } from "@/lib/format";
import type { PathsResponse } from "@/lib/types";

type Props = {
  data: PathsResponse;
  drugId: string;
  diseaseId: string;
  highlight: string | null; // KG citation to highlight
  selectedGene: string | null;
  onGeneClick: (geneId: string) => void;
};

/** True on phone-width screens. */
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

function cssVar(name: string) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

/** Wide screens: left-to-right layers, drug (col 0) → ... → disease (last col), sibling diseases in a row below.
 *  Phones: top-to-bottom layers with at most 3 nodes per row, so labels stay readable instead of shrinking to fit. */
function layout(data: PathsResponse, drugId: string, diseaseId: string, vertical: boolean) {
  const out = new Map<string, string[]>();
  for (const e of data.edges) {
    if (e.target === drugId) continue;
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  }
  const depth = new Map<string, number>([[drugId, 0]]);
  const queue = [drugId];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of out.get(n) ?? []) {
      if (m === diseaseId || depth.has(m)) continue;
      depth.set(m, depth.get(n)! + 1);
      queue.push(m);
    }
  }
  const maxD = Math.max(1, ...depth.values());
  depth.set(diseaseId, maxD + 1);
  for (const n of data.nodes) if (!depth.has(n.id)) depth.set(n.id, 1);

  const siblings = new Set(
    data.nodes.filter((n) => n.type === "disease" && n.id !== diseaseId).map((n) => n.id),
  );
  const cols = new Map<number, string[]>();
  for (const n of data.nodes) {
    if (siblings.has(n.id)) continue;
    const d = depth.get(n.id)!;
    cols.set(d, [...(cols.get(d) ?? []), n.id]);
  }
  const pos: Record<string, { x: number; y: number }> = {};
  if (vertical) {
    const PER_ROW = 3, DX = 112, DY = 84, GAP = 56;
    const layers = [...cols.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids);
    if (siblings.size) layers.splice(layers.length - 1, 0, [...siblings]); // siblings just above the disease
    let y = 0;
    for (const ids of layers) {
      for (let r = 0; r * PER_ROW < ids.length; r++) {
        const row = ids.slice(r * PER_ROW, (r + 1) * PER_ROW);
        row.forEach((id, i) => (pos[id] = { x: (i - (row.length - 1) / 2) * DX, y }));
        y += DY;
      }
      y += GAP;
    }
    const height = Math.max(380, Math.min(1000, y * 0.85 + 60));
    return { pos, height };
  }
  const X = 240, Y = 64;
  let maxRows = 1;
  for (const [d, ids] of cols) {
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, i) => (pos[id] = { x: d * X, y: (i - (ids.length - 1) / 2) * Y }));
  }
  const sibs = [...siblings];
  const sibY = ((maxRows - 1) / 2) * Y + Y * 1.4;
  const span = (maxD + 1) * X;
  sibs.forEach((id, i) => (pos[id] = { x: (span * (i + 1)) / (sibs.length + 1), y: sibY }));
  const ys = Object.values(pos).map((p) => p.y);
  // tall enough that every row keeps a readable label at zoom 1
  const height = Math.max(360, Math.min(760, Math.max(...ys) - Math.min(...ys) + 170));
  return { pos, height };
}

export default function PathGraph({ data, drugId, diseaseId, highlight, selectedGene, onGeneClick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onGeneRef = useRef(onGeneClick);
  onGeneRef.current = onGeneClick;
  const vertical = useNarrow();
  const { pos, height } = useMemo(() => layout(data, drugId, diseaseId, vertical), [data, drugId, diseaseId, vertical]);
  const highlightRef = useRef(highlight);
  const selectedRef = useRef(selectedGene);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cytoscape = (await import("cytoscape")).default;
      if (cancelled || !ref.current) return;
      // the same edge can appear on several paths; draw it once
      const seenEdge = new Set<string>();
      const edges = data.edges.filter((e) => {
        const k = `${e.source}|${e.target}|${e.relation}`;
        if (seenEdge.has(k)) return false;
        seenEdge.add(k);
        return true;
      });
      const maxW = Math.max(0.0001, ...data.edges.map((e) => (e.relation === "ASSOCIATED_WITH" ? e.weight ?? 0 : 0)));

      const els: ElementDefinition[] = [
        ...data.nodes.map((n) => ({
          data: {
            id: n.id,
            label: n.type === "gene" ? (n.label ?? n.id) : titleCase(n.label) || n.id,
            type: n.type,
            main: n.id === drugId || n.id === diseaseId ? 1 : 0,
          },
          position: pos[n.id],
        })),
        ...edges.map((e, i) => ({
          data: {
            id: `e${i}`,
            source: e.source,
            target: e.target,
            label:
              e.relation === "ASSOCIATED_WITH" && e.weight != null
                ? `associated · ${e.weight.toFixed(2)}`
                : e.relation === "SIMILAR_STRUCTURE" && e.weight != null
                  ? `${Math.round(e.weight * 100)}% similar structure`
                  : e.relation === "SIMILAR_SEQUENCE" && e.weight != null
                    ? `${Math.round(e.weight * 100)}% identical sequence`
                    : e.relation.toLowerCase().replace(/_/g, " "),
            width: e.relation === "ASSOCIATED_WITH" && e.weight != null ? 2 + 5 * (e.weight / maxW) : 2.5,
            bend: i % 2 ? 28 : -28,
            inferred: e.inferred ? 1 : 0,
            // match on endpoints so FDA-label citations still line up with KG:{from}|{to} chips
            kg: [e.source, e.target].sort().join("|"),
          },
        })),
      ];

      const fg = cssVar("--foreground"), muted = cssVar("--muted"), field = cssVar("--field");
      const font = getComputedStyle(document.body).fontFamily;
      const mono = cssVar("--font-jetbrains") || "monospace";
      const cy = cytoscape({
        container: ref.current,
        elements: els,
        layout: { name: "preset", fit: true, padding: 40 },
        // No wheel zoom: it hijacks page scrolling, and wheel-zooming this graph froze the renderer.
        // Dragging still pans; "Re-center" refits.
        userZoomingEnabled: false,
        boxSelectionEnabled: false,
        minZoom: 0.4,
        maxZoom: 1.6,
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "font-size": vertical ? 15 : 13,
              "font-family": font,
              "font-weight": 600,
              color: fg,
              "text-valign": "bottom",
              "text-margin-y": 8,
              "text-wrap": "wrap",
              "text-max-width": vertical ? "96px" : "140px",
              width: 28,
              height: 28,
              shape: "ellipse",
              "border-width": 0,
            },
          },
          { selector: "node[type='drug']", style: { "background-color": cssVar("--drug") } },
          { selector: "node[type='gene']", style: { "background-color": cssVar("--gene") } },
          { selector: "node[type='disease']", style: { "background-color": cssVar("--disease") } },
          { selector: "node[main=1]", style: { width: 46, height: 46, "font-weight": 800, "font-size": vertical ? 17 : 15 } },
          { selector: "node[type='gene']", style: { "font-family": mono + ", monospace", "font-weight": 500 } },
          { selector: "node.selected-gene", style: { "border-color": cssVar("--mint"), "border-width": 7 } },
          {
            selector: "edge",
            style: {
              width: "data(width)",
              "line-color": fg,
              "line-cap": "round",
              "target-arrow-shape": "none",
              "curve-style": "unbundled-bezier",
              "control-point-distances": "data(bend)",
              "control-point-weights": 0.5,
              opacity: 0.4,
              label: vertical ? "" : "data(label)",
              "font-size": 11,
              "font-family": font,
              color: muted,
              "text-rotation": "autorotate",
              "text-background-color": field,
              "text-background-opacity": 1,
              "text-background-padding": "2px",
            },
          },
          { selector: "edge[inferred=1]", style: { "line-style": "dashed", "line-dash-pattern": [6, 4] } },
          {
            selector: "edge.hl",
            style: { "line-color": cssVar("--accent"), opacity: 1, width: 7, color: fg },
          },
          { selector: ".faded", style: { opacity: 0.12 } },
        ],
      });
      cy.on("tap", "node[type='gene']", (e) => onGeneRef.current(e.target.id()));
      cy.on("mouseover", "node[type='gene']", () => ref.current && (ref.current.style.cursor = "pointer"));
      cy.on("mouseout", "node", () => ref.current && (ref.current.style.cursor = ""));
      cyRef.current = cy;
      decorateRef.current();
    })();
    return () => {
      cancelled = true;
    };
  }, [data, drugId, diseaseId, pos, vertical]);

  // Destroy cytoscape while its container is still attached. A passive-effect cleanup runs after React
  // has removed the DOM node, and destroying a detached instance hangs the renderer.
  useLayoutEffect(
    () => () => {
      cyRef.current?.destroy();
      cyRef.current = null;
    },
    [data, drugId, diseaseId, vertical],
  );

  // highlight a KG edge cited in the brief, and ring the selected gene.
  // Also re-applied right after the async init, since the instance may not exist yet when these change.
  const decorate = () => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("hl faded selected-gene");
    if (selectedRef.current) cy.getElementById(selectedRef.current).addClass("selected-gene");
    const key = kgKey(highlightRef.current);
    if (!key) return;
    const hit = cy.edges().filter((e) => e.data("kg") === key);
    if (hit.nonempty()) {
      cy.elements().addClass("faded");
      hit.removeClass("faded").addClass("hl").connectedNodes().removeClass("faded");
    }
  };
  const decorateRef = useRef(decorate);
  decorateRef.current = decorate;
  highlightRef.current = highlight;
  selectedRef.current = selectedGene;

  useEffect(() => decorateRef.current(), [highlight, selectedGene]);

  return (
    <div>
      <div className="relative rounded-[28px] bg-field">
        <div ref={ref} className="w-full" style={{ height }} />
        <button
          onClick={() => cyRef.current?.fit(undefined, 40)}
          className="absolute right-3 top-3 min-h-9 rounded-full bg-surface px-3 text-xs font-bold text-muted shadow-soft hover:text-foreground"
        >
          Re-center
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1 text-[13px] text-muted">
        <Legend color="var(--drug)" label="Drug" />
        <Legend color="var(--gene)" label="Gene · click for structure" />
        <Legend color="var(--disease)" label="Disease" />
        <span className="flex items-center gap-2">
          <svg width="24" height="6" aria-hidden="true">
            <line x1="1" y1="3" x2="23" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4" strokeLinecap="round" />
          </svg>
          Inferred from similarity
        </span>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
