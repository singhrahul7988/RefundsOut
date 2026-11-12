"use client";

import { useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { setupGrid, gridTheme, statusBar, excelStyles } from "@/ui/grid";
import { btn, Card, Chip } from "@/ui/kit";
import { field } from "@/ui/form";

export type AuditRow = { at: string; actor: string; action: string; entity: string; entityId: string; after: Record<string, unknown> | null };

type Stage = "Import" | "Policy" | "Review" | "Run" | "Event";
const STAGE_TONE: Record<Stage, "gray" | "blue" | "green" | "amber"> = { Event: "gray", Import: "blue", Policy: "gray", Review: "amber", Run: "green" };

function stageOf(action: string): Stage {
  const p = action.split(".")[0];
  if (["terms", "notice", "scans", "sales", "row"].includes(p)) return "Import";
  if (p === "policy") return "Policy";
  if (p === "plan" || p === "item") return "Review";
  if (p === "run") return "Run";
  return "Event";
}

/** One readable line from the JSON payload; the full payload is in the detail row. */
function summarize(after: Record<string, unknown> | null): string {
  if (!after) return "";
  return Object.entries(after)
    .filter(([, v]) => v !== null && typeof v !== "object")
    .map(([k, v]) => `${k}: ${k.endsWith("Cents") && typeof v === "number" ? `$${(v / 100).toFixed(2)}` : typeof v === "string" && v.length > 40 ? v.slice(0, 12) + "…" : v}`)
    .join(" · ");
}

const hasPayload = (d: AuditRow | undefined) => !!d?.after;

function JsonDetail({ data }: ICellRendererParams<AuditRow>) {
  return (
    <div className="flex flex-col gap-1.5 bg-[#FAFBFC] px-4 py-3 pl-12">
      <span className="text-xs text-muted">{data?.entity} <span className="mono">{data?.entityId}</span></span>
      <pre className="mono max-h-[260px] overflow-auto whitespace-pre-wrap rounded-lg border border-[#E6E9EE] bg-white p-3 text-xs leading-5 text-[#3E4652]">{JSON.stringify(data?.after, null, 2)}</pre>
    </div>
  );
}

export function AuditGrid({ rows, licenseKey }: { rows: AuditRow[]; licenseKey?: string }) {
  setupGrid(licenseKey);
  const gridRef = useRef<AgGridReact<AuditRow>>(null);

  const columnDefs = useMemo<ColDef<AuditRow>[]>(() => [
    {
      headerName: "When", field: "at", sort: "desc", width: 190, filter: "agDateColumnFilter", cellRenderer: "agGroupCellRenderer",
      valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""),
      filterParams: { comparator: (day: Date, v: string) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d.getTime() - day.getTime(); } },
    },
    { headerName: "Who", field: "actor", width: 150, filter: "agSetColumnFilter", enableRowGroup: true },
    {
      headerName: "Stage", colId: "stage", width: 120, filter: "agSetColumnFilter", enableRowGroup: true,
      valueGetter: (p) => (p.data ? stageOf(p.data.action) : undefined),
      cellRenderer: (p: ICellRendererParams<AuditRow, Stage>) => (p.value ? <Chip tone={STAGE_TONE[p.value]}>{p.value}</Chip> : null),
    },
    { headerName: "What", field: "action", width: 190, filter: "agSetColumnFilter", enableRowGroup: true, cellClass: "mono" },
    { headerName: "Details", colId: "summary", flex: 1, minWidth: 220, valueGetter: (p) => summarize(p.data?.after ?? null), tooltipValueGetter: (p) => p.value, cellClass: "text-muted" },
  ], []);

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#E6E9EE] px-4 py-3.5">
        <div className="flex flex-[1_1_260px] flex-col gap-1">
          <label htmlFor="audit-find" className="text-xs font-semibold text-muted">Search the log</label>
          <input id="audit-find" placeholder="Person, action, note, amount…" className={field({ size: "md" })}
            onChange={(e) => gridRef.current?.api.setGridOption("quickFilterText", e.target.value)} />
        </div>
        <div className="flex gap-2">
          <button className={btn.secondary} onClick={() => gridRef.current?.api.exportDataAsExcel({ fileName: "refundsout-audit-log.xlsx", sheetName: "Audit log", columnKeys: ["at", "actor", "stage", "action", "summary"] })}>Export to Excel</button>
        </div>
      </div>
      <div style={{ height: 640 }}>
        <AgGridReact<AuditRow>
          ref={gridRef}
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, filter: true, headerClass: "header" }}
          rowGroupPanelShow="always"
          autoGroupColumnDef={{ headerName: "Group", minWidth: 200 }}
          masterDetail
          isRowMaster={hasPayload}
          detailCellRenderer={JsonDetail}
          detailRowAutoHeight
          statusBar={statusBar}
          excelStyles={excelStyles}
          sideBar={{ toolPanels: [{ id: "filters", labelDefault: "Filters", labelKey: "filters", iconKey: "filter", toolPanel: "agFiltersToolPanel" }] }}
          cellSelection
          animateRows
        />
      </div>
    </Card>
  );
}
