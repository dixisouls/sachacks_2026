"use client";

// One proposed molecule, before and after it was judged.
//
// It appears while the verdict is still unknown and turns over when the
// verdict arrives. Rejected cards stay on screen, struck through rather than
// removed, because a run that only showed what survived would be claiming far
// more than it did.

import { useEffect, useRef, useState } from "react";
import Molecule2D from "@/components/Molecule2D";
import { Verdict } from "@/components/checks";
import type { LiveMolecule } from "@/lib/useRun";

export default function MoleculeCard({
  molecule,
  selected,
  isBest,
  onSelect,
}: {
  molecule: LiveMolecule;
  selected: boolean;
  isBest: boolean;
  onSelect: () => void;
}) {
  const [flip, setFlip] = useState(false);
  const pending = molecule.status === "pending";
  const wasPending = useRef(pending);

  useEffect(() => {
    if (!pending && wasPending.current) {
      wasPending.current = false;
      setFlip(true);
      const timer = setTimeout(() => setFlip(false), 540);
      return () => clearTimeout(timer);
    }
    if (pending) wasPending.current = true;
  }, [pending]);

  const rejected = molecule.status === "fail";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`fadein flex w-full flex-col gap-2.5 rounded-[26px] p-3 text-left transition-shadow ${
        selected ? "bg-surface shadow-float" : "bg-soft-2 hover:bg-surface hover:shadow-soft"
      } ${flip ? "flip-verdict" : ""}`}
    >
      <div className={`grid h-28 place-items-center overflow-hidden rounded-[18px] bg-field ${rejected ? "opacity-45" : ""}`}>
        {molecule.smiles ? (
          <Molecule2D smiles={molecule.smiles} className="h-full w-full" />
        ) : (
          <span className="text-[12px] text-faint">no structure</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 font-mono text-[11px] text-muted">
          R{molecule.round}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[15px] font-bold ${
            rejected ? "text-muted line-through decoration-[#C8452A]/60" : ""
          }`}
        >
          {molecule.name}
        </span>
        {isBest && (
          <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">kept</span>
        )}
      </div>

      <div className="flex items-start gap-2">
        <Verdict status={molecule.status} />
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-muted">
          {pending ? "Proposed, waiting on the checks" : molecule.summary}
        </span>
      </div>
    </button>
  );
}
