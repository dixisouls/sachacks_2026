/**
 * The product's core idea drawn as one line: drug → (gene, sibling, look-alike…) → disease.
 * Used for every path, so a reader learns the shape once and can read it everywhere.
 * Horizontal on wide screens; stacks vertically on phones so labels never shrink.
 */

export type ChainNode = { id: string; label: string; type: "drug" | "gene" | "disease"; role?: "main" };
export type ChainLink = { label?: string; dashed?: boolean };

const DOT: Record<ChainNode["type"], string> = {
  drug: "bg-drug",
  gene: "bg-gene",
  disease: "bg-disease",
};
const SOFT: Record<ChainNode["type"], string> = {
  drug: "bg-drug-soft",
  gene: "bg-gene-soft",
  disease: "bg-disease-soft",
};
const KIND: Record<ChainNode["type"], string> = { drug: "Drug", gene: "Gene", disease: "Disease" };

export default function Chain({
  nodes,
  links,
  size = "md",
  active = true,
  onNode,
  selected,
}: {
  nodes: ChainNode[];
  /** links[i] sits between nodes[i] and nodes[i+1] */
  links: ChainLink[];
  size?: "md" | "lg";
  active?: boolean;
  onNode?: (n: ChainNode) => void;
  selected?: string | null;
}) {
  const lg = size === "lg";
  // three nodes fit on one stretched line; longer chains wrap like a sentence instead of truncating
  const chars = nodes.reduce((n, x) => n + x.label.length, 0) + links.reduce((n, l) => n + (l.label?.length ?? 0), 0);
  const flow = nodes.length > 3 || chars > (lg ? 40 : 52);
  return (
    <ol
      className={`flex w-full flex-col items-stretch sm:flex-row sm:items-center ${flow ? "sm:flex-wrap sm:justify-center sm:gap-y-2" : ""} ${active ? "" : "opacity-45"}`}
      aria-label={nodes.map((n) => n.label).join(", then ")}
    >
      {nodes.map((n, i) => {
        const clickable = !!onNode && n.type === "gene";
        const isSel = selected === n.id;
        const inner = (
          <>
            <span className={`shrink-0 rounded-full ${DOT[n.type]} ${lg ? "h-3.5 w-3.5" : "h-2.5 w-2.5"}`} />
            <span className="min-w-0">
              {lg && <span className="block text-[11px] font-semibold text-muted">{KIND[n.type]}</span>}
              <span
                className={`block truncate ${n.type === "gene" ? "font-mono font-medium" : "font-bold"} ${
                  lg ? "text-[17px] leading-tight sm:text-[19px]" : "text-[14px]"
                }`}
              >
                {n.label}
              </span>
            </span>
          </>
        );
        const nodeCls = `flex min-w-0 items-center gap-2.5 rounded-2xl ${SOFT[n.type]} ${
          lg ? "px-4 py-3" : "px-3 py-2"
        } ${isSel ? "ring-2 ring-gene ring-offset-2 ring-offset-surface" : ""}`;
        return (
          <li key={`${n.id}-${i}`} className="contents">
            {i > 0 && <Link link={links[i - 1]} lg={lg} flow={flow} />}
            <div className={flow ? "min-w-0 sm:shrink-0" : "min-w-0 sm:flex-[0_1_auto]"}>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onNode!(n)}
                  title="Show this protein in 3D"
                  className={`${nodeCls} w-full text-left transition-shadow hover:ring-2 hover:ring-gene/50`}
                >
                  {inner}
                </button>
              ) : (
                <div className={nodeCls}>{inner}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Link({ link, lg, flow }: { link?: ChainLink; lg: boolean; flow: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`relative flex min-w-6 items-center justify-center max-sm:h-9 max-sm:pl-5 ${flow ? "sm:shrink-0 sm:px-3" : "sm:flex-1"}`}
    >
      {/* vertical connector on phones, horizontal on wider screens */}
      <span
        className={`absolute max-sm:left-[17px] max-sm:top-0 max-sm:h-full max-sm:border-l-2 sm:left-0 sm:right-0 sm:top-1/2 sm:border-t-2 ${
          link?.dashed ? "border-dashed border-faint" : "border-line-strong"
        }`}
      />
      {link?.label && (
        <span
          className={`relative whitespace-nowrap rounded-full border border-line bg-surface px-2 py-0.5 font-medium text-muted max-sm:ml-4 ${
            lg ? "text-[12px]" : "text-[11px]"
          }`}
        >
          {link.label}
        </span>
      )}
    </div>
  );
}
