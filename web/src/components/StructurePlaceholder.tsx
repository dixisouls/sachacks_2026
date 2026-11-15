"use client";

// Integration slot for the 3D structure viewer (architecture.md §9), which is being built separately.
// Swap this component for <StructureViewer /> once it lands. Props already carry what §9.2 needs:
// drugId + the selected gene (id, symbol, uniprot_id). The gene picker stays useful either way.

import type { PathNode } from "@/lib/types";

type Props = {
  drugId: string;
  diseaseId: string;
  gene: PathNode | null;
  genes: PathNode[];
  onGeneChange: (geneId: string) => void;
};

export default function StructurePlaceholder({ gene, genes, onGeneChange }: Props) {
  return (
    <div className="space-y-5">
      {genes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="mr-1 text-muted">Protein on the path</span>
          {genes.map((g) => (
            <button
              key={g.id}
              onClick={() => onGeneChange(g.id)}
              aria-pressed={g.id === gene?.id}
              className={`min-h-11 rounded-full px-4 font-mono text-[13px] transition-colors ${
                g.id === gene?.id ? "bg-gene text-white" : "bg-soft-2 hover:bg-soft"
              }`}
            >
              {g.label ?? g.id}
            </button>
          ))}
        </div>
      )}
      <div className="grid h-[300px] place-items-center rounded-[28px] bg-field p-6 text-center">
        <div>
          <div className="mx-auto h-14 w-14 rounded-full bg-mint" />
          <p className="mt-4 font-bold">3D structure viewer</p>
          <p className="mt-1 text-sm text-muted">
            {gene ? (
              <>
                Will show <span className="font-mono">{gene.label}</span>
                {gene.uniprot_id && <> (UniProt {gene.uniprot_id})</>} with the drug.
              </>
            ) : (
              "No gene on this path; the viewer will show the drug only."
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
