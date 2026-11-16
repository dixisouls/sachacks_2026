"use client";

// What happens to the winner after it wins: how it would be made, what the
// body would do to it, what else it might hit, and whether any of that adds
// up to a reason to make it.
//
// Every number in here is computed. The model only explains, so the sections
// say which is which, and a section that could not be produced says so rather
// than quietly going missing.

import { TONE } from "@/components/checks";
import { WORKUP_KINDS } from "@/lib/run";
import type { StepStatus, Workup as WorkupData, WorkupKind } from "@/lib/run";

type Steps = Partial<Record<WorkupKind, { label: string; status: StepStatus; note?: string }>>;

export default function Workup({
  workup,
  steps,
  moleculeName,
}: {
  workup: WorkupData;
  steps: Steps;
  moleculeName: string;
}) {
  const anything = WORKUP_KINDS.some((kind) => workup[kind] || steps[kind]);
  if (!anything) return null;

  return (
    <section aria-labelledby="workup-h" className="space-y-3">
      <div>
        <h3 id="workup-h" className="text-[20px] font-bold tracking-[-0.02em]">
          Taking {moleculeName} seriously for a minute
        </h3>
        <p className="mt-1 max-w-[70ch] text-[14px] leading-relaxed text-muted">
          The four questions a chemist would ask next. Every number is computed from the structure; the model writes
          only the explanations.
        </p>
      </div>

      {WORKUP_KINDS.map((kind) => {
        const step = steps[kind];
        const data = workup[kind];
        if (!step && !data) return null;
        return (
          <Section
            key={kind}
            title={step?.label ?? TITLE[kind]}
            status={data ? "done" : (step?.status ?? "running")}
            note={step?.note}
          >
            {kind === "synthesis" && workup.synthesis && <Synthesis data={workup.synthesis} />}
            {kind === "admet" && workup.admet && <Admet data={workup.admet} />}
            {kind === "offtarget" && workup.offtarget && <OffTarget data={workup.offtarget} />}
            {kind === "case" && workup.case && <Case data={workup.case} />}
          </Section>
        );
      })}
    </section>
  );
}

const TITLE: Record<WorkupKind, string> = {
  // "Possible routes", not "how it is made": the difficulty figure beside it is
  // computed, but the steps themselves are the model's suggestion and no tool
  // has checked that the reactions work or that the materials can be bought.
  synthesis: "Possible routes",
  admet: "What the body would do to it",
  offtarget: "What else it might hit",
  case: "The case for taking it forward",
};

function Section({
  title,
  status,
  note,
  children,
}: {
  title: string;
  status: StepStatus;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex items-center gap-2.5">
        <h4 className="text-[16px] font-bold tracking-[-0.015em]">{title}</h4>
        {status === "running" && (
          <span
            aria-label="Working"
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
          />
        )}
      </div>
      {status === "running" && (
        <div className="mt-3 space-y-2" aria-hidden="true">
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton h-4 w-1/2" />
        </div>
      )}
      {status === "error" && (
        <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-muted">
          {note ? `${note} ` : ""}This section could not be produced, so it is missing rather than guessed.
        </p>
      )}
      {status === "done" && <div className="mt-3">{children}</div>}
    </section>
  );
}

function Synthesis({ data }: { data: NonNullable<WorkupData["synthesis"]> }) {
  return (
    <div className="space-y-4">
      <p className="text-[15px] font-semibold">{data.difficulty}</p>
      {/* a real sequence, so it is numbered */}
      <ol className="space-y-2.5">
        {data.steps.map((step) => (
          <li key={step.n} className="flex gap-3">
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-mint font-mono text-[12px] font-semibold text-accent-ink">
              {step.n}
            </span>
            <span className="min-w-0">
              <span className="text-[14.5px] font-medium">{step.what}</span>
              <span className="block text-[13px] leading-relaxed text-muted">{step.why}</span>
            </span>
          </li>
        ))}
      </ol>
      {data.note && <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted">{data.note}</p>}
    </div>
  );
}

function Admet({ data }: { data: NonNullable<WorkupData["admet"]> }) {
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {data.items.map((item) => (
          <div key={item.label} className="flex gap-2.5">
            <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${TONE[item.status].dot}`} />
            <div className="min-w-0">
              <dt className="text-[14.5px] font-semibold">{item.label}</dt>
              <dd className="text-[13.5px] text-muted">
                {item.value}
                <span className="block text-[13px] leading-relaxed">{item.detail}</span>
              </dd>
            </div>
          </div>
        ))}
      </dl>
      {data.note && <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted">{data.note}</p>}
    </div>
  );
}

function OffTarget({ data }: { data: NonNullable<WorkupData["offtarget"]> }) {
  // An empty list is a real result and not a missing one, so it gets a
  // sentence at full weight. The note says why it is empty — a similarity
  // cutoff in the data, not a molecule that was shown to be selective — and
  // that distinction is the whole value of the section.
  if (data.items.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-[14.5px] font-semibold">Nothing in the data to flag.</p>
        {data.note && <p className="max-w-[70ch] text-[14px] leading-relaxed text-muted">{data.note}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ul className="space-y-3.5">
        {data.items.map((item) => (
          <li key={item.symbol}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[14px] font-medium">{item.symbol}</span>
              <span className="shrink-0 text-[13px] tabular-nums text-muted">
                {Math.round(item.identity * 100)}% of the sequence shared
              </span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.round(item.identity * 100)}%` }} />
            </div>
            <p className="mt-1.5 max-w-[70ch] text-[13.5px] leading-relaxed text-muted">{item.concern}</p>
          </li>
        ))}
      </ul>
      {data.note && <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted">{data.note}</p>}
    </div>
  );
}

function Case({ data }: { data: NonNullable<WorkupData["case"]> }) {
  return (
    <div className="space-y-5">
      <p className="max-w-[60ch] text-[17px] font-semibold leading-snug tracking-[-0.01em]">{data.verdict}</p>
      <div className="grid gap-5 sm:grid-cols-2">
        <Side title="What it has going for it" items={data.for} dot="bg-accent" />
        <Side title="What is wrong with it" items={data.against} dot="bg-[#C8452A]" />
      </div>
      {data.next_step && (
        <div className="rounded-[22px] bg-mint px-4 py-3.5">
          <p className="text-[13px] font-semibold text-accent-ink">The one experiment that would settle it</p>
          <p className="mt-1 max-w-[70ch] text-[14.5px] leading-relaxed text-accent-ink">{data.next_step}</p>
        </div>
      )}
    </div>
  );
}

function Side({ title, items, dot }: { title: string; items: string[]; dot: string }) {
  return (
    <div>
      <h5 className="text-[14px] font-bold">{title}</h5>
      <ul className="mt-2 space-y-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[14px] leading-relaxed">
            <span className={`mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
        {items.length === 0 && <li className="text-[13.5px] text-muted">Nothing listed.</li>}
      </ul>
    </div>
  );
}
