"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { searchDiseases } from "@/lib/api";
import type { DiseaseHit } from "@/lib/types";

const THIN = 5;

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function DiseaseSearch({
  autoFocus = false,
  compact = false,
  initial = "",
}: {
  autoFocus?: boolean;
  compact?: boolean;
  initial?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 200);
  const listId = useId();
  const inputId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQ(initial), [initial]);

  const { data = [], isFetching, isError } = useQuery({
    queryKey: ["search", dq],
    queryFn: () => searchDiseases(dq),
    enabled: dq.length >= 2,
  });

  useEffect(() => setActive(0), [dq]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = (h: DiseaseHit) => {
    setOpen(false);
    setQ(h.name);
    router.push(`/d/${encodeURIComponent(h.disease_id)}`);
  };

  const showList = open && dq.length >= 2 && dq !== initial;

  return (
    <div ref={boxRef} className="relative w-full">
      <label htmlFor={inputId} className="sr-only">
        Disease name
      </label>
      <div
        className={`flex items-center gap-3 border border-line bg-surface transition-[box-shadow,border-color] focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15 ${
          compact ? "h-11 rounded-full pl-4 pr-2" : "h-[68px] rounded-[22px] pl-6 pr-2.5 shadow-float"
        }`}
      >
        <svg aria-hidden="true" width={compact ? 17 : 22} height={compact ? 17 : 22} viewBox="0 0 24 24" className="shrink-0 text-faint">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <path d="M16.5 16.5 L21 21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <input
          id={inputId}
          autoFocus={autoFocus}
          value={q}
          autoComplete="off"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!showList || !data.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, data.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(data[active]);
            } else if (e.key === "Escape") setOpen(false);
          }}
          placeholder={compact ? "Search another disease" : "Type a disease, like Rett syndrome"}
          className={`h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint ${compact ? "text-[14px]" : "text-[19px]"}`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        {isFetching && <span aria-label="Searching" className="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-sunken border-t-accent" />}
        {!compact && (
          <button
            type="button"
            onClick={() => data[active] && pick(data[active])}
            disabled={!data.length}
            className="h-12 shrink-0 rounded-[15px] bg-foreground px-5 text-[15px] font-semibold text-surface transition-colors hover:bg-accent-ink disabled:bg-faint/60 max-sm:px-4"
          >
            Find drugs
          </button>
        )}
      </div>

      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="fadein absolute z-40 mt-2 max-h-[420px] w-full overflow-auto rounded-[20px] border border-line bg-surface p-1.5 text-left shadow-float"
        >
          {isError && <li className="px-4 py-3 text-sm text-[#8C2018]">Search is not reachable. Check that the backend is running.</li>}
          {!isError && !isFetching && data.length === 0 && <li className="px-4 py-3 text-sm text-muted">No diseases match “{dq}”.</li>}
          {data.map((h, i) => {
            const thin = h.n_genes < THIN;
            return (
              <li
                key={h.disease_id}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(h);
                }}
                className={`flex cursor-pointer items-center gap-3 rounded-[14px] px-3.5 py-2.5 ${i === active ? "bg-sunken" : ""}`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-disease" />
                <span className={`min-w-0 flex-1 truncate font-semibold ${thin ? "text-muted" : ""}`}>{h.name}</span>
                <span
                  className={`shrink-0 text-right text-xs tabular-nums ${thin ? "rounded-full bg-drug-soft px-2 py-0.5 font-semibold text-[#8a3f0c]" : "text-faint"}`}
                  title={thin ? "Few known genes, so the ranking will be weak" : undefined}
                >
                  {h.n_genes} {h.n_genes === 1 ? "gene" : "genes"}
                  {thin && ", weak data"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
