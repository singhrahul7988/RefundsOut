import { createHash } from "node:crypto";
import Papa from "papaparse";
import { pool, tx, audit } from "@/db/client";
import { suggestColumnMapping, type ColumnMapping } from "@/ai/mapColumns";
import { applySalesMapping, applyScans } from "@/import/sales";
import { compilePolicy } from "@/ai/compilePolicy";
import { runPolicyTests } from "@/policy/evaluate";
import { Policy } from "@/policy/schema";
import { verifyPolicy, type PolicyCheck } from "@/policy/verify";
import { sampleColumnMapping, samplePolicy } from "@/ai/fallbacks";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function parseCsv(text: string) {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  return { headers: parsed.meta.fields ?? [], rows: parsed.data };
}

// ---------- Events ----------

export async function createEvent(args: { name: string; cancelledDay: string; budgetCents: number; approvalThresholdCents?: number }) {
  const { rows } = await pool.query(
    `insert into events (name, cancelled_day, refund_budget_cents, approval_threshold_cents) values ($1,$2,$3,$4) returning id`,
    [args.name, args.cancelledDay, args.budgetCents, args.approvalThresholdCents ?? 5_000_000],
  );
  await audit(pool, { actor: "system", action: "event.create", entity: "event", entityId: rows[0].id, after: args });
  return rows[0].id as string;
}

export async function getEvent(eventId: string) {
  const { rows } = await pool.query(`select * from events where id = $1`, [eventId]);
  return rows[0] ?? null;
}

export async function latestEventId(): Promise<string | null> {
  const { rows } = await pool.query(`select id from events where hidden_at is null order by created_at desc limit 1`);
  return rows[0]?.id ?? null;
}

// ---------- Recent runs: clear (hide) and restore ----------
// Runs are never deleted: they may hold real refunds, and the audit log is insert-only.
// A run that is still sending refunds can't be cleared.

/** Hide the given runs, or every visible run when ids is null. Returns the ids actually hidden. */
export async function hideEvents(ids: string[] | null, actor: string): Promise<string[]> {
  return tx(async (db) => {
    const { rows } = await db.query(
      `update events set hidden_at = now()
        where hidden_at is null and status <> 'running' and ($1::uuid[] is null or id = any($1::uuid[]))
        returning id`,
      [ids],
    );
    for (const r of rows) await audit(db, { actor, action: "event.hide", entity: "event", entityId: r.id });
    return rows.map((r) => r.id as string);
  });
}

export async function restoreEvents(ids: string[], actor: string): Promise<void> {
  await tx(async (db) => {
    const { rows } = await db.query(`update events set hidden_at = null where hidden_at is not null and id = any($1::uuid[]) returning id`, [ids]);
    for (const r of rows) await audit(db, { actor, action: "event.restore", entity: "event", entityId: r.id });
  });
}

// ---------- Sales import: Gemini suggests, organizer confirms, code applies ----------

export async function stageSalesFile(eventId: string, fileName: string, csvText: string) {
  const { headers, rows } = parseCsv(csvText);
  if (!headers.length || !rows.length) throw new Error("The sales file is empty or has no header row.");
  const hash = sha(csvText);
  const existing = await pool.query(`select id, column_mapping from uploads where event_id=$1 and kind='sales' and file_hash=$2`, [eventId, hash]);
  if (existing.rows[0]?.column_mapping) {
    return { uploadId: existing.rows[0].id as string, mapping: existing.rows[0].column_mapping as ColumnMapping, headers, rowCount: rows.length, sameFile: true };
  }
  let mapping: ColumnMapping;
  try {
    ({ data: mapping } = await suggestColumnMapping(headers, rows));
  } catch (err) {
    const fallback = sampleColumnMapping(headers);
    if (!fallback) throw new Error(`Gemini couldn't read the columns right now (${(err as Error).message}). Try again in a moment.`);
    console.warn("[refundsout] Gemini unavailable; using the built-in mapping for the sample file");
    mapping = fallback;
  }
  const { rows: up } = await pool.query(
    `insert into uploads (event_id, kind, file_name, file_hash, content, column_mapping, row_count)
     values ($1,'sales',$2,$3,$4,$5,$6)
     on conflict (event_id, kind, file_hash) do update set column_mapping = excluded.column_mapping
     returning id`,
    [eventId, fileName, hash, csvText, JSON.stringify(mapping), rows.length],
  );
  return { uploadId: up[0].id as string, mapping, headers, rowCount: rows.length, sameFile: false };
}

export async function confirmSalesMapping(eventId: string, uploadId: string, mapping: ColumnMapping, actor: string) {
  const { rows: up } = await pool.query(`select content from uploads where id=$1 and event_id=$2`, [uploadId, eventId]);
  if (!up[0]) throw new Error("Upload not found");
  const { rows } = parseCsv(up[0].content);
  const { tickets, quarantined } = applySalesMapping(rows, mapping);

  await tx(async (db) => {
    await db.query(`delete from tickets where event_id=$1`, [eventId]); // a confirmed re-import replaces the previous one
    await db.query(`delete from quarantined_rows where upload_id in (select id from uploads where event_id=$1 and kind='sales')`, [eventId]);
    for (const t of tickets) {
      await db.query(
        `insert into tickets (event_id, external_ticket_id, tier, price_cents, currency, buyer_email, buyer_name, paypal_capture_id,
                              transferred_to_email, purchased_at, is_comp)
         values ($1,$2,$3,$4,'USD',$5,$6,$7,$8,$9,$10)`,
        [eventId, t.externalTicketId, t.tier, t.priceCents, t.buyerEmail, t.buyerName, t.captureId, t.transferredTo,
         t.purchasedAt ? new Date(t.purchasedAt.replace(" ", "T") + "Z") : null, t.isComp],
      );
    }
    for (const q of quarantined) {
      await db.query(`insert into quarantined_rows (upload_id, row_number, raw_row, reason) values ($1,$2,$3,$4)`, [
        uploadId, q.rowNumber, JSON.stringify(q.raw), q.reason,
      ]);
    }
    await db.query(`update uploads set column_mapping=$2, confirmed_at=now() where id=$1`, [uploadId, JSON.stringify(mapping)]);
    await db.query(`update scans set matched = exists (select 1 from tickets t where t.event_id=scans.event_id and t.external_ticket_id=scans.external_ticket_id) where event_id=$1`, [eventId]);
    await audit(db, { actor, action: "sales.confirm", entity: "upload", entityId: uploadId, after: { tickets: tickets.length, setAside: quarantined.length } });
  });
  return { tickets: tickets.length, quarantined: quarantined.length };
}

/**
 * "Keep" a set-aside row: import it as a ticket after all. Used for duplicate IDs once the wrong copy is excluded.
 * The row is re-checked with the same rules as the import, so a bad price or email can't slip in this way.
 */
export async function keepQuarantinedRow(eventId: string, rowId: number, actor: string) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `select q.id, q.row_number, q.raw_row, q.resolution, u.id as upload_id, u.column_mapping
         from quarantined_rows q join uploads u on u.id=q.upload_id
        where q.id=$1 and u.event_id=$2 and u.kind='sales' and u.confirmed_at is not null
        for update of q`,
      [rowId, eventId],
    );
    const row = rows[0];
    if (!row) throw new Error("That row isn't part of this run.");
    if (row.resolution) throw new Error(`Row ${row.row_number} was already ${row.resolution === "fixed" ? "kept" : "excluded"}.`);

    const mapping = row.column_mapping as ColumnMapping;
    const { tickets, quarantined } = applySalesMapping([row.raw_row], mapping);
    if (!tickets[0]) throw new Error(`Row ${row.row_number} can't be kept: ${quarantined[0]?.reason ?? "it doesn't pass the import checks"}. Fix it in the file and upload again, or exclude it.`);
    const t = tickets[0];

    const idCol = mapping.columns.find((c) => c.field === "ticket_id")?.column;
    const { rows: others } = await db.query(
      `select q.row_number from quarantined_rows q
        where q.upload_id=$1 and q.id<>$2 and q.resolution is distinct from 'excluded' and trim(q.raw_row->>$3)=$4
        order by q.row_number`,
      [row.upload_id, rowId, idCol, t.externalTicketId],
    );
    if (others.length) throw new Error(`Row ${others.map((o) => o.row_number).join(", ")} also uses ticket ID ${t.externalTicketId}. Exclude ${others.length === 1 ? "that row" : "those rows"} first, then keep this one.`);
    const { rows: dup } = await db.query(`select 1 from tickets where event_id=$1 and external_ticket_id=$2`, [eventId, t.externalTicketId]);
    if (dup.length) throw new Error(`Ticket ID ${t.externalTicketId} is already imported.`);

    await db.query(
      `insert into tickets (event_id, external_ticket_id, tier, price_cents, currency, buyer_email, buyer_name, paypal_capture_id,
                            transferred_to_email, purchased_at, is_comp)
       values ($1,$2,$3,$4,'USD',$5,$6,$7,$8,$9,$10)`,
      [eventId, t.externalTicketId, t.tier, t.priceCents, t.buyerEmail, t.buyerName, t.captureId, t.transferredTo,
       t.purchasedAt ? new Date(t.purchasedAt.replace(" ", "T") + "Z") : null, t.isComp],
    );
    await db.query(`update quarantined_rows set resolution='fixed', resolution_note='Kept', resolved_at=now() where id=$1`, [rowId]);
    await db.query(`update scans set matched=true where event_id=$1 and external_ticket_id=$2`, [eventId, t.externalTicketId]);
    await audit(db, { actor, action: "row.keep", entity: "quarantined_row", entityId: String(rowId), after: { ticketId: t.externalTicketId, tier: t.tier, priceCents: t.priceCents } });
    return { ticketId: t.externalTicketId };
  });
}

export async function saveScansFile(eventId: string, fileName: string, csvText: string, actor: string) {
  const { headers, rows } = parseCsv(csvText);
  const scans = applyScans(rows, headers);
  await tx(async (db) => {
    await db.query(`delete from scans where event_id=$1`, [eventId]);
    await db.query(
      `insert into uploads (event_id, kind, file_name, file_hash, row_count, confirmed_at) values ($1,'scans',$2,$3,$4, now())
       on conflict (event_id, kind, file_hash) do nothing`,
      [eventId, fileName, sha(csvText), scans.length],
    );
    for (const s of scans) {
      await db.query(
        `insert into scans (event_id, external_ticket_id, scanned_at, gate, matched)
         values ($1,$2,$3,$4, exists (select 1 from tickets where event_id=$1 and external_ticket_id=$2))`,
        [eventId, s.ticketId, new Date(s.scannedAt.replace(" ", "T") + "Z"), s.gate],
      );
    }
    await audit(db, { actor, action: "scans.import", entity: "event", entityId: eventId, after: { scans: scans.length } });
  });
  const { rows: m } = await pool.query(`select count(*) filter (where matched) as matched, count(*) filter (where not matched) as unmatched from scans where event_id=$1`, [eventId]);
  return { matched: Number(m[0].matched), unmatched: Number(m[0].unmatched) };
}

export async function saveTextDocument(eventId: string, kind: "terms" | "notice", fileName: string, text: string, actor: string) {
  await pool.query(
    `insert into uploads (event_id, kind, file_name, file_hash, content, confirmed_at) values ($1,$2,$3,$4,$5, now())
     on conflict (event_id, kind, file_hash) do update set confirmed_at = now()`,
    [eventId, kind, fileName, sha(text), text],
  );
  await audit(pool, { actor, action: `${kind}.upload`, entity: "event", entityId: eventId, after: { fileName, chars: text.length } });
}

async function latestText(eventId: string, kind: "terms" | "notice"): Promise<string | null> {
  const { rows } = await pool.query(`select content from uploads where event_id=$1 and kind=$2 order by confirmed_at desc nulls last, created_at desc limit 1`, [eventId, kind]);
  return rows[0]?.content ?? null;
}

// ---------- Policy ----------

export async function compileEventPolicy(eventId: string, actor: string) {
  const terms = await latestText(eventId, "terms");
  const notice = await latestText(eventId, "notice");
  if (!terms || !notice) throw new Error("Upload the ticket terms and the cancellation notice first.");

  const { rows: tierRows } = await pool.query(
    `select tier, max(price_cents) as example from tickets where event_id=$1 and price_cents > 0 group by tier order by tier`,
    [eventId],
  );
  const { rows: mapRows } = await pool.query(`select column_mapping from uploads where event_id=$1 and kind='sales' and confirmed_at is not null order by confirmed_at desc limit 1`, [eventId]);
  const addOns = new Set(((mapRows[0]?.column_mapping as ColumnMapping | undefined)?.tiers ?? []).filter((t) => t.isAddOn).map((t) => t.tier));
  const tiers = tierRows.map((r) => ({ tier: r.tier as string, isAddOn: addOns.has(r.tier), examplePriceCents: Number(r.example) }));

  // Answers from earlier versions are passed back so the compiler follows them.
  const { rows: answered } = await pool.query(
    `select q.question, q.answer from policy_questions q join policies p on p.id=q.policy_id where p.event_id=$1 and q.answer is not null`,
    [eventId],
  );
  let policy: Policy, checks: PolicyCheck[], model: string;
  try {
    ({ policy, checks, model } = await compilePolicy({ terms, notice, tiers, organizerAnswers: answered as { question: string; answer: string }[] }));
  } catch (err) {
    const fallback = samplePolicy(terms, tiers.map((t) => t.tier));
    if (!fallback) throw new Error(`Gemini couldn't compile the terms right now (${(err as Error).message}). Try again in a moment.`);
    console.warn("[refundsout] Gemini unavailable; using the verified sample policy");
    policy = fallback;
    checks = verifyPolicy(policy, terms, tiers.map((t) => t.tier));
    model = "sample-fallback";
  }

  return tx(async (db) => {
    const { rows: v } = await db.query(`select coalesce(max(version),0)+1 as v from policies where event_id=$1`, [eventId]);
    await db.query(`update policies set status='superseded' where event_id=$1 and status <> 'superseded'`, [eventId]);
    const { rows: p } = await db.query(
      `insert into policies (event_id, version, source_hash, rules_json, tests_json, checks_json, model) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [eventId, v[0].v, sha(terms + notice), JSON.stringify(policy), JSON.stringify(runPolicyTests(policy)), JSON.stringify(checks), model],
    );
    const answeredSet = new Set(answered.map((a) => a.question));
    for (const q of policy.questions.filter((q) => !answeredSet.has(q.question))) {
      await db.query(`insert into policy_questions (policy_id, clause_quote, question, options) values ($1,$2,$3,$4)`, [
        p[0].id, q.clauseQuote, q.question, JSON.stringify(q.options),
      ]);
    }
    await audit(db, { actor, action: "policy.compile", entity: "policy", entityId: p[0].id, after: { version: v[0].v, model, checks } });
    return p[0].id as string;
  });
}

export async function getCurrentPolicy(eventId: string) {
  const { rows } = await pool.query(`select * from policies where event_id=$1 order by version desc limit 1`, [eventId]);
  if (!rows[0]) return null;
  const { rows: questions } = await pool.query(`select * from policy_questions where policy_id=$1`, [rows[0].id]);
  return {
    ...rows[0],
    policy: Policy.parse(rows[0].rules_json),
    checks: (rows[0].checks_json ?? []) as PolicyCheck[],
    tests: rows[0].tests_json as { name: string; expectedCents: number | null; actualCents: number | null; passed: boolean }[],
    questions,
  };
}

/** Record several answers at once, then recompile a single time. */
export async function answerPolicyQuestions(eventId: string, answers: { questionId: string; answer: string }[], actor: string) {
  for (const a of answers) {
    await pool.query(`update policy_questions set answer=$2, answered_by=$3, answered_at=now() where id=$1`, [a.questionId, a.answer, actor]);
    await audit(pool, { actor, action: "policy.answer", entity: "policy_question", entityId: a.questionId, after: { answer: a.answer } });
  }
  return compileEventPolicy(eventId, actor);
}

/** Record the organizer's answer, then recompile so the rules follow it (a new version). */
export async function answerPolicyQuestion(eventId: string, questionId: string, answer: string, actor: string) {
  await pool.query(`update policy_questions set answer=$2, answered_by=$3, answered_at=now() where id=$1`, [questionId, answer, actor]);
  await audit(pool, { actor, action: "policy.answer", entity: "policy_question", entityId: questionId, after: { answer } });
  return compileEventPolicy(eventId, actor);
}

export async function approvePolicy(eventId: string, policyId: string, actor: string) {
  const current = await getCurrentPolicy(eventId);
  if (!current || current.id !== policyId) throw new Error("This is not the latest policy version.");
  if (current.checks.some((c: PolicyCheck) => !c.passed)) throw new Error("Every check must pass before approval.");
  if (current.questions.some((q: { answer: string | null }) => !q.answer)) throw new Error("Answer the open questions first.");
  await pool.query(`update policies set status='approved', approved_by=$2, approved_at=now() where id=$1`, [policyId, actor]);
  await audit(pool, { actor, action: "policy.approve", entity: "policy", entityId: policyId });
}
