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
    { key: "approved", label: "Approved", n: data.approved.length },
    { key: "investigational", label: "Not approved", n: data.investigational.length },
  ];

  return (
    <div>
      <div role="tablist" aria-label="Candidate lists" className="inline-flex gap-1 rounded-full bg-soft p-1.5 text-sm font-bold">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`min-h-11 rounded-full px-5 transition-all ${
              tab === t.key ? "bg-surface text-foreground shadow-soft" : "text-muted hover:text-foreground"
            }`}
          >
            {t.label} · {t.n}
          </button>
        ))}
      </div>
      <p className="mb-2 mt-4 px-3 text-[13px] text-muted">
        {tab === "approved" ? "Approved drugs: the repurposing candidates." : "Investigational or withdrawn compounds, for researchers."}
      </p>
      <CandidateList
        items={tab === "approved" ? data.approved : data.investigational}
        diseaseId={id}
        selected={selected}
        empty={tab === "approved" ? "No approved drugs reach this disease through the graph." : "No investigational compounds found."}
      />
    </div>
  );
}
