import { READINESS } from "@/lib/format";
import type { Readiness } from "@/lib/types";

/** Quiet readiness marker for list rows: colored dot + label. */
export default function ReadinessDot({ value }: { value: Readiness }) {
  const r = READINESS[value];
  if (!r) return null;
  return (
    <span title={r.hint} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold">
      <span className="h-2 w-2 rounded-full" style={{ background: r.dot }} />
      {r.label}
    </span>
  );
}
