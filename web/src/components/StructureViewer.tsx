"use client";
// Mounted by StructurePanel, client-only: dynamic(() => import("./StructureViewer"), { ssr: false }),
// since 3Dmol needs WebGL and `window`. Needs a QueryClientProvider above it and NEXT_PUBLIC_API_URL set.
//
// 3D structure for one (drug, gene) pair, architecture.md §9.3–9.4.
// Data: GET /api/structures?drug_id=&gene_id= → StructurePlan (api/structures.py).
// 3dmol and smiles-drawer are dynamically imported, so neither lands in the main bundle.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GLViewer } from "3dmol";

// ── types (mirror api/structures.py) ─────────────────────────────────────────

export interface DrugStructure {
  format: "sdf";
  file_url: string | null;
  smiles: string | null;
  name: string;
}

export interface ProteinStructure {
  source: "PDB" | "AlphaFold";
  id: string;
  format: "cif" | "pdb";
  file_url: string;
  uniprot_id: string;
  gene_symbol: string;
  mean_plddt: number | null;
}

export interface StructurePlan {
  mode: "BOUND" | "SEPARATE" | "DRUG_ONLY" | "NONE";
  drug: DrugStructure;
  protein: ProteinStructure | null;
  ligand_comp_id: string | null;
  ligand_match: "exact" | "stereo_relaxed" | null;
  resolution_A: number | null;
  caption: string;
}

const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

async function fetchPlan(drugId: string, geneId: string): Promise<StructurePlan> {
  const q = new URLSearchParams({ drug_id: drugId, gene_id: geneId });
  const r = await fetch(`${API}/api/structures?${q}`);
  if (!r.ok) throw new Error(`structures ${r.status}`);
  return r.json();
}

async function fetchText(fileUrl: string): Promise<string> {
  const r = await fetch(`${API}${fileUrl}`);
  if (!r.ok) throw new Error(`structure file ${r.status}`);
  return r.text();
}

// ── pLDDT colors (AlphaFold stores pLDDT in the B-factor column) ─────────────

const PLDDT_BINS = [
  { min: 90, color: "#0053D6", label: "Very high (>90)" },
  { min: 70, color: "#65CBF3", label: "Confident (70–90)" },
  { min: 50, color: "#FFDB13", label: "Low (50–70)" },
  { min: -Infinity, color: "#FF7D45", label: "Very low (<50)" },
];
const plddtColor = (atom: { b?: number }) =>
  PLDDT_BINS.find((bin) => (atom.b ?? 0) > bin.min)!.color;

// ── one 3Dmol canvas ─────────────────────────────────────────────────────────

type Setup = (viewer: GLViewer, $3Dmol: typeof import("3dmol"), opts: { surface: boolean }) => void;

interface MolCanvasProps {
  /** file_url → format; all are loaded into the same viewer */
  files: { url: string; format: string }[];
  /** styles and camera; also re-run when `surface` toggles */
  setup: Setup;
  surface: boolean;
  resetSignal: number;
  className?: string;
}

function MolCanvas({ files, setup, surface, resetSignal, className }: MolCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const libRef = useRef<typeof import("3dmol") | null>(null);
  const homeView = useRef<number[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const filesKey = files.map((f) => f.url).join("|");

  // Create the viewer and load the models once per set of files.
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const [$3Dmol, texts] = await Promise.all([
          import("3dmol"),
          Promise.all(files.map((f) => fetchText(f.url))),
        ]);
        if (cancelled || !host.current) return;
        const viewer = $3Dmol.createViewer(host.current, { backgroundColor: "#f6f8f7" });
        texts.forEach((t, i) => viewer.addModel(t, files[i].format));
        viewerRef.current = viewer;
        libRef.current = $3Dmol;
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      const viewer = viewerRef.current;
      viewerRef.current = null;
      homeView.current = null;
      if (viewer) {
        viewer.clear();
        // clear() empties the scene but keeps the GL context; browsers cap live contexts
        // (~16), so release it explicitly or switching drugs eventually blanks viewers.
        const canvas = viewer.getCanvas();
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.remove();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey]);

  // Apply styles (and the surface toggle) whenever they change.
  useEffect(() => {
    const viewer = viewerRef.current;
    const $3Dmol = libRef.current;
    if (status !== "ready" || !viewer || !$3Dmol) return;
    viewer.removeAllSurfaces();
    viewer.setStyle({}, {});
    setup(viewer, $3Dmol, { surface });
    if (!homeView.current) homeView.current = viewer.getView();
    viewer.render();
  }, [status, setup, surface]);

  // Reset view button.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (resetSignal && viewer && homeView.current) {
      viewer.setView(homeView.current);
      viewer.render();
    }
  }, [resetSignal]);

  // Keep the canvas sized to its box.
  useEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver(() => viewerRef.current?.resize().render());
    ro.observe(host.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={`relative overflow-hidden rounded-3xl bg-field ${className ?? ""}`}>
      <div ref={host} className="absolute inset-0" />
      {status !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
          {status === "loading" ? "Loading structure…" : "Could not load this structure file."}
        </div>
      )}
    </div>
  );
}

// ── 2D fallback ──────────────────────────────────────────────────────────────

function Smiles2D({ smiles, className }: { smiles: string; className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const el = svg.current;
    setFailed(false);
    import("smiles-drawer").then(({ default: SmilesDrawer }) => {
      if (cancelled || !el) return;
      const drawer = new SmilesDrawer.SvgDrawer({ width: 320, height: 240 });
      SmilesDrawer.parse(
        smiles,
        (tree) => !cancelled && drawer.draw(tree, el, "light"),
        () => !cancelled && setFailed(true),
      );
    });
    return () => {
      cancelled = true;
      el?.replaceChildren();
    };
  }, [smiles]);

  return failed ? (
    <p className="text-sm text-muted">Could not draw this molecule.</p>
  ) : (
    <svg ref={svg} className={className} role="img" aria-label="2D structure drawing" />
  );
}

// ── small UI pieces ──────────────────────────────────────────────────────────

function PlddtLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span className="font-medium">pLDDT</span>
      {PLDDT_BINS.map((b) => (
        <span key={b.label} className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: b.color }} />
          {b.label}
        </span>
      ))}
    </div>
  );
}

function useIsNarrow(query = "(max-width: 639px)") {
  // `window` doesn't exist during server rendering: start wide, read the real value after mount.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

const btn =
  "h-9 rounded-full bg-soft-2 px-3.5 text-[13px] font-semibold text-foreground hover:bg-soft " +
  "aria-pressed:bg-foreground aria-pressed:text-surface";

// ── style setups per mode (§9.3) ─────────────────────────────────────────────

/** zoomTo fits the model to the canvas height; shrink it in tall/narrow panels so it isn't cropped. */
function fitWidth(viewer: GLViewer, minAspect = 1.4) {
  const c = viewer.getCanvas();
  const aspect = c.clientWidth / Math.max(c.clientHeight, 1);
  if (aspect < minAspect) viewer.zoom(aspect / minAspect);
}

const drugSticks: Setup = (viewer) => {
  viewer.setStyle({}, { stick: { colorscheme: "greenCarbon" } });
  viewer.zoomTo();
  fitWidth(viewer);
};

function boundSetup(compId: string): Setup {
  return (viewer, $3Dmol, { surface }) => {
    // One copy of the ligand (entries can hold several, one per chain).
    const first = viewer.selectedAtoms({ resn: compId })[0];
    const ligand = first ? { resn: compId, chain: first.chain, resi: first.resi } : { resn: compId };
    const pocket = { within: { distance: 5, sel: ligand }, byres: true, hetflag: false };

    viewer.setStyle({ hetflag: false }, { cartoon: { color: "lightgrey" } });
    viewer.addStyle(pocket, { stick: { colorscheme: "lightgreyCarbon", radius: 0.15 } });
    viewer.setStyle(ligand, { stick: { colorscheme: "greenCarbon", radius: 0.25 } });
    if (surface) viewer.addSurface($3Dmol.SurfaceType.VDW, { opacity: 0.35, color: "white" }, pocket);
    // Frame the pocket, not just the ligand, so surrounding helices don't fill the view.
    viewer.zoomTo({ within: { distance: 8, sel: ligand } }); // no spin by default
  };
}

const plddtSetup: Setup = (viewer, $3Dmol, { surface }) => {
  viewer.setStyle({}, { cartoon: { colorfunc: plddtColor } });
  if (surface) viewer.addSurface($3Dmol.SurfaceType.VDW, { opacity: 0.4, color: "white" });
  // Frame the confident core; long disordered tails (pLDDT < 70) otherwise shrink the fold.
  const core = viewer.selectedAtoms({ predicate: (a: { b?: number }) => (a.b ?? 0) >= 70 });
  viewer.zoomTo(core.length ? { predicate: (a: { b?: number }) => (a.b ?? 0) >= 70 } : {});
  fitWidth(viewer);
};

// ── panel heading ────────────────────────────────────────────────────────────
// A protein and a small molecule are different kinds of object drawn at wildly
// different scales. Without a heading on each, two panels side by side read as
// "compare these two", which is what LookAlikeCompare means and this does not.

function LabelledPanel({ kind, name, detail, tone, children }: {
  kind: "Protein" | "Drug";
  name: string;
  detail: string;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={`rounded-full ${tone} px-2.5 py-0.5 text-[12px] font-semibold text-white`}>
          {kind}
        </span>
        <span className="truncate font-bold">{name}</span>
        <span className="text-xs text-muted">{detail}</span>
      </div>
      {children}
    </div>
  );
}

// ── main component ───────────────────────────────────────────────────────────

export interface StructureViewerProps {
  drugId: string;
  geneId: string;
}

export default function StructureViewer({ drugId, geneId }: StructureViewerProps) {
  const { data: plan, isPending, isError, refetch } = useQuery({
    queryKey: ["structure", drugId, geneId],
    queryFn: () => fetchPlan(drugId, geneId),
    staleTime: Infinity,
    enabled: Boolean(drugId && geneId),
  });

  const [surface, setSurface] = useState(true);
  const [reset, setReset] = useState(0);
  const [pane, setPane] = useState<"protein" | "drug">("protein");
  const narrow = useIsNarrow();
  const doReset = useCallback(() => setReset((n) => n + 1), []);

  // Surface defaults: on for the BOUND pocket, off for a whole AlphaFold model.
  useEffect(() => {
    if (plan) setSurface(plan.mode === "BOUND");
    setPane("protein");
  }, [plan]);

  // Stable setup callbacks so MolCanvas only restyles when inputs change.
  const compId = plan?.ligand_comp_id ?? "";
  const bound = useCallback<Setup>((v, $, o) => boundSetup(compId)(v, $, o), [compId]);

  if (isPending) {
    return <div className="skeleton h-80" aria-label="Loading structure" />;
  }
  if (isError || !plan) {
    return (
      <div className="rounded-3xl bg-soft-2 p-4 text-sm text-muted">
        Structure lookup failed.{" "}
        <button className="underline" onClick={() => refetch()}>Retry</button>
      </div>
    );
  }

  const { mode, drug, protein } = plan;
  const hasProteinCanvas = (mode === "BOUND" || mode === "SEPARATE") && protein;
  const hasSurfaceToggle = Boolean(hasProteinCanvas);

  // State what the panels are and how they relate, before anyone has to work it
  // out from the pictures. Written per mode, because "drug inside the protein,
  // measured" and "drug beside the protein, because nobody has measured them
  // together" are different claims and the difference is the honest part.
  const relationship =
    mode === "BOUND"
      ? `${drug.name} inside ${protein?.gene_symbol}, from an experimental structure`
      : mode === "SEPARATE"
        ? `${drug.name} acts on ${protein?.gene_symbol}. Shown apart because no experimental structure of the two together exists.`
        : mode === "DRUG_ONLY"
          ? `${drug.name} on its own. No protein structure available.`
          : `${drug.name} on its own, drawn flat. No 3D structure available.`;

  const drugPanel = drug.file_url ? (
    <MolCanvas
      files={[{ url: drug.file_url, format: "sdf" }]}
      setup={drugSticks}
      surface={false}
      resetSignal={reset}
      className="h-80"
    />
  ) : drug.smiles ? (
    <div className="flex h-80 items-center justify-center rounded-3xl bg-field">
      <Smiles2D smiles={drug.smiles} className="h-60 w-80 max-w-full" />
    </div>
  ) : (
    <div className="flex h-80 items-center justify-center rounded-3xl bg-soft-2 text-sm text-muted">
      No small-molecule structure for {drug.name}.
    </div>
  );

  return (
    <figure className="flex flex-col gap-3">
      <p className="text-sm text-muted">{relationship}</p>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2">
        {mode === "SEPARATE" && narrow && (
          <div className="flex gap-1" role="tablist" aria-label="Viewer">
            <button className={btn} aria-pressed={pane === "protein"} onClick={() => setPane("protein")}>
              {protein?.gene_symbol ?? "Protein"}
            </button>
            <button className={btn} aria-pressed={pane === "drug"} onClick={() => setPane("drug")}>
              {drug.name}
            </button>
          </div>
        )}
        {mode !== "NONE" && (
          <button className={btn} onClick={doReset}>Reset view</button>
        )}
        {hasSurfaceToggle && (
          <button className={btn} aria-pressed={surface} onClick={() => setSurface((s) => !s)}>
            Surface
          </button>
        )}
      </div>

      {/* viewers */}
      {mode === "BOUND" && protein && (
        <MolCanvas
          files={[{ url: protein.file_url, format: protein.format }]}
          setup={bound}
          surface={surface}
          resetSignal={reset}
          className="h-96"
        />
      )}

      {mode === "SEPARATE" && protein && (
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          {(!narrow || pane === "protein") && (
            <LabelledPanel
              kind="Protein"
              name={protein.gene_symbol}
              detail={`human · UniProt ${protein.uniprot_id} · predicted by AlphaFold`}
              tone="bg-gene"
            >
              <MolCanvas
                files={[{ url: protein.file_url, format: protein.format }]}
                setup={plddtSetup}
                surface={surface}
                resetSignal={reset}
                className="h-80"
              />
            </LabelledPanel>
          )}
          {(!narrow || pane === "drug") && (
            <LabelledPanel
              kind="Drug"
              name={drug.name}
              detail={drug.file_url ? "small molecule · 3D conformer" : "small molecule · 2D structure"}
              tone="bg-drug"
            >
              {drugPanel}
            </LabelledPanel>
          )}
        </div>
      )}

      {(mode === "DRUG_ONLY" || mode === "NONE") && (
        <LabelledPanel kind="Drug" name={drug.name} detail="small molecule" tone="bg-drug">
          {drugPanel}
        </LabelledPanel>
      )}

      {/* legend + caption */}
      {mode === "SEPARATE" && <PlddtLegend />}
      <figcaption className="text-xs text-muted">
        {/* Provenance only. What the panels are and how they relate is stated above. */}
        {plan.caption}
        {mode === "BOUND" && plan.ligand_match === "stereo_relaxed" && (
          <span className="block">
            PDB ligand {plan.ligand_comp_id} matches {drug.name}&apos;s structure; stereochemistry not compared.
          </span>
        )}
      </figcaption>
    </figure>
  );
}
