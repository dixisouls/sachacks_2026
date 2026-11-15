import type { PathNode, PathType, Readiness } from "./types";

/** Readiness: a colour + a plain label + one sentence. Colour is never the only signal. */
export const READINESS: Record<Readiness, { label: string; dot: string; pill: string; hint: string }> = {
  APPROVED_UNTESTED: {
    label: "Untested here",
    dot: "#0B7A69",
    pill: "bg-[#DCEFE8] text-[#0A5A4E]",
    hint: "Approved drug that nobody has tried for this disease yet. The most novel kind of lead.",
  },
  IN_TRIALS: {
    label: "In trials",
    dot: "#2C6FD1",
    pill: "bg-[#DFE9FA] text-[#1D4E99]",
    hint: "Someone is already testing it in a clinical trial for this disease family.",
  },
  OFF_LABEL: {
    label: "Used off-label",
    dot: "#6A55D8",
    pill: "bg-[#E6E1F7] text-[#45369A]",
    hint: "Doctors already use it off-label for this disease family.",
  },
  SAFETY_CONCERN: {
    label: "Safety concern",
    dot: "#C8452A",
    pill: "bg-[#FBE4DE] text-[#8A2A14]",
    hint: "Has a contraindication for this disease family, or a black box warning.",
  },
  INVESTIGATIONAL: {
    label: "Not approved",
    dot: "#6F807A",
    pill: "bg-[#E8EDEA] text-[#3E524B]",
    hint: "Never approved anywhere. Max phase shows how far it got.",
  },
  WITHDRAWN: {
    label: "Withdrawn",
    dot: "#8A2A14",
    pill: "bg-[#F3D3CB] text-[#6E1D0C]",
    hint: "Was approved, then withdrawn from the market.",
  },
};

export const PATH_LABEL: Record<PathType, string> = {
  shared_biology: "Shared biology",
  sibling_disease: "Sibling disease",
  chemical_analog: "Look-alike drug",
  protein_homolog: "Related protein",
};

/** One plain sentence per path type, for people who do not know the jargon. */
export const PATH_HINT: Record<PathType, string> = {
  shared_biology: "The drug acts on a gene that is linked to the disease.",
  sibling_disease: "The drug already treats a closely related disease.",
  chemical_analog: "A drug with almost the same structure reaches the disease.",
  protein_homolog: "The drug acts on a protein very similar to one linked to the disease.",
};

export const PATH_SHORT: Record<PathType, string> = {
  shared_biology: "gene",
  sibling_disease: "sibling",
  chemical_analog: "look-alike",
  protein_homolog: "related protein",
};

export function citationUrl(id: string): string | null {
  if (id.startsWith("PMID:")) return `https://pubmed.ncbi.nlm.nih.gov/${id.slice(5)}/`;
  if (/^NCT\d{8}$/.test(id)) return `https://clinicaltrials.gov/study/${id}`;
  if (id.startsWith("http")) return id;
  return null;
}

/** Normalised key used to match a KG citation in a brief with an edge in the path graph. */
export function kgKey(citation: string | null | undefined): string | null {
  if (!citation || !citation.startsWith("KG:")) return null;
  const [a, b] = citation.slice(3).split("|");
  return a && b ? [a, b].sort().join("|") : null;
}

/** "BACLOFEN" -> "Baclofen". Leaves mixed-case names and gene symbols alone. */
export function titleCase(s: string | null | undefined): string {
  if (!s) return "";
  if (s !== s.toUpperCase() || /\d/.test(s) && s.length <= 8) return s;
  return s.toLowerCase().replace(/(^|[\s\-(/])\p{L}/gu, (m) => m.toUpperCase());
}

export const drugLabel = (name: string | null | undefined, id: string) => titleCase(name) || id;

/** Backend explanations use upper-case drug names; soften those using the node list. */
export function softenNames(text: string, nodes: PathNode[]): string {
  let out = text;
  for (const n of nodes) {
    if (n.type === "drug" && n.label && n.label === n.label.toUpperCase()) {
      out = out.split(n.label).join(titleCase(n.label));
    }
  }
  return out;
}

/** Score ring geometry for a 0..100 value. */
export function ringDash(score: number, r: number) {
  const c = 2 * Math.PI * r;
  return `${((c * Math.max(0, Math.min(100, score))) / 100).toFixed(1)} ${c.toFixed(1)}`;
}
