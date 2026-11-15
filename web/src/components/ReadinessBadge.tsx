import { READINESS } from "@/lib/format";
import type { Readiness } from "@/lib/types";

/** Soft pill version, for headers and the brief. */
export default function ReadinessBadge({ value }: { value: Readiness | string }) {
  const r = READINESS[value as Readiness];
  if (!r) return <span className="text-xs text-muted">{value}</span>;
  return (
    <span title={r.hint} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold ${r.pill}`}>
      <span className="h-2 w-2 rounded-full" style={{ background: r.dot }} />
      {r.label}
    </span>
  );
}
