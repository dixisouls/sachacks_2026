import { READINESS } from "@/lib/format";
import type { Readiness } from "@/lib/types";

/** Tinted tag with a dot and a plain label. `quiet` drops the tint for dense lists. */
export default function ReadinessBadge({ value, quiet = false }: { value: Readiness | string; quiet?: boolean }) {
  const r = READINESS[value as Readiness];
  if (!r) return <span className="text-xs text-muted">{value}</span>;
  return (
    <span
      title={r.hint}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full text-[12.5px] font-semibold ${
        quiet ? "text-muted" : `px-2.5 py-1 ${r.pill}`
      }`}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: r.dot }} />
      {r.label}
    </span>
  );
}
