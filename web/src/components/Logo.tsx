/**
 * The mark: a ring kept whole, with one group swapped and one still open.
 *
 * In medicinal chemistry the scaffold is the core you hold fixed while you
 * change what hangs off it, so the mark draws exactly that — the core in ink,
 * the substituent that changed in accent, the position still free left faint.
 */
export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 26 26">
      {/* the core, held */}
      <path
        d="M11 6.8 L5.6 9.9 L5.6 16.1 L11 19.2 L16.4 16.1 L16.4 9.9 Z"
        fill="none"
        stroke="var(--foreground)"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {/* the position still open */}
      <g opacity="0.3">
        <path d="M16.4 16.1 L20.4 18.4" stroke="var(--foreground)" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="21.8" cy="19.2" r="2" fill="none" stroke="var(--foreground)" strokeWidth="1.5" />
      </g>
      {/* the group that changed */}
      <path d="M16.4 9.9 L20.4 7.6" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="21.8" cy="6.8" r="2.3" fill="var(--accent)" />
    </svg>
  );
}
