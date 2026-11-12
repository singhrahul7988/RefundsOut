"use client";

import { useCallback, useEffect, useState } from "react";
import type { CustomToolPanelProps } from "ag-grid-react";
import { money } from "@/ui/grid";

export type RuleBucket = {
  /** Value of the hidden "group" column this bucket filters to. */
  key: string;
  id: string;
  title: string;
  clause?: string;
  quote?: string;
  count: number;
  total: number;
  tone: "rule" | "offer" | "skip";
};

export type RulesToolPanelParams = { buckets: RuleBucket[]; deductions: { id: string; title: string; clause: string }[] };

/**
 * Custom AG Grid tool panel: the compiled refund policy, rule by rule, with how many payments and dollars each
 * rule drives in this plan. Clicking a rule filters the grid to it through the grid's own filter model.
 */
export function RulesToolPanel(props: CustomToolPanelProps & RulesToolPanelParams) {
  const { api, buckets, deductions } = props;
  const [active, setActive] = useState<string | null>(null);

  // Stay in sync when the filter changes elsewhere (Ask the grid, the chart, a column menu).
  useEffect(() => {
    const sync = () => {
      const m = api.getColumnFilterModel("group") as { values?: string[] } | null;
      setActive(m?.values?.length === 1 ? m.values[0] : null);
    };
    sync();
    api.addEventListener("filterChanged", sync);
    return () => { if (!api.isDestroyed()) api.removeEventListener("filterChanged", sync); };
  }, [api]);

  const pick = useCallback(async (key: string | null) => {
    await api.setColumnFilterModel("group", key ? { filterType: "set", values: [key] } : null);
    api.onFilterChanged();
    // Open the rule's group, but not every payment's detail row (expandAll would open those too).
    if (key) api.forEachNode((n) => { if (n.group && n.key === key) n.setExpanded(true); });
  }, [api]);

  const grand = buckets.reduce((s, b) => s + b.total, 0) || 1;
  const toneBar = { rule: "bg-accent", offer: "bg-[#2F6DB5]", skip: "bg-[#A3ABB8]" } as const;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-[13px]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col">
          <b className="text-[14px]">Compiled policy</b>
          <span className="text-xs text-muted">Click a rule to see only its payments</span>
        </div>
        {active && <button className="rounded-md border border-[#DCE0E5] px-2 py-1 text-xs font-semibold hover:bg-[#F5F6F8]" onClick={() => pick(null)}>Show all</button>}
      </div>
      <ul className="flex flex-col gap-2">
        {buckets.map((b) => {
          const on = active === b.key;
          return (
            <li key={b.key}>
              <button
                onClick={() => pick(on ? null : b.key)}
                aria-pressed={on}
                className={`flex w-full flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${on ? "border-accent bg-accent-soft" : "border-[#E4E7EB] bg-white hover:border-[#C9CED6]"}`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0"><b className={b.tone === "rule" ? "text-accent-ink" : ""}>{b.id}</b> <span className="text-[#3E4652]">{b.title}</span></span>
                  <b className="flex-none">{money(b.total)}</b>
                </span>
                <span className="h-1 overflow-hidden rounded bg-[#EEF0F3]"><span className={`block h-1 rounded ${toneBar[b.tone]}`} style={{ width: `${Math.max(2, (b.total / grand) * 100)}%` }} /></span>
                <span className="flex items-center justify-between gap-2 text-xs text-muted">
                  <span>{b.count} payment{b.count === 1 ? "" : "s"}</span>
                  {b.clause && <span className="font-semibold text-ai">Clause {b.clause}</span>}
                </span>
                {on && b.quote && <span className="rounded-md bg-[#F7F5FD] px-2 py-1.5 text-xs text-[#2F2A45]">“{b.quote}”</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {deductions.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-[#E6E9EE] pt-2.5">
          <span className="text-xs font-semibold uppercase tracking-[0.4px] text-muted">Deductions applied first</span>
          {deductions.map((d) => (
            <span key={d.id} className="text-xs"><b>{d.id}</b> {d.title} <span className="text-ai">· Clause {d.clause}</span></span>
          ))}
        </div>
      )}
    </div>
  );
}
