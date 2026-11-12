"use client";

import { AllEnterpriseModule, LicenseManager, ModuleRegistry } from "ag-grid-enterprise";
import { AgChartsEnterpriseModule } from "ag-charts-enterprise";
import { themeQuartz } from "ag-grid-community";
import type { ExcelStyle, GridState, StatusPanelDef } from "ag-grid-community";
import type { AgChartTheme } from "ag-charts-enterprise";

let registered = false;
export function setupGrid(licenseKey?: string) {
  if (registered) return;
  // Integrated Charts (cross-filter chart on Review) need the AG Charts Enterprise module.
  ModuleRegistry.registerModules([AllEnterpriseModule.with(AgChartsEnterpriseModule)]);
  if (licenseKey) LicenseManager.setLicenseKey(licenseKey);
  registered = true;
}

export const gridTheme = themeQuartz.withParams({
  accentColor: "#0B6E55",
  fontFamily: "inherit",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  headerBackgroundColor: "#F3F5F8",
  headerTextColor: "#3E4652",
  borderColor: "#E4E7EB",
  rowHoverColor: "#F5F8F6",
  selectedRowBackgroundColor: "#EAF5F0",
  rangeSelectionBorderColor: "#0B6E55",
  rangeSelectionBackgroundColor: "rgba(11, 110, 85, 0.08)",
  wrapperBorderRadius: 10,
  rowHeight: 48,
  headerHeight: 40,
  cellHorizontalPadding: 14,
});

export const money = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "");

/** Chart theme in the RefundsOut palette, so integrated charts look like part of the product. */
export const CHART_THEME = "refundsout";
const FILLS = ["#0B6E55", "#2F6DB5", "#5B45B0", "#E3A13B", "#1F8A5B", "#8A919C", "#B3261E", "#4FA88A"];
export const customChartThemes: Record<string, AgChartTheme> = {
  [CHART_THEME]: {
    baseTheme: "ag-default",
    palette: { fills: FILLS, strokes: FILLS },
    params: { fontFamily: "inherit", fontSize: 12, foregroundColor: "#10221C", backgroundColor: "#FFFFFF" },
    overrides: {
      common: { padding: { top: 8, right: 12, bottom: 8, left: 12 }, legend: { position: "right", item: { label: { fontSize: 12 } } } },
    },
  },
};

/** Status bar: row counts on the left, sum/avg/count of any cells the user drags across on the right. */
export const statusBar: { statusPanels: StatusPanelDef[] } = {
  statusPanels: [
    { statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" },
    { statusPanel: "agSelectedRowCountComponent", align: "left" },
    { statusPanel: "agAggregationComponent", align: "right", statusPanelParams: { aggFuncs: ["sum", "avg", "count"] } },
  ],
};

/** Excel styles referenced by cellClass / headerClass so the export opens audit-ready, not as raw text. */
export const excelStyles: ExcelStyle[] = [
  { id: "header", font: { bold: true, color: "#3E4652" }, interior: { color: "#F3F5F8", pattern: "Solid" }, alignment: { vertical: "Center" } },
  { id: "money", numberFormat: { format: "$#,##0.00" } },
  { id: "ro-edited", font: { color: "#7A4600", bold: true }, interior: { color: "#FFF1D6", pattern: "Solid" } },
  { id: "title", font: { bold: true, size: 16, color: "#0B4F3D" } },
  { id: "label", font: { bold: true, color: "#3E4652" } },
  { id: "pass", font: { color: "#145C3D", bold: true } },
  { id: "fail", font: { color: "#8A1C15", bold: true } },
  { id: "muted", font: { color: "#6B7280", italic: true } },
];

const NUMBER_OPS: Record<string, string> = {
  equals: "=", notEqual: "≠", lessThan: "<", lessThanOrEqual: "≤", greaterThan: ">", greaterThanOrEqual: "≥",
};
const TEXT_OPS: Record<string, string> = {
  contains: "contains", notContains: "doesn't contain", equals: "is", notEqual: "isn't", startsWith: "starts with", endsWith: "ends with",
  blank: "is blank", notBlank: "isn't blank",
};

type FilterLike = {
  filterType?: string; type?: string; filter?: unknown; filterTo?: unknown; values?: unknown[];
  operator?: string; conditions?: FilterLike[]; filterModels?: (FilterLike | null)[];
};

function describeFilter(name: string, f: FilterLike, fmt: (v: unknown) => string): string {
  if (f.conditions?.length) return f.conditions.map((c) => describeFilter(name, c, fmt)).join(` ${(f.operator ?? "AND").toLowerCase()} `);
  if (f.filterModels) return f.filterModels.filter(Boolean).map((m) => describeFilter(name, m as FilterLike, fmt)).join(" and ");
  if (f.filterType === "set") {
    const v = (f.values ?? []).map((x) => String(x));
    return `${name} is ${v.length > 2 ? `${v.slice(0, 2).join(", ")} +${v.length - 2}` : v.join(" or ") || "nothing"}`;
  }
  if (f.type === "inRange") return `${name} ${fmt(f.filter)}–${fmt(f.filterTo)}`;
  if (f.type === "blank" || f.type === "notBlank") return `${name} ${TEXT_OPS[f.type]}`;
  if (f.filterType === "number" || f.filterType === "bigint") return `${name} ${NUMBER_OPS[f.type ?? ""] ?? f.type} ${fmt(f.filter)}`;
  return `${name} ${TEXT_OPS[f.type ?? ""] ?? f.type} “${String(f.filter ?? "")}”`;
}

export type StateChip = { kind: "Filter" | "Sort" | "Group" | "Pivot" | "Columns" | "Total"; text: string };

/**
 * Turns the grid state the AI returned into short, human chips ("Filter · Refund > $100"),
 * so the user can see exactly what "Ask the grid" changed instead of trusting it blindly.
 */
export function describeGridState(state: GridState, nameOf: (colId: string) => string, isMoney: (colId: string) => boolean): StateChip[] {
  const chips: StateChip[] = [];
  const fmt = (colId: string) => (v: unknown) => (isMoney(colId) && typeof v === "number" ? money(v) : String(v));
  for (const [colId, f] of Object.entries(state.filter?.filterModel ?? {})) {
    if (f) chips.push({ kind: "Filter", text: describeFilter(nameOf(colId), f as FilterLike, fmt(colId)) });
  }
  for (const s of state.sort?.sortModel ?? []) chips.push({ kind: "Sort", text: `${nameOf(s.colId)} ${s.sort === "desc" ? "↓ high to low" : "↑ low to high"}` });
  const groups = state.rowGroup?.groupColIds ?? [];
  if (groups.length) chips.push({ kind: "Group", text: groups.map(nameOf).join(" → ") });
  if (state.pivot?.pivotMode) chips.push({ kind: "Pivot", text: (state.pivot.pivotColIds ?? []).map(nameOf).join(", ") || "on" });
  // Paid / refunded / refund always sum, so only call out an aggregation the AI actually changed.
  for (const a of state.aggregation?.aggregationModel ?? []) {
    if (a.aggFunc !== "sum" || state.pivot?.pivotMode) chips.push({ kind: "Total", text: `${String(a.aggFunc)} of ${nameOf(a.colId)}` });
  }
  const hidden = new Set(state.columnVisibility?.hiddenColIds ?? []);
  const shown = ["email", "tickets", "captureId", "refunded"].filter((c) => state.columnVisibility && !hidden.has(c) && !groups.includes(c));
  if (shown.length) chips.push({ kind: "Columns", text: `Showing ${shown.map(nameOf).join(", ")}` });
  return chips;
}
