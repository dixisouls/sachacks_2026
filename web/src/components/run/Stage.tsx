"use client";

// The picture, given the room it needs.
//
// One molecule at a time, as large as the layout allows: in the pocket when a
// measured pose exists for it, flat when one does not. Which protein you are
// looking inside is a choice, because the seed drug usually acts on several —
// but only one of them was ever measured with the drug in it, and the others
// are honestly marked as having nothing to draw rather than quietly hidden.

import { useEffect, useMemo, useState } from "react";
import Molecule2D from "@/components/Molecule2D";
import PoseViewer from "@/components/PoseViewer";
import ProteinOnly from "./ProteinOnly";
import { Verdict } from "@/components/checks";
import type { Pocket, Protein } from "@/lib/run";
import type { LiveMolecule } from "@/lib/useRun";

export default function Stage({
  molecule,
  proteins,
  pocket,
  pocketNote,
  seedName,
  seedDrugId,
  waiting,
}: {
  molecule: LiveMolecule | null;
  proteins: Protein[];
  pocket: Pocket | null;
  pocketNote: string;
  seedName: string;
  /** The drug the track started from, needed to look a protein structure up. */
  seedDrugId: string;
  /** Nothing has been proposed yet, so there is genuinely nothing to draw. */
  waiting: boolean;
}) {
  // Exactly one protein per track can be drawn into: the one with a measured
  // pose of the seed. The rest were never looked up.
  const placed = useMemo(() => proteins.find((p) => p.has_structure && p.pdb_id), [proteins]);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [flat, setFlat] = useState(false);

  useEffect(() => {
    setSymbol(null);
  }, [placed?.symbol]);

  const selected = proteins.find((p) => p.symbol === symbol) ?? placed ?? proteins[0] ?? null;
  const pose = molecule?.check?.pose_sdf;
  const pocketProps = molecule?.check?.properties.pocket;
  const drawable = !!selected?.has_structure && !!selected.pdb_id && !!pose && !!pocketProps;
  const showPocket = drawable && !flat;

  return (
    <section aria-label="The molecule" className="rounded-[32px] bg-surface p-4 shadow-float sm:p-5">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <h3 className="truncate text-[19px] font-bold tracking-[-0.02em]">
            {molecule ? molecule.name : waiting ? "Nothing proposed yet" : "No molecule selected"}
          </h3>
          {molecule && <Verdict status={molecule.status} />}
        </div>
        {drawable && (
          <div role="group" aria-label="How to show it" className="flex items-center gap-1 rounded-full bg-soft p-1">
            {[
              [false, "In the pocket"],
              [true, "Flat"],
            ].map(([value, label]) => (
              <button
                key={String(value)}
                type="button"
                aria-pressed={flat === value}
                onClick={() => setFlat(value as boolean)}
                className={`h-8 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${
                  flat === value ? "bg-surface text-foreground shadow-soft" : "text-muted hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </header>

      {/* Deliberately not keyed on the molecule: picking another one swaps the
          coordinates inside the same viewer, and the protein is not refetched. */}
      {showPocket && molecule && pocketProps && pose ? (
        <PoseViewer
          pdbId={pocketProps.pdb_id}
          sdf={pose}
          clashes={pocketProps.clashes}
          closestA={pocketProps.closest_A}
          resolutionA={pocket?.resolution_A ?? null}
          drugName={seedName || "the drug it started from"}
          moleculeName={molecule.name}
        />
      ) : (
        <figure className="m-0">
          <div className="grid h-[clamp(320px,48vh,560px)] place-items-center overflow-hidden rounded-[28px] bg-field p-4">
            {molecule?.smiles ? (
              <Molecule2D smiles={molecule.smiles} className="h-full w-full" />
            ) : (
              <p className="max-w-[300px] text-center text-[14px] leading-relaxed text-muted">
                {waiting
                  ? "The first molecule will be drawn here as soon as it is proposed."
                  : "Pick a molecule below to see it here."}
              </p>
            )}
          </div>
          {molecule && (
            <figcaption className="mt-3 max-w-[70ch] text-[13px] leading-relaxed text-muted">
              {flat && drawable ? (
                <>The structure on its own, with no protein around it.</>
              ) : (
                <WhyFlat
                  molecule={molecule}
                  selected={selected}
                  placed={placed}
                  pocketNote={pocketNote}
                  seedName={seedName}
                  hasPose={!!pose}
                />
              )}
            </figcaption>
          )}

          {/* The target itself. Not the same claim as the pose viewer: a
              structure of the protein exists far more often than a measured
              position for the drug inside it, and seeing what is being aimed
              at beats an empty panel saying nothing was found. */}
          {selected && seedDrugId && (
            <div className="mt-6">
              <ProteinOnly
                key={`${seedDrugId}|${selected.gene_id}`}
                drugId={seedDrugId}
                geneId={selected.gene_id}
                symbol={selected.symbol}
                moleculeName={molecule?.name ?? "the designed molecule"}
              />
            </div>
          )}
        </figure>
      )}

      {proteins.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span id="protein-pick" className="text-[13px] text-muted">
            Shown inside
          </span>
          <div role="group" aria-labelledby="protein-pick" className="flex flex-wrap gap-1.5">
            {proteins.map((protein) => {
              const active = selected?.symbol === protein.symbol;
              const canDraw = protein.has_structure && !!protein.pdb_id;
              return (
                <button
                  key={protein.gene_id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setSymbol(protein.symbol);
                    setFlat(false);
                  }}
                  title={
                    canDraw
                      ? `${seedName} was measured inside ${protein.symbol} (${protein.pdb_id})`
                      : `No measured pose of ${seedName} inside ${protein.symbol}, so nothing can be placed in it. The protein itself is shown below when a structure of it exists.`
                  }
                  className={`flex h-9 items-center gap-2 rounded-full px-3.5 font-mono text-[13px] font-medium transition-colors ${
                    active ? "bg-foreground text-surface" : "bg-soft-2 text-muted hover:text-foreground"
                  }`}
                >
                  {canDraw && (
                    <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-accent-soft" : "bg-accent"}`} />
                  )}
                  {protein.symbol}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/** Why the flat structure is what you are looking at. Each of these is a real
 *  state of the run, and each means something different to a chemist. */
function WhyFlat({
  molecule,
  selected,
  placed,
  pocketNote,
  seedName,
  hasPose,
}: {
  molecule: LiveMolecule;
  selected: Protein | null;
  placed: Protein | undefined;
  pocketNote: string;
  seedName: string;
  hasPose: boolean;
}) {
  if (selected && !selected.has_structure) {
    return (
      <>
        No structure was looked up for {selected.symbol}, so there is no pocket to put {molecule.name} in.{" "}
        {placed ? (
          <>
            Only {placed.symbol} has a measured pose of {seedName}, and it is the pocket every molecule in this track
            was placed into.
          </>
        ) : (
          <>Nothing in this track could be placed in a pocket.</>
        )}
      </>
    );
  }
  if (!hasPose) {
    return (
      <>
        {molecule.name} could not be placed in the pocket: it does not share enough of {seedName}&apos;s core to lay
        onto its measured position. The structure is drawn flat instead, which is the honest picture of what is known.
      </>
    );
  }
  return <>{pocketNote || <>No measured pose was available, so the structure is drawn flat.</>}</>;
}
