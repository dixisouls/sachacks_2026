"use client";

// One track's bench: the drug it started from, what it is thinking, the
// molecules it has proposed, the one it kept, and the workup on that one.
//
// The three tracks all render through this, so a failed track looks like a
// track that failed rather than like a broken page.

import { useEffect, useRef, useState } from "react";
import ErrorCard from "@/components/ErrorCard";
import { CheckList, Verdict } from "@/components/checks";
import type { Track } from "@/lib/run";
import type { LiveMolecule, TrackState } from "@/lib/useRun";
import MoleculeCard from "./MoleculeCard";
import PassingBar from "./PassingBar";
import Stage from "./Stage";
import Workup from "./Workup";

export default function TrackPanel({
  live,
  track,
  rate,
}: {
  live: TrackState;
  track: Track | undefined;
  rate?: number;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const molecules = live.order.map((id) => live.molecules[id]).filter(Boolean);
  // Follow the newest molecule until the track names a winner, and stop
  // following the moment the reader picks one for themselves. A molecule with
  // no verdict yet has no pose either, so it arrives flat and settles into the
  // pocket when its check comes back.
  const auto = live.bestId ?? molecules[molecules.length - 1]?.id ?? null;
  const shownId = picked && live.molecules[picked] ? picked : auto;
  const shown = shownId ? live.molecules[shownId] : null;
  const best = live.bestId ? live.molecules[live.bestId] : null;
  const seed = live.seed ?? track?.seed ?? null;
  const running = live.status === "running" || live.status === "waiting";
  const pocket = live.pocket ?? track?.pocket ?? null;

  // When no co-crystal exists for the seed there is nothing to place anything
  // into, so no fit check is run at all and a molecule's verdict is the worst
  // of the nine checks about the molecule itself. Those nine are the same set
  // the 81.5% figure was measured against, so "accepted" stays comparable to
  // it — but it now means "passed the molecule-alone checks", and on its own
  // an accepted chip would read as though something had been validated against
  // the target. Nothing was. Said once here, and passed to the places that
  // would otherwise imply more than was done.
  // Gated on the pocket event having landed (it always brings one or the
  // other), because before it arrives a null pocket only means "not yet".
  const capped = !pocket && (live.proteins.length > 0 || !!live.pocketNote);
  const whyCapped = capped
    ? `No measured structure of ${seed?.name ?? "the drug it started from"} inside a target protein was found, so nothing in this track was tested against the target at all. Every check these passed was about the molecule alone.`
    : null;

  // A track switch should not carry the previous track's selection over.
  useEffect(() => setPicked(null), [live.pool]);

  return (
    <div className="space-y-6">
      <SeedStrip live={live} track={track} />

      {live.error && (
        <ErrorCard
          msg="This track stopped early"
          detail={`${live.error} The other two tracks were not affected, and whatever this one reached is below.`}
        />
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <Stage
          molecule={shown}
          proteins={live.proteins.length ? live.proteins : (track?.proteins ?? [])}
          pocket={pocket}
          pocketNote={live.pocketNote}
          seedName={seed?.name ?? ""}
          seedDrugId={seed?.drug_id ?? ""}
          waiting={molecules.length === 0}
        />
        <Narrative live={live} running={running} capped={capped} />
      </div>

      {molecules.length > 0 && (
        <section aria-labelledby={`tried-${live.pool}`}>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 id={`tried-${live.pool}`} className="text-[18px] font-bold tracking-[-0.015em]">
              Every molecule it proposed
            </h3>
            <p className="max-w-[60ch] text-[13.5px] leading-relaxed text-muted">
              {capped ? (
                <>
                  {live.accepted} of {live.tried} passed every check that was run, and none of them was tested against
                  the target. Pick one to see what it was judged on.
                </>
              ) : (
                <>
                  {live.accepted} of {live.tried} passed every check. Pick one to see it above.
                </>
              )}
            </p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {molecules.map((molecule) => (
              <li key={molecule.id}>
                <MoleculeCard
                  molecule={molecule}
                  selected={molecule.id === shownId}
                  isBest={molecule.id === live.bestId}
                  onSelect={() => setPicked(molecule.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {best && <Winner molecule={best} capped={whyCapped} />}

      <PassingBar seed={seed} rate={rate} capped={whyCapped} />

      <Workup workup={live.workup} steps={live.steps} moleculeName={best?.name ?? "it"} />
    </div>
  );
}

function SeedStrip({ live, track }: { live: TrackState; track: Track | undefined }) {
  const seed = live.seed ?? track?.seed ?? null;
  const studied = track?.studied;
  if (!seed) {
    return (
      <div className="rounded-[28px] bg-soft-2 px-4 py-3.5 sm:px-5">
        <p className="flex items-center gap-2.5 text-[15px] font-semibold text-muted">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Choosing which drug to build on
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[28px] bg-soft-2 px-4 py-3.5 sm:px-5">
      <p className="text-[15px]">
        Started from{" "}
        <span className="font-bold" style={{ color: "var(--drug)" }}>
          {seed.name}
        </span>
        <span className="text-muted"> at rank score {seed.score}</span>
      </p>
      <p className="flex items-center gap-2 text-[13.5px] text-muted">
        Its own checks: <Verdict status={seed.check.status} />
      </p>
      {studied && (studied.approved > 0 || studied.investigational > 0) && (
        <p className="text-[13.5px] text-muted">
          Read {studied.approved > 0 && `${studied.approved} approved`}
          {studied.approved > 0 && studied.investigational > 0 && " and "}
          {studied.investigational > 0 && `${studied.investigational} unapproved`} compounds first
        </p>
      )}
      {live.pocket && (
        <p className="font-mono text-[12.5px] text-muted" title="The crystal structure the molecules were placed into">
          {live.pocket.pdb_id}
          {live.pocket.resolution_A != null ? ` at ${live.pocket.resolution_A} Å` : ""}
        </p>
      )}
    </div>
  );
}

/** The run talking: the round it is on, what it is thinking, what it has said. */
function Narrative({ live, running, capped }: { live: TrackState; running: boolean; capped: boolean }) {
  const scroller = useRef<HTMLOListElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [live.lines.length]);

  return (
    <section aria-label="What the run is doing" className="rounded-[32px] bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex items-center gap-2.5">
        {running && (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        )}
        <h3 className="text-[16px] font-bold tracking-[-0.015em]">
          {live.status === "error"
            ? "Stopped"
            : live.round
              ? `Round ${live.round.n} of ${live.round.of}`
              : running
                ? "Getting started"
                : "Finished"}
        </h3>
        <span className="ml-auto text-[13px] text-muted" aria-live="polite">
          {/* "accepted" is too strong here, with nothing tested on the target */}
          {capped ? (
            <>
              <span className="tabular-nums">{live.tried}</span> proposed,{" "}
              <span className="tabular-nums">{live.accepted}</span> passed the checks
            </>
          ) : (
            <>
              <span className="tabular-nums">{live.tried}</span> proposed,{" "}
              <span className="tabular-nums">{live.accepted}</span> accepted
            </>
          )}
        </span>
      </div>

      {/* Not a live region: the whole text is resent as it grows, so announcing
          every version would read the same paragraph over and over. The counter
          above carries the state a screen reader needs. */}
      {live.thinking && (
        <p className="mt-3 max-h-48 overflow-y-auto text-[14px] leading-relaxed text-foreground/85">
          {live.thinking}
          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-accent" />
        </p>
      )}

      {live.lines.length > 0 && (
        <ol
          ref={scroller}
          className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pr-1 text-[13.5px] leading-relaxed"
        >
          {live.lines.map((line) => (
            <li key={line.i} className="flex gap-2.5">
              <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-faint">{line.at.toFixed(0)}s</span>
              <span className={line.kind === "reasoning" || line.kind === "best" ? "text-foreground" : "text-muted"}>
                {line.text}
              </span>
            </li>
          ))}
        </ol>
      )}

      {!live.thinking && live.lines.length === 0 && (
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
          Nothing to report yet. Each round is written here as it happens, including the reasoning behind a molecule
          that was then thrown out.
        </p>
      )}
    </section>
  );
}

function Winner({ molecule, capped }: { molecule: LiveMolecule; capped: string | null }) {
  const props = molecule.check?.properties;
  return (
    <section aria-labelledby="kept-h" className="rounded-[32px] bg-surface p-5 shadow-float sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="kept-h" className="text-[20px] font-bold tracking-[-0.02em]">
          The one it kept: {molecule.name}
        </h3>
        <Verdict status={molecule.status} big />
      </div>
      {capped && (
        <p className="mt-2.5 max-w-[70ch] rounded-[22px] bg-soft-2 px-4 py-3 text-[14px] leading-relaxed text-muted">
          Accepted here means it passed the checks about the molecule itself. {capped}
        </p>
      )}
      {molecule.rationale && (
        <p className="mt-2.5 max-w-[70ch] text-[15.5px] leading-relaxed">{molecule.rationale}</p>
      )}
      {molecule.builds_on && (
        <p className="mt-1.5 text-[13.5px] text-muted">Builds on {molecule.builds_on}.</p>
      )}
      {molecule.smiles && <p className="mt-2 break-all font-mono text-[11.5px] text-muted">{molecule.smiles}</p>}
      {props && (
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted">
          {props.formula && <Prop label="Formula" value={props.formula} />}
          {props.mol_weight != null && <Prop label="Weight" value={String(props.mol_weight)} />}
          {props.qed != null && <Prop label="Drug-likeness" value={props.qed.toFixed(2)} />}
          {props.sa_score != null && <Prop label="Ease of making" value={`${props.sa_score} of 10`} />}
          {props.parent_similarity != null && (
            <Prop label="Similarity to the seed" value={props.parent_similarity.toFixed(2)} />
          )}
        </dl>
      )}
      {molecule.check && (
        <div className="mt-4">
          <CheckList checks={molecule.check.checks} />
        </div>
      )}
    </section>
  );
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex gap-1.5">
      <dt>{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </span>
  );
}
