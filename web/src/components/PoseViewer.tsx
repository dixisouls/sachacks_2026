"use client";

// The designed molecule shown where the real drug sits, inside the protein.
//
// The protein and the pocket come from the crystal structure. The molecule's
// position does not: it was laid onto the drug's measured position by its
// shared core (api/pocket.py). Saying so is the point of the caption, because
// the picture otherwise looks exactly like a measurement — and this is the
// biggest thing on the page, so a viewer who reads only the picture must not
// come away thinking anything was docked.

import { useEffect, useRef, useState } from "react";
import type { GLViewer } from "3dmol";

const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export default function PoseViewer({
  pdbId,
  sdf,
  clashes,
  closestA,
  resolutionA,
  drugName,
  moleculeName,
  className = "h-[clamp(320px,48vh,560px)]",
}: {
  pdbId: string;
  sdf: string;
  clashes: number;
  closestA?: number;
  resolutionA?: number | null;
  drugName: string;
  moleculeName: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const [cif, setCif] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [surface, setSurface] = useState(false);

  // The protein, fetched once per structure and kept, so turning the surface
  // on and off never goes back to the network.
  useEffect(() => {
    let cancelled = false;
    setCif(null);
    setFailed(false);
    (async () => {
      try {
        const response = await fetch(`${API}/api/structures/file?src=rcsb&id=${encodeURIComponent(pdbId)}`);
        if (!response.ok) throw new Error(`structure ${response.status}`);
        const text = await response.text();
        if (!cancelled) setCif(text);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdbId]);

  useEffect(() => {
    if (!cif) return;
    let cancelled = false;
    let viewer: GLViewer | null = null;
    setReady(false);

    (async () => {
      try {
        const $3Dmol = await import("3dmol");
        if (cancelled || !host.current) return;

        viewer = $3Dmol.createViewer(host.current, { backgroundColor: "#f6f8f7", antialias: true });
        viewerRef.current = viewer;
        viewer.addModel(cif, "cif");
        viewer.setStyle({}, {});
        // the whole chain, quiet, so the pocket is read as part of something
        viewer.setStyle({ hetflag: false }, { cartoon: { color: "#c3d1cb", opacity: 0.62 } });

        // the placed molecule, in the drug colour so it reads as the thing being judged
        viewer.addModel(sdf, "sdf");
        const placed = viewer.getModel();
        placed.setStyle({}, { stick: { colorscheme: "orangeCarbon", radius: 0.28 } });

        // the protein right around it, so the fit is visible rather than asserted
        const near = { within: { distance: 5, sel: { model: placed } }, byres: true, hetflag: false };
        viewer.addStyle(near, { stick: { colorscheme: "lightgreyCarbon", radius: 0.14 } });
        if (surface) {
          viewer.addSurface(
            "VDW",
            { opacity: 0.68, color: "#cfdbd5" },
            { within: { distance: 8, sel: { model: placed } }, byres: true, hetflag: false },
          );
        }
        viewer.zoomTo({ within: { distance: 8, sel: { model: placed } } });
        viewer.render();
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      viewerRef.current = null;
      if (viewer) {
        viewer.clear();
        // browsers cap live WebGL contexts, so release this one rather than leak it
        const canvas = viewer.getCanvas();
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.remove();
      }
    };
  }, [cif, sdf, surface]);

  // The viewer draws into a fixed-size canvas, so it has to be told when the
  // panel around it changes shape.
  useEffect(() => {
    const el = host.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => viewerRef.current?.resize());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const reset = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.zoomTo({ within: { distance: 8, sel: { model: viewer.getModel() } } });
    viewer.render();
  };

  return (
    <figure className="m-0">
      <div className={`relative overflow-hidden rounded-[28px] bg-field ${className}`}>
        <div ref={host} className="absolute inset-0" />

        {!failed && ready && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-2 p-3">
            <div className="pointer-events-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSurface((v) => !v)}
                aria-pressed={surface}
                className={`h-9 rounded-full px-3.5 text-[13px] font-semibold shadow-soft transition-colors ${
                  surface ? "bg-foreground text-surface" : "bg-surface/90 text-muted hover:text-foreground"
                }`}
              >
                Pocket surface
              </button>
              <button
                type="button"
                onClick={reset}
                className="h-9 rounded-full bg-surface/90 px-3.5 text-[13px] font-semibold text-muted shadow-soft transition-colors hover:text-foreground"
              >
                Recentre
              </button>
            </div>
            <p className="rounded-full bg-surface/90 px-3 py-1.5 text-[12px] font-medium text-muted shadow-soft">
              Drag to turn, scroll to zoom
            </p>
          </div>
        )}

        {(failed || !ready) && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            {failed ? (
              <p className="max-w-[320px] text-[14px] leading-relaxed text-muted">
                The protein structure for {pdbId} could not be loaded, so the pocket cannot be drawn. The molecule is
                unchanged; only the picture is missing.
              </p>
            ) : (
              <p className="text-[14px] font-medium text-muted" aria-live="polite">
                Loading {pdbId}…
              </p>
            )}
          </div>
        )}
      </div>

      <figcaption className="mt-3 max-w-[70ch] text-[13px] leading-relaxed text-muted">
        <span className="font-semibold text-foreground">A placement, not a docking.</span> {pdbId} is the structure
        where {drugName} was measured inside this protein
        {resolutionA != null ? `, at ${resolutionA} Å` : ""}. {moleculeName} was laid onto {drugName}&apos;s measured
        position by the part the two share, so this is where it would sit <em>if</em> it binds the same way. Nothing
        searched for a better position, the protein was not allowed to flex, and no binding was calculated.{" "}
        {clashes === 0
          ? "No atom overlaps the protein"
          : `${clashes} ${clashes === 1 ? "atom overlaps" : "atoms overlap"} the protein, drawn passing through it`}
        {closestA != null ? `, and the closest approach is ${closestA} Å` : ""}.
      </figcaption>
    </figure>
  );
}
