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
        Disease
      </label>
      <div
        className={`flex items-center gap-3 rounded-full bg-surface shadow-soft transition-shadow focus-within:ring-4 focus-within:ring-accent/20 ${
          compact ? "py-1 pl-5 pr-2" : "py-2 pl-7 pr-2"
        }`}
      >
        <svg aria-hidden="true" width={compact ? 18 : 20} height={compact ? 18 : 20} viewBox="0 0 24 24" className="shrink-0 text-muted">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M16.5 16.5 L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          id={inputId}
          autoFocus={autoFocus}
          value={q}
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
          placeholder="Try “Rett syndrome”"
          className={`min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint ${compact ? "py-2.5 text-[15px]" : "py-3.5 text-lg"}`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        {isFetching && <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-soft border-t-accent" />}
        {!compact && (
          <button
            type="button"
            onClick={() => data[active] && pick(data[active])}
            disabled={!data.length}
            className="min-h-12 shrink-0 rounded-full bg-accent px-6 font-bold text-white transition-colors hover:bg-accent-ink disabled:opacity-60"
          >
            Find candidates
          </button>
        )}
      </div>

      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-40 mt-3 max-h-96 w-full overflow-auto rounded-[28px] bg-surface p-2 shadow-float [animation:fadein_.2s_ease]"
        >
          {isError && <li className="px-4 py-3 text-sm text-[#8A2A14]">Search failed. Is the backend running?</li>}
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
                className={`flex cursor-pointer items-center gap-3 rounded-[20px] px-4 py-2.5 ${i === active ? "bg-soft-2" : ""} ${
                  thin ? "opacity-60" : ""
                }`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-disease" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{h.name}</div>
                  <div className="truncate font-mono text-xs text-muted">{h.disease_id}</div>
                </div>
                <span className="text-right text-xs tabular-nums text-muted" title={thin ? "Few known gene associations; results will be weak" : undefined}>
                  {h.n_genes} genes{thin && " · thin"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
