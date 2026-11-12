import { pool } from "@/db/client";
import { getEvent } from "@/server/events";
import type { ColumnMapping } from "@/ai/mapColumns";
import { TopBar } from "@/ui/kit";
import { ImportClient, type ImportState } from "./ImportClient";

export const dynamic = "force-dynamic";

export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  const { rows: uploads } = await pool.query(
    `select distinct on (kind) id, kind, file_name, column_mapping, row_count, confirmed_at, content
       from uploads where event_id=$1 order by kind, created_at desc`,
    [id],
  );
  const byKind = Object.fromEntries(uploads.map((u) => [u.kind, u]));
  const sales = byKind.sales;
  const { rows: tiers } = await pool.query(`select tier, count(*)::int as n from tickets where event_id=$1 group by tier order by n desc`, [id]);
  const { rows: scans } = await pool.query(`select count(*) filter (where matched)::int as matched, count(*) filter (where not matched)::int as unmatched from scans where event_id=$1`, [id]);
  const { rows: setAside } = await pool.query(
    `select q.id, q.row_number, q.reason, q.resolution, q.resolution_note from quarantined_rows q join uploads u on u.id=q.upload_id where u.event_id=$1 order by q.row_number`,
    [id],
  );
  const { rows: t } = await pool.query(`select count(*)::int as n from tickets where event_id=$1`, [id]);

  let headers: string[] = [];
  let examples: Record<string, string> = {};
  let emptyCounts: Record<string, number> = {};
  if (sales?.content) {
    const { parseCsv } = await import("@/server/events");
    const parsed = parseCsv(sales.content);
    headers = parsed.headers;
    examples = Object.fromEntries(headers.map((h) => [h, parsed.rows.find((r) => (r[h] ?? "").trim())?.[h] ?? ""]));
    emptyCounts = Object.fromEntries(headers.map((h) => [h, parsed.rows.filter((r) => !(r[h] ?? "").trim()).length]));
  }

  const state: ImportState = {
    sales: sales ? { uploadId: sales.id, fileName: sales.file_name, rows: sales.row_count, confirmed: !!sales.confirmed_at, mapping: sales.column_mapping as ColumnMapping | null, headers, examples, emptyCounts } : null,
    tickets: t[0].n,
    tiers,
    scans: byKind.scans ? { fileName: byKind.scans.file_name, matched: scans[0].matched, unmatched: scans[0].unmatched } : null,
    terms: byKind.terms ? { fileName: byKind.terms.file_name, clauses: (byKind.terms.content?.match(/^\s*\d+\.\d+/gm) ?? []).length } : null,
    notice: byKind.notice ? { fileName: byKind.notice.file_name } : null,
    setAside: setAside.map((r) => ({ id: Number(r.id), row: r.row_number, reason: r.reason, resolution: r.resolution, note: r.resolution_note })),
  };

  return (
    <>
      <TopBar eventName={event.name} page="Import" />
      <ImportClient eventId={id} state={state} />
    </>
  );
}
