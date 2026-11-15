"use client";

// Structure tab (architecture.md §9): pick a protein on the path, see it with the drug.
// The viewer is client-only (3Dmol needs WebGL and `window`) and needs the live backend,
// so the offline snapshot and gene-less paths fall back to a short note.

import dynamic from "next/dynamic";
import { USE_MOCKS } from "@/lib/api";
import type { PathNode } from "@/lib/types";

const StructureViewer = dynamic(() => import("./StructureViewer"), {
  ssr: false,
  loading: () => <div className="skeleton h-96" />,
});

type Props = {
  drugId: string;
  diseaseId: string;
  gene: PathNode | null;
  genes: PathNode[];
  onGeneChange: (geneId: string) => void;
};

export default function StructurePanel({ drugId, gene, genes, onGeneChange }: Props) {
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
      {gene && !USE_MOCKS ? (
        <StructureViewer key={`${drugId}|${gene.id}`} drugId={drugId} geneId={gene.id} />
      ) : (
        <div className="grid h-[300px] place-items-center rounded-[28px] bg-field p-6 text-center">
          <div>
            <div className="mx-auto h-14 w-14 rounded-full bg-mint" />
            <p className="mt-4 font-bold">3D structure viewer</p>
            <p className="mt-1 text-sm text-muted">
              {!gene ? (
                "No protein on this path, so there is no structure to show."
              ) : (
                <>
                  Shows <span className="font-mono">{gene.label}</span>
                  {gene.uniprot_id && <> (UniProt {gene.uniprot_id})</>} with the drug when connected to the backend.
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
