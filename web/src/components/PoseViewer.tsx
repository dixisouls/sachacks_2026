"use client";

// The designed molecule shown where the real drug sits, inside the protein.
//
// The protein and the pocket come from the crystal structure. The molecule's
// position does not: it was laid onto the drug's measured position by its
// shared core (api/pocket.py). Saying so is the point of the caption, because
// the picture otherwise looks exactly like a measurement.

import { useEffect, useRef, useState } from "react";
import type { GLViewer } from "3dmol";

const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export default function PoseViewer({
  pdbId,
  sdf,
  clashes,
  drugName,
}: {
  pdbId: string;
  sdf: string;
  clashes: number;
  drugName: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let viewer: GLViewer | null = null;
    setStatus("loading");

    (async () => {
      try {
        const [$3Dmol, response] = await Promise.all([
          import("3dmol"),
          fetch(`${API}/api/structures/file?src=rcsb&id=${encodeURIComponent(pdbId)}`),
        ]);
        if (!response.ok) throw new Error(`structure ${response.status}`);
        const text = await response.text();
        if (cancelled || !host.current) return;

        viewer = $3Dmol.createViewer(host.current, { backgroundColor: "#f6f8f7" });
        viewer.addModel(text, "cif");
        viewer.setStyle({}, {});
        viewer.setStyle({ hetflag: false }, { cartoon: { color: "lightgrey", opacity: 0.75 } });

        // the placed molecule, in the drug colour so it reads as the thing being judged
        viewer.addModel(sdf, "sdf");
        const placed = viewer.getModel();
        placed.setStyle({}, { stick: { colorscheme: "orangeCarbon", radius: 0.22 } });

        // the protein right around it, so the fit is visible rather than asserted
        const pocket = { within: { distance: 5, sel: { model: placed } }, byres: true, hetflag: false };
        viewer.addStyle(pocket, { stick: { colorscheme: "lightgreyCarbon", radius: 0.13 } });
        viewer.zoomTo({ within: { distance: 8, sel: { model: placed } } });
        viewer.render();
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (viewer) {
        viewer.clear();
        // browsers cap live WebGL contexts, so release this one rather than leak it
        const canvas = viewer.getCanvas();
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        canvas.remove();
      }
    };
  }, [pdbId, sdf]);

  return (
    <figure className="m-0">
      <div className="relative h-72 overflow-hidden rounded-2xl bg-field">
        <div ref={host} className="absolute inset-0" />
        {status !== "ready" && (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted">
            {status === "loading" ? "Loading the pocket…" : "Could not load the protein structure."}
          </div>
        )}
      </div>
      <figcaption className="mt-2 text-[12.5px] leading-relaxed text-muted">
        Placed into {pdbId}, the structure where {drugName} was measured inside its target. The
        molecule is laid onto {drugName}&apos;s position by the part they share, so this is where it
        would sit <em>if</em> it binds the same way. Nothing here searched for a better position, and
        the protein was not allowed to move.{" "}
        {clashes === 0
          ? "No atom overlaps the protein."
          : `${clashes} ${clashes === 1 ? "atom overlaps" : "atoms overlap"} the protein, shown passing through it.`}
      </figcaption>
    </figure>
  );
}
