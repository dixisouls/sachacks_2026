/** The chain, as a mark: drug, gene, disease on one line. */
export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 26 26">
      <path d="M4.5 13 H 21.5" stroke="var(--foreground)" strokeWidth="1.8" strokeLinecap="round" opacity="0.35" />
      <circle cx="4.5" cy="13" r="3.6" fill="var(--drug)" />
      <circle cx="13" cy="13" r="2.6" fill="var(--gene)" />
      <circle cx="21.5" cy="13" r="3.6" fill="var(--disease)" />
    </svg>
  );
}
