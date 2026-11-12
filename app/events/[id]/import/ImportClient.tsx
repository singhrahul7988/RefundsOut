"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnMapping, SalesField } from "@/ai/mapColumns";
import { PageHeader, btn, Card, Chip } from "@/ui/kit";
import { IconCheckCircle, IconImport, IconSparkle } from "@/ui/icons";
import { Select, field, textarea } from "@/ui/form";
import {
  confirmMappingAction, excludeRowAction, keepRowAction, loadSampleFilesAction, stageSalesAction, uploadScansAction, uploadTextAction,
} from "../../../actions";

export type ImportState = {
  sales: { uploadId: string; fileName: string; rows: number; confirmed: boolean; mapping: ColumnMapping | null; headers: string[]; examples: Record<string, string>; emptyCounts: Record<string, number> } | null;
  tickets: number;
  tiers: { tier: string; n: number }[];
  scans: { fileName: string; matched: number; unmatched: number } | null;
  terms: { fileName: string; clauses: number } | null;
  notice: { fileName: string } | null;
  setAside: { id: number; row: number; reason: string; resolution: string | null; note: string | null }[];
};

const FIELD_LABEL: Record<SalesField, string> = {
  ticket_id: "Ticket ID", order_ref: "Order reference", buyer_name: "Buyer name", buyer_email: "Buyer email", tier: "Ticket type",
  price: "Price paid", paypal_capture_id: "PayPal payment ID", transferred_to: "Transferred to (email)", purchased_at: "Purchase time", ignore: "Not used",
};
const FIELDS = Object.keys(FIELD_LABEL) as SalesField[];

const readFile = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(f); });

export function ImportClient({ eventId, state }: { eventId: string; state: ImportState }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(state.sales?.mapping ?? null);
  const [noticeText, setNoticeText] = useState("");
  const [noticeFile, setNoticeFile] = useState<string | null>(null);
  const [excluding, setExcluding] = useState<number | null>(null);
  const [note, setNote] = useState("");

  const run = (label: string, fn: () => Promise<void>) => start(async () => {
    setBusy(label); setError(null);
    try { await fn(); router.refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  });
  const must = <T,>(r: { ok: true; data?: T } | { ok: false; error: string }) => { if (!r.ok) throw new Error(r.error); return r.data as T; };

  const onSales = (f: File) => run("Gemini is reading your columns…", async () => {
    const data = must(await stageSalesAction(eventId, f.name, await readFile(f)));
    setMapping(data!.mapping);
  });
  const onScans = (f: File) => run("Matching scans to tickets…", async () => { must(await uploadScansAction(eventId, f.name, await readFile(f))); });
  const onTerms = (f: File) => run("Saving the terms…", async () => { must(await uploadTextAction(eventId, "terms", f.name, await readFile(f))); });
  const saveNotice = () => run("Saving the notice…", async () => { must(await uploadTextAction(eventId, "notice", noticeFile ?? "cancellation_notice.txt", noticeText)); });
  const useSample = () => run("Loading the Riverside sample files. Gemini is reading the columns…", async () => {
    const data = must(await loadSampleFilesAction(eventId));
    setMapping(data!.staged.mapping);
    must(await uploadScansAction(eventId, "gate_scans_fri_sun.csv", data!.scansText));
  });
  const confirm = () => run("Importing every row…", async () => { must(await confirmMappingAction(eventId, state.sales!.uploadId, mapping!)); });

  const needsConfirm = !!state.sales && !state.sales.confirmed && !!mapping;
  const unresolved = state.setAside.filter((r) => !r.resolution);
  // Kept rows became tickets, so they no longer count as set aside.
  const heldBack = state.setAside.filter((r) => r.resolution !== "fixed").length;
  const kept = state.setAside.filter((r) => r.resolution === "fixed").length;
  const excluded = state.setAside.filter((r) => r.resolution === "excluded").length;
  const isDuplicate = (reason: string) => /appears \d+ times/.test(reason);
  const ready = state.tickets > 0 && !!state.terms && !!state.notice;
  const maxTier = Math.max(1, ...state.tiers.map((t) => t.n));
  const kinds = [
    { re: /price is empty/i, label: "Missing price", tone: "amber" as const },
    { re: /isn't valid/i, label: "Bad email", tone: "red" as const },
    { re: /appears/i, label: "Duplicate ID", tone: "blue" as const },
    { re: /isn't a number/i, label: "Not a number", tone: "violet" as const },
  ].map((k) => ({ ...k, n: unresolved.filter((r) => k.re.test(r.reason)).length })).filter((k) => k.n > 0);

  return (
    <>
      <PageHeader
        title="Import ticket data"
        subtitle="Upload your files in any layout. Gemini suggests how your columns map to ours. You confirm once, and code applies it to every row."
        actions={
          needsConfirm ? <button className={btn.primary} disabled={pending} onClick={confirm}>Confirm and import</button>
          : ready ? <Link className={btn.primary} href={`/events/${eventId}/policy`}>Next: compile the policy</Link>
          : !state.sales ? <button className={btn.ai + " h-11"} disabled={pending} onClick={useSample}><IconSparkle />Use the Riverside sample files</button>
          : null
        }
      />
      {busy && <div className="ro-pulse rounded-lg bg-ai-soft px-4 py-3 font-medium text-ai-ink">{busy}</div>}
      {error && <div role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-bad-ink">{error}</div>}

      <div className="flex flex-col items-start gap-3 xl:flex-row">
      <div className="grid w-full min-w-0 flex-1 grid-flow-row-dense gap-3 sm:grid-cols-2 2xl:grid-cols-3">
        <FileCard tone="green" title="Ticket sales" accept=".csv" disabled={pending} onFile={onSales} fileName={state.sales?.fileName}
          icon={<path d="M3 6.5 A1.5 1.5 0 0 1 4.5 5 H15.5 A1.5 1.5 0 0 1 17 6.5 V8 A2 2 0 0 0 17 12 V13.5 A1.5 1.5 0 0 1 15.5 15 H4.5 A1.5 1.5 0 0 1 3 13.5 V12 A2 2 0 0 0 3 8 Z M12.5 5.5 V7 M12.5 9.25 V10.75 M12.5 13 V14.5" />}>
          {state.sales && (state.sales.confirmed ? (
            <Meter big={state.tickets} label="rows ready" chip={heldBack ? `${heldBack} set aside` : undefined} a={state.tickets} b={heldBack} colorA="#0B6E55" colorB="#E3A13B" />
          ) : <span className="text-muted">{state.sales.rows} rows · waiting for you to confirm the mapping</span>)}
        </FileCard>
        <FileCard tone="blue" title="Gate scans" accept=".csv" disabled={pending} onFile={onScans} fileName={state.scans?.fileName}
          icon={<path d="M3 6.5 V4.5 A1.5 1.5 0 0 1 4.5 3 H6.5 M13.5 3 H15.5 A1.5 1.5 0 0 1 17 4.5 V6.5 M17 13.5 V15.5 A1.5 1.5 0 0 1 15.5 17 H13.5 M6.5 17 H4.5 A1.5 1.5 0 0 1 3 15.5 V13.5 M7 7 V13 M10 7 V13 M13 7 V13" />}>
          {state.scans && <Meter big={state.scans.matched} label="scans matched" chip={state.scans.unmatched ? `${state.scans.unmatched} ignored` : undefined} chipTone="gray" a={state.scans.matched} b={state.scans.unmatched} colorA="#2F6DB5" colorB="#A3ABB8" />}
        </FileCard>
        <FileCard tone="violet" title="Ticket terms" accept=".txt,.md" disabled={pending} onFile={onTerms} fileName={state.terms?.fileName}
          className={state.notice ? "sm:col-span-2 2xl:col-span-1" : ""}
          icon={<><rect x="4" y="2.5" width="12" height="15" rx="1.5" /><path d="M7 6.5 H13 M7 9.5 H13 M7 12.5 H10" /></>}>
          {state.terms && <div className="flex flex-wrap gap-1.5"><Chip tone="violet">{state.terms.clauses} clauses</Chip>{state.notice ? <Chip tone="green">✓ Notice added</Chip> : <Chip tone="amber">Notice missing</Chip>}</div>}
        </FileCard>

        {state.sales?.confirmed && (
          <Card className="flex min-w-0 flex-col gap-3 p-[18px] sm:col-span-2">
            <div className="flex flex-wrap justify-between gap-2"><b className="text-[15px]">Ticket types found</b><span className="text-muted">{state.tickets} tickets and add-ons</span></div>
            {state.tiers.map((t) => (
              <div key={t.tier} className="grid grid-cols-[minmax(0,190px)_minmax(0,1fr)_44px] items-center gap-3">
                <b className="truncate">{t.tier}</b>
                <div className="h-2.5 rounded-full bg-[#EEF0F3]"><div className="h-2.5 rounded-full bg-accent" style={{ width: `${(t.n / maxTier) * 100}%` }} /></div>
                <b className="text-right">{t.n}</b>
              </div>
            ))}
          </Card>
        )}

      {needsConfirm && mapping && (<>
          <Card className="flex min-w-0 flex-col overflow-hidden sm:col-span-2">
            <div className="flex flex-wrap justify-between gap-2 border-b border-[#E6E9EE] px-[18px] py-3.5">
              <b className="text-[15px]">How your sales columns map</b>
              <span className="font-semibold text-ai">Suggested by Gemini · {mapping.columns.filter((c) => c.confidence === "check").length} to check</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse">
                <thead><tr className="bg-[#F3F5F8] text-left text-xs text-[#3E4652]"><th className="px-[18px] py-2 font-semibold">Your column</th><th className="px-3 py-2 font-semibold">Example value</th><th className="px-3 py-2 font-semibold">RefundsOut field</th><th className="px-[18px] py-2 font-semibold">Match</th></tr></thead>
                <tbody>
                  {mapping.columns.map((c, idx) => (
                    <tr key={c.column} className={`border-t border-[#EEF0F3] ${c.confidence === "check" ? "bg-[#FFFBF2]" : ""}`}>
                      <td className="px-[18px] py-2 font-semibold">{c.column}</td>
                      <td className="mono px-3 py-2 text-[13px] text-[#3E4652]">{state.sales!.examples[c.column] || <span className="font-sans text-muted">Empty in {state.sales!.emptyCounts[c.column]} rows</span>}</td>
                      <td className="px-3 py-2">
                        <Select aria-label={`Field for ${c.column}`} value={c.field} size="sm" tone={c.confidence === "check" ? "warn" : "default"} className="min-w-[220px]"
                          options={FIELDS.map((f) => ({ value: f, label: FIELD_LABEL[f] }))}
                          onChange={(v) => setMapping({ ...mapping, columns: mapping.columns.map((x, i) => (i === idx ? { ...x, field: v, confidence: "sure" } : x)) })} />
                      </td>
                      <td className={`px-[18px] py-2 font-semibold ${c.confidence === "check" ? "text-warn-ink" : c.field === "ignore" ? "text-muted" : "text-[#145C3D]"}`}>{c.confidence === "check" ? "Please check" : c.field === "ignore" ? "Ignored" : "Sure"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card className="flex min-w-0 flex-col gap-3 self-start p-[18px] sm:col-span-2 2xl:col-span-1">
            <b className="text-[15px]">Ticket types found</b>
            <span className="text-muted">Gemini named each product. Rename any you like; these names are what the rules use.</span>
            {mapping.tiers.map((t, idx) => (
              <div key={t.value} className="flex flex-col gap-1">
                <span className="mono text-xs text-muted">{t.value}</span>
                {/* Every row reserves the add-on tag's slot, so all inputs share one width. */}
                <div className={`grid items-center gap-2 ${mapping.tiers.some((x) => x.isAddOn) ? "grid-cols-[minmax(0,1fr)_64px]" : "grid-cols-1"}`}>
                  <input aria-label={`Name for ${t.value}`} value={t.tier} onChange={(e) => setMapping({ ...mapping, tiers: mapping.tiers.map((x, i) => (i === idx ? { ...x, tier: e.target.value } : x)) })} className={field({ size: "sm" }) + " w-full"} />
                  {t.isAddOn ? <span className="justify-self-end"><Chip tone="blue">Add-on</Chip></span> : mapping.tiers.some((x) => x.isAddOn) && <span aria-hidden />}
                </div>
              </div>
            ))}
          </Card>
      </>)}

        {!state.notice && (
          <Card className="flex flex-col gap-2 p-4 sm:col-span-2 2xl:col-span-1">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="notice" className="font-semibold">Cancellation notice</label>
              <label htmlFor="file-notice" title="Load the notice from a .txt file"
                className={`${btn.small} cursor-pointer ${pending ? "pointer-events-none opacity-60" : ""}`}>
                <IconImport size={15} />Upload
              </label>
              <input id="file-notice" type="file" accept=".txt,.md,text/plain" className="sr-only" disabled={pending}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try { setNoticeText((await readFile(f)).trim()); setNoticeFile(f.name); setError(null); }
                  catch { setError(`Couldn't read ${f.name}`); }
                }} />
            </div>
            <textarea id="notice" rows={3} value={noticeText} onChange={(e) => { setNoticeText(e.target.value); if (!e.target.value) setNoticeFile(null); }} placeholder="Paste the announcement or upload a .txt file, e.g. “Due to a severe storm warning, all Saturday performances are cancelled…”" className={textarea()} />
            {noticeFile && <span className="-mt-1 text-xs text-muted">Loaded from <span className="mono">{noticeFile}</span>. Check it, then save.</span>}
            <div><button className={btn.secondary} disabled={pending || noticeText.trim().length < 20} onClick={saveNotice}>Save notice</button></div>
          </Card>
        )}
      </div>

      {state.sales?.confirmed && (
          <Card className="flex w-full min-w-0 flex-none flex-col overflow-hidden xl:w-[340px]">
            {/* Header: amber while rows wait for a decision, green once every row is handled. */}
            {unresolved.length ? (
              <div className="flex flex-col gap-1 border-b border-[#F1DDB3] bg-[#FFF8EA] px-[18px] py-3.5">
                <span className="flex items-center gap-2">
                  <span className="flex size-6 flex-none items-center justify-center rounded-full bg-[#FFE7B8] text-[13px] font-bold text-warn-ink">{unresolved.length}</span>
                  <b className="text-[15px] text-[#5C3600]">{unresolved.length === 1 ? "row needs" : "rows need"} a decision</b>
                </span>
                <span className="text-[#7A5A22]">Nothing is dropped. Keep or exclude each one before approval.</span>
                {kinds.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{kinds.map((k) => <Chip key={k.label} tone={k.tone}>{k.label} · {k.n}</Chip>)}</div>}
              </div>
            ) : (
              <div className="flex items-start gap-2.5 border-b border-[#CFE8DC] bg-ok-soft px-[18px] py-3.5">
                <IconCheckCircle size={22} className="mt-px flex-none text-ok" />
                <span className="flex flex-col gap-0.5">
                  <b className="text-[15px] text-[#145C3D]">All rows checked</b>
                  <span className="text-[#2F5E48]">
                    {[
                      kept ? `${kept} kept` : null,
                      excluded ? `${excluded} excluded` : null,
                    ].filter(Boolean).join(" · ") || "Every row imported"}. Nothing was dropped.
                  </span>
                </span>
              </div>
            )}
            {state.setAside.map((r) => {
              const tone = r.resolution === "fixed" ? "kept" : r.resolution === "excluded" ? "excluded" : "open";
              const look = {
                open: { row: "border-l-[#E3A13B] bg-white", chip: <Chip tone="amber">To check</Chip> },
                kept: { row: "border-l-[#1F8A5B] bg-[#F4FBF7]", chip: <Chip tone="green">✓ Kept</Chip> },
                excluded: { row: "border-l-[#D9A39F] bg-[#FDF7F6]", chip: <Chip tone="red">Excluded</Chip> },
              }[tone];
              return (
              <div key={r.id} className={`flex flex-col gap-2 border-b border-l-[3px] border-b-[#EEF0F3] px-[15px] py-3 last:border-b-0 ${look.row}`}>
                <div className="flex items-start justify-between gap-2">
                  <span className={tone === "excluded" ? "text-muted" : ""}><b className={tone === "excluded" ? "text-[#5A6270]" : ""}>Row {r.row}</b> · <span className={tone === "excluded" ? "line-through decoration-[#C9A9A6]" : ""}>{r.reason}</span></span>
                  <span className="flex-none">{look.chip}</span>
                </div>
                {r.resolution === "fixed" ? <span className="text-xs font-medium text-[#145C3D]">Imported as a ticket</span>
                : r.resolution ? <span className="text-xs text-[#8A4B45]">Reason: {r.note}</span>
                : excluding === r.id ? (
                  <div className="flex gap-2">
                    <input autoFocus aria-label="Reason for excluding" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why exclude it?" className={field({ size: "xs" }) + " flex-1"} />
                    <button className={btn.small} disabled={note.trim().length < 3 || pending} onClick={() => run("Saving…", async () => { must(await excludeRowAction(eventId, r.id, note)); setExcluding(null); setNote(""); })}>Exclude</button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button className={btn.small} onClick={() => { setExcluding(r.id); setNote(""); }}>Exclude with reason</button>
                    {isDuplicate(r.reason) && (
                      <button className={btn.small} disabled={pending} title="Import this row as a ticket. Exclude the other copy first."
                        onClick={() => run("Keeping the row…", async () => { must(await keepRowAction(eventId, r.id)); })}>Keep</button>
                    )}
                  </div>
                )}
              </div>
              );
            })}
          </Card>
      )}
      </div>

    </>
  );
}

function FileCard({ tone, title, icon, accept, onFile, fileName, disabled, className = "", children }: {
  tone: "green" | "blue" | "violet"; title: string; icon: React.ReactNode; accept: string; onFile: (f: File) => void; fileName?: string; disabled: boolean; className?: string; children?: React.ReactNode;
}) {
  const tones = { green: ["#E3F2EC", "#0B6E55"], blue: ["#E5EFFB", "#2F6DB5"], violet: ["#EFECFA", "#5B45B0"] }[tone];
  const id = `file-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <Card className={`flex min-w-0 flex-col gap-2.5 p-4 ${className}`}>
      <div className="flex items-center justify-between gap-2.5">
        <span className="flex items-center gap-3">
          <span className="flex size-10 flex-none items-center justify-center rounded-[10px]" style={{ background: tones[0] }}>
            <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke={tones[1]} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{icon}</svg>
          </span>
          <b className="text-[15px]">{title}</b>
        </span>
        <label htmlFor={id} className={`${btn.small} cursor-pointer ${disabled ? "pointer-events-none opacity-60" : ""}`}>{fileName ? "Replace" : "Upload"}</label>
        <input id={id} type="file" accept={accept} className="sr-only" disabled={disabled} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      </div>
      {fileName ? <span className="mono break-all text-[13px] text-[#3E4652]">{fileName}</span> : <span className="text-muted">No file yet ({accept})</span>}
      {children}
    </Card>
  );
}

function Meter({ big, label, chip, chipTone = "amber", a, b, colorA, colorB }: { big: number; label: string; chip?: string; chipTone?: "amber" | "gray"; a: number; b: number; colorA: string; colorB: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span><b className="text-[22px] leading-7">{big.toLocaleString()}</b> <span className="text-muted">{label}</span></span>
        {chip && <Chip tone={chipTone}>{chip}</Chip>}
      </div>
      <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-sm">
        <div style={{ flex: `${a} 1 0`, background: colorA }} />
        {b > 0 && <div style={{ flex: `${b} 1 0`, minWidth: 6, background: colorB }} />}
      </div>
    </div>
  );
}
