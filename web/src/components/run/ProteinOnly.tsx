"use client";

// The target protein on its own, for the common case: a real structure of the
// protein exists, but nobody has ever measured this drug inside it.
//
// This is deliberately not the pose viewer. Nothing is placed, nothing is
// scored, and no molecule appears in the picture — because putting one there
// would be inventing a position. What it shows is the thing being aimed at.

import { useEffect, useRef, useState } from "react";
import type { GLViewer } from "3dmol";
import type { StructurePlan } from "@/lib/types";

const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export default function ProteinOnly({
  drugId,
  geneId,
  symbol,
  moleculeName,
}: {
  drugId: string;
  geneId: string;
  symbol: string;
  moleculeName: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const [plan, setPlan] = useState<StructurePlan | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "error">("loading");

  // the plan first: it says whether a structure exists at all, and which kind
  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setState("loading");
    (async () => {
      try {
        const query = new URLSearchParams({ drug_id: drugId, gene_id: geneId });
        const response = await fetch(`${API}/api/structures?${query}`);
        if (!response.ok) throw new Error(String(response.status));
        const found = (await response.json()) as StructurePlan;
        if (cancelled) return;
        if (!found.protein) setState("none");
        else setPlan(found);
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drugId, geneId]);

  useEffect(() => {
    const protein = plan?.protein;
    if (!protein) return;
    let cancelled = false;
    let viewer: GLViewer | null = null;

    (async () => {
      try {
        const [$3Dmol, response] = await Promise.all([
          import("3dmol"),
          fetch(`${API}${protein.file_url}`),
        ]);
        if (!response.ok) throw new Error(String(response.status));
        const text = await response.text();
        if (cancelled || !host.current) return;

        viewer = $3Dmol.createViewer(host.current, { backgroundColor: "#f6f8f7", antialias: true });
        viewerRef.current = viewer;
        viewer.addModel(text, protein.format);
        viewer.setStyle({}, { cartoon: { color: "spectrum" } });
        viewer.zoomTo();
        viewer.render();
        if (!cancelled) setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
      viewerRef.current = null;
      if (viewer) {
        viewer.clear();
        // browsers cap live WebGL contexts, so give this one back
        const canvas = viewer.getCanvas();
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.remove();
      }
    };
  }, [plan]);

  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => viewerRef.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (state === "none" || state === "error") return null;

  const protein = plan?.protein;
  const measured = protein?.source === "PDB";

  return (
    <figure className="m-0">
      <div className="relative h-[clamp(260px,34vh,420px)] overflow-hidden rounded-[28px] bg-field">
        <div ref={host} className="absolute inset-0" />
        {state !== "ready" && (
          <div className="absolute inset-0 grid place-items-center text-[14px] text-muted" aria-live="polite">
            Loading {symbol}…
          </div>
        )}
      </div>
      {protein && (
        <figcaption className="mt-3 max-w-[70ch] text-[13px] leading-relaxed text-muted">
          <span className="font-semibold text-foreground">
            {measured ? `${symbol}, measured` : `${symbol}, predicted`}
          </span>{" "}
          {measured ? (
            <>
              — {protein.id}
              {plan?.resolution_A != null ? ` at ${plan.resolution_A} Å` : ""}, an experimental structure. This is the
              protein the design is aimed at, not a picture of {moleculeName} in it: nobody has measured anything
              bound here, so there is no position to draw it at.
            </>
          ) : (
            <>
              — {protein.id}, an AlphaFold prediction, because no experimental structure of {symbol} was found. The
              fold is a computed guess, and nothing here shows where {moleculeName} would sit.
            </>
          )}
        </figcaption>
      )}
    </figure>
  );
}
