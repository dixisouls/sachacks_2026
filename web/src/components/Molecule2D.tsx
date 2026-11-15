"use client";

// Draws a SMILES string in the browser. The backend already renders molecules
// for the look-alike comparison, but a designed molecule is not in the database,
// so there is nothing for it to render from. smiles-drawer is already a
// dependency (StructureViewer uses it as its 2D fallback).

import { useEffect, useRef, useState } from "react";

export default function Molecule2D({ smiles, className }: { smiles: string; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    setFailed(false);
    if (!smiles || !el) return;
    import("smiles-drawer").then(({ default: SmilesDrawer }) => {
      if (cancelled || !el) return;
      const drawer = new SmilesDrawer.SvgDrawer({ width: 320, height: 240 });
      SmilesDrawer.parse(
        smiles,
        (tree: unknown) => !cancelled && drawer.draw(tree, el, "light"),
        () => !cancelled && setFailed(true),
      );
    });
    return () => {
      cancelled = true;
      el?.replaceChildren();
    };
  }, [smiles]);

  if (failed) {
    return (
      <div className={`grid place-items-center text-center ${className ?? ""}`}>
        <p className="text-[13px] text-muted">This structure could not be drawn.</p>
      </div>
    );
  }
  return <svg ref={ref} className={className} role="img" aria-label={`Structure of ${smiles}`} />;
}
