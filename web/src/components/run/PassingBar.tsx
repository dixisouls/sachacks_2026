// What passing these checks is worth, said next to the result rather than
// under it. The starting drug clears the same checks, and so do four out of
// five molecules drawn at random, so a design that passes has cleared a sieve
// and nothing more. Removing this is removing the only thing that makes the
// rest of the page honest.

import { Verdict } from "@/components/checks";
import type { Seed } from "@/lib/run";

export default function PassingBar({ seed, rate }: { seed: Seed | null; rate?: number }) {
  if (!seed && rate == null) return null;
  return (
    <section aria-labelledby="bar-h" className="rounded-[28px] bg-soft-2 p-4 sm:p-5">
      <h3 id="bar-h" className="text-[16px] font-bold tracking-[-0.015em]">
        What passing these checks is worth
      </h3>
      <dl className="mt-3 grid gap-5 sm:grid-cols-3">
        {seed && (
          <div>
            <dt className="text-[13px] text-muted">The drug it was built on</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2 text-[15px] font-semibold">
              {seed.name}
              <Verdict status={seed.check.status} />
            </dd>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              {seed.check.status === "pass"
                ? `${seed.name} clears every check too, and it is already a medicine. A design that only matches it has improved on nothing.`
                : `${seed.name} does not clear every check itself, so a design that does has at least beaten its own starting point on paper.`}
            </p>
          </div>
        )}
        {rate != null && (
          <div>
            <dt className="text-[13px] text-muted">Molecules drawn at random</dt>
            <dd className="mt-1 text-[15px] font-semibold tabular-nums">{Math.round(rate * 100)}% also pass</dd>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Measured over 200 molecules pulled at random from the drug table. The checks ask whether something is a
              plausible molecule, not whether it suits this protein.
            </p>
          </div>
        )}
        <div>
          <dt className="text-[13px] text-muted">What is not tested</dt>
          <dd className="mt-1 text-[15px] font-semibold">Binding, and safety</dd>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            Nothing here measures whether a molecule binds anything. No assay was run, nothing was synthesised, and no
            animal or person has been near any of these structures.
          </p>
        </div>
      </dl>
    </section>
  );
}
