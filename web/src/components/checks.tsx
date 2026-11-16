// One visual language for a verdict, wherever a molecule is judged.
//
// The colours are the palette's, not new ones: mint for passed, the warning
// sand for a question, the drug-red family for rejected. A rejected molecule
// is never hidden, so it needs to read as rejected at a glance and still be
// legible up close.

import type { CheckStatus, DesignCheck } from "@/lib/types";

export const TONE: Record<CheckStatus, { dot: string; chip: string }> = {
  pass: { dot: "bg-[#0B7A69]", chip: "bg-mint text-accent-ink" },
  warn: { dot: "bg-[#B07A00]", chip: "bg-[#FBEFD9] text-[#6B4A06]" },
  fail: { dot: "bg-[#C8452A]", chip: "bg-[#FBE4DE] text-[#8A2A14]" },
};

/** What the run calls each verdict. */
export const VERDICT: Record<CheckStatus, string> = {
  pass: "Accepted",
  warn: "Questions",
  fail: "Rejected",
};

const WHY: Record<CheckStatus, string> = {
  pass: "Every check passed. That is a low bar, not a result.",
  warn: "Passed, with something worth looking at.",
  fail: "At least one check failed, so it was thrown out.",
};

export function Verdict({
  status,
  label,
  big = false,
}: {
  status: CheckStatus | "pending";
  label?: string;
  big?: boolean;
}) {
  const size = big ? "px-3 py-1.5 text-[13px]" : "px-2.5 py-1 text-[12.5px]";
  if (status === "pending") {
    return (
      <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full bg-soft text-muted ${size} font-semibold`}>
        <span className="h-2 w-2 animate-pulse rounded-full bg-faint" />
        Checking
      </span>
    );
  }
  const tone = TONE[status];
  return (
    <span
      title={WHY[status]}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full font-semibold ${tone.chip} ${size}`}
    >
      <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
      {label ?? VERDICT[status]}
    </span>
  );
}

/** The checks themselves. A passing check states the good outcome; a failing
 *  one states what went wrong, which is the only time the problem is useful. */
export function CheckList({ checks, columns = 2 }: { checks: DesignCheck[]; columns?: 1 | 2 }) {
  if (!checks.length) return null;
  return (
    <ul className={`grid gap-x-6 gap-y-1.5 ${columns === 2 ? "sm:grid-cols-2" : ""}`}>
      {checks.map((item) => (
        <li key={item.id} className="flex items-start gap-2 text-[13.5px]" title={item.detail}>
          <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${TONE[item.status].dot}`} />
          <span className="min-w-0">
            <span className={item.status === "pass" ? "" : "font-semibold"}>
              {item.status === "pass" ? item.label : item.problem || item.label}
            </span>{" "}
            <span className="text-muted">{item.value}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
