export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 26 26">
      <path d="M5 13 C 9 5, 17 5, 21 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.4" />
      <path d="M5 13 C 9 21, 17 21, 21 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.4" />
      <circle cx="5" cy="13" r="3.5" fill="var(--drug)" />
      <circle cx="13" cy="7" r="2.6" fill="var(--gene)" />
      <circle cx="13" cy="19" r="2.6" fill="var(--gene)" />
      <circle cx="21" cy="13" r="3.5" fill="var(--disease)" />
    </svg>
  );
}
