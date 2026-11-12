import { pool } from "@/db/client";
import { getEvent } from "@/server/events";
import { TopBar, PageHeader } from "@/ui/kit";
import { AuditGrid, type AuditRow } from "./AuditGrid";

export const dynamic = "force-dynamic";

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  const { rows } = await pool.query(
    `select a.at, a.actor, a.action, a.entity, a.entity_id, a.after from audit_log a
      where a.entity_id = $1::text
         or a.entity_id in (select id::text from uploads where event_id=$1::uuid)
         or a.entity_id in (select id::text from policies where event_id=$1::uuid)
         or a.entity_id in (select id::text from refund_plans where event_id=$1::uuid)
         or a.entity_id in (select pi.id::text from plan_items pi join refund_plans rp on rp.id=pi.plan_id where rp.event_id=$1::uuid)
         or a.entity_id in (select q.id::text from policy_questions q join policies p on p.id=q.policy_id where p.event_id=$1::uuid)
      order by a.at desc limit 300`,
    [id],
  );
  const auditRows: AuditRow[] = rows.map((r) => ({ at: new Date(r.at).toISOString(), actor: r.actor, action: r.action, entity: r.entity, entityId: String(r.entity_id), after: r.after ?? null }));
  return (
    <>
      <TopBar eventName={event.name} page="Audit log" />
      <PageHeader title="Audit log" subtitle="Every decision and money call, in order. Entries can be added but never edited or deleted. The database itself enforces that." />
      <AuditGrid rows={auditRows} licenseKey={process.env.AG_GRID_LICENSE_KEY} />
    </>
  );
}
