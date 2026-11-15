/** Score as a number over a short bar. Reads at a glance and lines up in a column. */
export default function ScoreMeter({ score, size = "sm" }: { score: number; size?: "sm" | "lg" }) {
  const w = Math.max(3, Math.min(100, score));
  const lg = size === "lg";
  return (
    <span className={`flex shrink-0 flex-col items-center ${lg ? "w-20 gap-2" : "w-11 gap-1"}`} role="img" aria-label={`Score ${score} out of 100`}>
      <span className={`font-bold tabular-nums leading-none tracking-[-0.03em] ${lg ? "text-[44px]" : "text-[17px]"}`}>{score}</span>
      <span className={`block w-full overflow-hidden rounded-full bg-sunken ${lg ? "h-1.5" : "h-1"}`}>
        <span className="block h-full rounded-full bg-accent" style={{ width: `${w}%`, transition: "width .5s ease" }} />
      </span>
    </span>
  );
}
