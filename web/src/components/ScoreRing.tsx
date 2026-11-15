import { ringDash } from "@/lib/format";

export default function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const r = 18;
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" className="shrink-0" role="img" aria-label={`Score ${score} of 100`}>
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--soft)" strokeWidth="4" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={ringDash(score, r)}
        transform="rotate(-90 22 22)"
        style={{ transition: "stroke-dasharray .6s ease" }}
      />
      <text x="22" y="26.5" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--foreground)">
        {score}
      </text>
    </svg>
  );
}
