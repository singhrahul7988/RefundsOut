import { pool } from "@/db/client";
import { getEvent } from "@/server/events";
import { TopBar, PageHeader, Card } from "@/ui/kit";

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
  return (
    <>
      <TopBar eventName={event.name} page="Audit log" />
      <PageHeader title="Audit log" subtitle="Every decision and money call, in order. Entries can be added but never edited or deleted. The database itself enforces that." />
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <thead><tr className="bg-[#F3F5F8] text-left text-xs text-[#3E4652]"><th className="px-4 py-2.5 font-semibold">When</th><th className="px-3 py-2.5 font-semibold">Who</th><th className="px-3 py-2.5 font-semibold">What</th><th className="px-4 py-2.5 font-semibold">Details</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-[#EEF0F3] align-top">
                <td className="whitespace-nowrap px-4 py-2 text-muted">{new Date(r.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                <td className="px-3 py-2">{r.actor}</td>
                <td className="mono px-3 py-2 text-[13px]">{r.action}</td>
                <td className="mono max-w-[520px] truncate px-4 py-2 text-xs text-muted" title={r.after ? JSON.stringify(r.after) : ""}>{r.after ? JSON.stringify(r.after) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
