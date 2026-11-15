"use client";

import { citationUrl } from "@/lib/format";
import type { EvidenceItem } from "@/lib/types";

function kind(id: string): string {
  if (id.startsWith("PMID:")) return id;
  if (/^NCT\d+/.test(id)) return id;
  if (id.startsWith("FAERS:")) return "FAERS";
  if (id.startsWith("CHEMBL_MOA:")) return "ChEMBL";
  if (id.startsWith("KG:")) return "Graph";
  if (id.startsWith("CHEM:")) return "Structure";
  if (id.startsWith("SEQ:")) return "Sequence";
  return id;
}

export default function CitationChip({ id, item, onGraph }: { id: string; item?: EvidenceItem; onGraph?: (id: string) => void }) {
  const label = kind(id);
  const isGraph = id.startsWith("KG:");
  const cls = `inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 align-middle font-mono text-[11px] font-medium transition-colors ${
    isGraph ? "bg-[#DCEFE8] text-[#0A5A4E] hover:bg-[#C6E5DA]" : "bg-soft-2 text-muted hover:bg-soft hover:text-foreground"
  }`;
  const title = item ? `${item.title}${item.snippet ? ` · ${item.snippet}` : ""}` : id;

  if (isGraph && onGraph) {
    return (
      <button type="button" className={cls} title={`${title} · highlight in the path`} onClick={() => onGraph(id)}>
        <span className="h-1.5 w-1.5 rounded-full bg-gene" />
        {label}
      </button>
    );
  }
  const url = item?.url || citationUrl(id);
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className={cls} title={title}>
        {label}
      </a>
    );
  }
  return (
    <span className={cls} title={title}>
      {label}
    </span>
  );
}
