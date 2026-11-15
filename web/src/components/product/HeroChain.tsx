/**
 * The one orchestrated moment on the landing page: the chain draws itself once,
 * then each column explains its part. Three equal columns, so the node, its name
 * and its explanation always sit on the same vertical axis.
 */

const COLS = [
  {
    dot: "bg-drug",
    ring: "ring-drug-soft",
    size: "h-12 w-12",
    kind: "Drug",
    name: "Baclofen",
    mono: false,
    text: "An approved medicine. It already has years of safety data, so it can reach patients far faster than a new drug.",
  },
  {
    dot: "bg-gene",
    ring: "ring-gene-soft",
    size: "h-9 w-9",
    kind: "Gene",
    name: "GABBR2",
    mono: true,
    text: "The bridge. The drug acts on this gene, and the gene is linked to the disease. This is the reason, not a guess.",
  },
  {
    dot: "bg-disease",
    ring: "ring-disease-soft",
    size: "h-12 w-12",
    kind: "Disease",
    name: "Rett syndrome",
    mono: false,
    text: "The condition you searched for. Often rare, often with no treatment, often with nobody funding the search.",
  },
];

export default function HeroChain() {
  return (
    <div className="relative">
      {/* the line, from the centre of column 1 to the centre of column 3 */}
      <div aria-hidden="true" className="absolute left-[16.667%] right-[16.667%] top-6 h-[3px] -translate-y-1/2">
        <div className="h-full origin-left rounded-full bg-line-strong [animation:grow_1s_.25s_cubic-bezier(.65,0,.35,1)_both]" />
        <span className="absolute left-1/4 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-medium text-muted fadein [animation-delay:.9s] max-sm:hidden">
          acts on
        </span>
        <span className="absolute left-3/4 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-medium text-muted fadein [animation-delay:1.1s] max-sm:hidden">
          linked to
        </span>
      </div>
      <ol className="relative grid grid-cols-3 gap-3 sm:gap-8">
        {COLS.map((c, i) => (
          <li key={c.kind} className="flex flex-col items-center text-center">
            <div className="grid h-12 place-items-center">
              <span
                className={`block rounded-full ring-8 ${c.dot} ${c.ring} ${c.size} [animation:pop_.5s_cubic-bezier(.2,.9,.3,1.3)_both]`}
                style={{ animationDelay: `${150 + i * 380}ms` }}
              />
            </div>
            <span className="mt-5 text-[12.5px] font-semibold text-muted">{c.kind}</span>
            <span className={`mt-0.5 text-[17px] sm:text-[22px] ${c.mono ? "font-mono font-medium" : "font-bold tracking-[-0.02em]"}`}>{c.name}</span>
            <p className="mt-3 max-w-[280px] text-[14.5px] leading-relaxed text-muted max-sm:hidden">{c.text}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-center text-[14px] text-muted sm:hidden">
        Baclofen acts on GABBR2, a gene linked to Rett syndrome. Every result reads this way.
      </p>
    </div>
  );
}
