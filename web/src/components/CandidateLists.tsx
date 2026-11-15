"use client";

import { useState } from "react";
import type { CandidatesResponse } from "@/lib/types";
import CandidateList from "./CandidateList";

type Tab = "approved" | "investigational";

export default function CandidateLists({ data, selected }: { data: CandidatesResponse; selected?: string }) {
  const id = data.disease.disease_id;
  const inInvest = data.investigational.some((c) => c.drug_id === selected);
  const [tab, setTab] = useState<Tab>(inInvest ? "investigational" : "approved");

  const tabs: { key: Tab; label: string; n: number }[] = [
    { key: "approved", label: "Approved drugs", n: data.approved.length },
    { key: "investigational", label: "Not yet approved", n: data.investigational.length },
  ];

  return (
    <div className="panel overflow-hidden">
      <div className="border-b border-line p-3">
        <div role="tablist" aria-label="Which drugs" className="grid grid-cols-2 gap-1 rounded-[14px] bg-sunken p-1 text-[14px] font-semibold">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`flex h-10 items-center justify-center gap-2 rounded-[11px] transition-colors ${
                tab === t.key ? "bg-surface text-foreground shadow-soft" : "text-muted hover:text-foreground"
              }`}
            >
              {t.label}
              <span className={`rounded-full px-1.5 text-[12px] tabular-nums ${tab === t.key ? "bg-accent-soft text-accent-ink" : "text-faint"}`}>{t.n}</span>
            </button>
          ))}
        </div>
        <p className="px-1 pt-3 text-[13px] leading-snug text-muted">
          {tab === "approved"
            ? "Already on the market, so they have safety data. These are the repurposing candidates."
            : "Experimental or withdrawn compounds. Useful for researchers, further from patients."}
        </p>
      </div>
      <CandidateList
        key={tab}
        items={tab === "approved" ? data.approved : data.investigational}
        diseaseId={id}
        selected={selected}
        empty={tab === "approved" ? "No approved drugs reach this disease through the graph." : "No investigational compounds found."}
      />
    </div>
  );
}
