"use client";

// The chemical look-alike path, shown instead of asserted (api/compare.py).
// Two 2D drawings with the shared scaffold greyed out and what differs coloured,
// plus both similarity numbers: the flat one scoring used, and the stereo-aware one.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getComparison } from "@/lib/api";
import { drugLabel } from "@/lib/format";
import type { MoleculeImage } from "@/lib/types";

export type Analog = { id: string; label: string | null; similarity: number | null };

// role colours used by the backend renderer (api/compare.py SHARED / UNIQUE_LEFT / UNIQUE_RIGHT)
const SHARED = "rgb(204, 212, 209)";
const LEFT = "rgb(13, 140, 120)";
const RIGHT = "rgb(235, 115, 18)";

const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function LookAlikeCompare({ drugId, drugName, analogs }: { drugId: string; drugName: string; analogs: Analog[] }) {
  const [pick, setPick] = useState(analogs[0]?.id);
  const other = analogs.find((a) => a.id === pick) ?? analogs[0];
  const q = useQuery({
    queryKey: ["compare", drugId, other?.id],
    queryFn: () => getComparison(drugId, other!.id),
    enabled: !!other,
  });
  if (!other) return null;
  const c = q.data;

  return (
    <section aria-labelledby="lookalike-h" className="rounded-2xl border border-line p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="lookalike-h" className="text-[18px] font-bold tracking-[-0.015em]">
          Side by side with its look-alike
        </h3>
        <p className="text-[13px] text-muted">Inferred from shape, not recorded in the graph</p>
      </div>

      {analogs.length > 1 && (
        <div role="group" aria-label="Look-alike drugs" className="mt-3 flex flex-wrap gap-2">
          {analogs.map((a) => (
            <button
              key={a.id}
              aria-pressed={a.id === other.id}
              onClick={() => setPick(a.id)}
              className={`h-10 rounded-full border px-4 text-sm font-semibold transition-colors ${
                a.id === other.id ? "border-foreground bg-foreground text-surface" : "border-line bg-surface hover:border-foreground"
              }`}
            >
              {drugLabel(a.label, a.id)}
              {a.similarity != null && <span className="ml-1.5 font-normal opacity-70">{pct(a.similarity)}</span>}
            </button>
          ))}
        </div>
      )}

      {q.isLoading && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="skeleton h-56" />
          <div className="skeleton h-56" />
        </div>
      )}

      {q.isError && <p className="mt-4 text-sm text-muted">{(q.error as Error).message || "Could not draw the comparison."}</p>}

      {c && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Molecule m={c.left} fallback={drugName} accent={LEFT} />
            <Molecule m={c.right} fallback={drugLabel(other.label, other.id)} accent={RIGHT} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
            <Key colour={SHARED} label={`Shared core, ${c.shared_atoms} atoms`} />
            <Key colour={LEFT} label={`Only in ${drugLabel(c.left.name, c.left.drug_id)}`} />
            <Key colour={RIGHT} label={`Only in ${drugLabel(c.right.name, c.right.drug_id)}`} />
          </div>

          <div className="mt-5 flex flex-wrap gap-x-10 gap-y-4">
            <Number value={pct(c.tanimoto)} label="Alike as flat drawings (what the ranking used)" />
            <Number value={pct(c.tanimoto_stereo)} label="Alike once 3D handedness counts" muted={c.tanimoto_stereo === c.tanimoto} />
          </div>

          <p className="mt-4 text-[15px] leading-relaxed">
            {readableCaption(c.caption, [c.left, c.right])}.
            {c.stereo_only_difference && (
              <span className="text-muted">
                {" "}
                They are mirror-image forms, so the flat number overstates how alike they behave.
              </span>
            )}
          </p>
        </>
      )}
    </section>
  );
}

/** The backend caption uses stored (upper-case) names; show the readable ones. */
function readableCaption(caption: string, mols: MoleculeImage[]) {
  let out = caption;
  for (const m of mols) if (m.name) out = out.split(m.name).join(drugLabel(m.name, m.drug_id));
  return out;
}

function Molecule({ m, fallback, accent }: { m: MoleculeImage; fallback: string; accent: string }) {
  const name = drugLabel(m.name, m.drug_id) || fallback;
  // rendered as an <img> data URI, never injected as markup
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(m.svg)}`;
  return (
    <figure className="m-0 rounded-xl border border-line bg-surface p-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={`2D structure of ${name}, shared core in grey`} className="mx-auto aspect-[340/260] w-full max-w-[340px]" />
      <figcaption className="mt-1 flex items-center justify-between gap-2 px-1 text-sm">
        <span className="flex min-w-0 items-center gap-2 font-bold">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: accent }} />
          <span className="truncate">{name}</span>
        </span>
        <span className="shrink-0 text-xs text-muted">
          {m.n_shared_atoms}/{m.n_atoms} atoms shared
        </span>
      </figcaption>
    </figure>
  );
}

function Key({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: colour }} />
      {label}
    </span>
  );
}

function Number({ value, label, muted = false }: { value: string; label: string; muted?: boolean }) {
  return (
    <div>
      <div className={`text-[30px] font-bold leading-none tracking-[-0.03em] tabular-nums ${muted ? "text-muted" : ""}`}>{value}</div>
      <div className="mt-1.5 max-w-[220px] text-[13px] text-muted">{label}</div>
    </div>
  );
}
