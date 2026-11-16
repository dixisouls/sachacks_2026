"use client";

// The front page opens with a finished result rather than an empty search box,
// because the product is the molecule and the argument around it, not the input.
//
// Everything here is read off a real recorded run for Rett syndrome, kept in the
// backend's cache: the structure, the numbers, the rejected names, the PDB id.
// Nothing is illustrative. If the run is ever rebuilt and these change, this
// panel is wrong, so it links to the live run rather than standing in for it.

import Link from "next/link";
import Molecule2D from "@/components/Molecule2D";

const WINNER = {
  name: "ARB-8",
  smiles: "NC[C@H](CC(=O)O)c1ccc(Br)c(F)c1",
  seed: "Arbaclofen",
  disease: "Rett syndrome",
  diseaseId: "MONDO_0010726",
  qed: 0.885,
  proposed: 36,
  kept: 12,
  pdb: "4MS4",
  clashes: 0,
  atoms: 15,
};

// Real names from the same run, kept because the discarded ones are the point.
const DISCARDED = ["ARB-3", "BAC-6", "ARB-5", "BAC-9", "ARB-2"];

export default function HeroResult() {
  return (
    <div className="panel overflow-hidden">
      <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* the molecule */}
        <div className="flex flex-col justify-center bg-soft-2 p-6 sm:p-8">
          <Molecule2D smiles={WINNER.smiles} className="mx-auto h-56 w-full sm:h-64" />
          <p className="mt-3 break-all text-center font-mono text-[11.5px] leading-relaxed text-muted">
            {WINNER.smiles}
          </p>
        </div>

        {/* what it is and what was done to it */}
        <div className="p-6 sm:p-8">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[19px] font-bold tracking-[-0.02em]">{WINNER.name}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-mint px-2.5 py-1 text-[12.5px] font-semibold text-accent-ink">
              <span className="h-2 w-2 rounded-full bg-[#0B7A69]" />
              Survived every check
            </span>
          </div>

          <p className="mt-3 text-[15.5px] leading-relaxed">
            Designed for <span className="font-semibold text-disease">{WINNER.disease}</span>, built on{" "}
            <span className="font-semibold">{WINNER.seed}</span> — an approved drug that already reaches the disease
            through the gene <span className="font-mono text-[14px]">GABBR2</span>.
          </p>

          <dl className="mt-5 grid grid-cols-3 gap-4">
            <Figure value={`${WINNER.proposed}`} label="molecules proposed" />
            <Figure value={`${WINNER.kept}`} label="survived the checks" />
            <Figure value={`${WINNER.clashes} of ${WINNER.atoms}`} label={`atoms clash in ${WINNER.pdb}`} />
          </dl>

          <p className="mt-5 text-[14px] leading-relaxed text-muted">
            Placed into the pocket where {WINNER.seed.toLowerCase()} was <em>measured</em> inside GABBR2, at 1.9 Å. No
            atom overlaps the protein. That is a placement, not a docking, and nothing here tested whether it binds.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
            <span>Thrown out along the way:</span>
            {DISCARDED.map((name) => (
              <span key={name} className="font-mono text-[12.5px] line-through decoration-[#C8452A]/60">
                {name}
              </span>
            ))}
            <span>and 19 more.</span>
          </div>

          <Link
            href={`/d/${WINNER.diseaseId}`}
            className="mt-6 inline-flex h-11 items-center rounded-full bg-accent px-5 text-[15px] font-semibold text-white transition-colors hover:bg-accent-ink"
          >
            Open this run
          </Link>
        </div>
      </div>
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dd className="text-[24px] font-bold leading-none tabular-nums tracking-[-0.03em]">{value}</dd>
      <dt className="mt-1.5 text-[12.5px] leading-tight text-muted">{label}</dt>
    </div>
  );
}
