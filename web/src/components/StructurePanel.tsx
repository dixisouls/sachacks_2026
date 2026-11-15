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
        <div>
          <p className="mb-2 text-[14px] text-muted">Pick a protein from the path to see it with the drug.</p>
          <div role="group" aria-label="Proteins on the path" className="flex flex-wrap gap-1.5">
            {genes.map((g) => (
              <button
                key={g.id}
                onClick={() => onGeneChange(g.id)}
                aria-pressed={g.id === gene?.id}
                className={`flex h-10 items-center gap-2 rounded-full px-3.5 font-mono text-[13px] font-medium transition-colors ${
                  g.id === gene?.id ? "bg-gene text-white" : "bg-soft-2 hover:bg-mint"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${g.id === gene?.id ? "bg-white" : "bg-gene"}`} />
                {g.label ?? g.id}
              </button>
            ))}
          </div>
        </div>
      )}
      {gene && !USE_MOCKS ? (
        <StructureViewer key={`${drugId}|${gene.id}`} drugId={drugId} geneId={gene.id} />
      ) : (
        <div className="grid h-[300px] place-items-center rounded-3xl bg-soft-2 p-6 text-center">
          <div>
            <svg aria-hidden="true" viewBox="0 0 60 60" className="mx-auto w-14">
              <circle cx="30" cy="30" r="22" fill="none" stroke="var(--gene)" strokeWidth="3" strokeDasharray="6 5" />
              <circle cx="30" cy="30" r="7" fill="var(--drug)" />
            </svg>
            <p className="mt-4 font-bold">3D structure</p>
            <p className="mt-1 max-w-[360px] text-sm text-muted">
              {!gene ? (
                "This path has no protein in it, so there is no structure to show."
              ) : (
                <>
                  Shows <span className="font-mono">{gene.label}</span>
                  {gene.uniprot_id && <> (UniProt {gene.uniprot_id})</>} together with the drug once the backend is connected.
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
