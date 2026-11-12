import { Pool, type PoolClient } from "pg";

// One pool per process. In Next.js dev, hot reload re-imports modules, so keep it on globalThis.
const globalForPg = globalThis as unknown as { __refundsoutPool?: Pool };

export const pool: Pool =
  globalForPg.__refundsoutPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    // Always UTC: event-local wall times are stored as UTC, so a local server timezone must never shift a scan to another day.
    options: "-c timezone=UTC",
    ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  });

if (process.env.NODE_ENV !== "production") globalForPg.__refundsoutPool = pool;

/** Run fn inside a single transaction. Rolls back on any thrown error. */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Append-only audit trail. */
export async function audit(
  db: Pick<PoolClient, "query">,
  entry: { actor: string; action: string; entity: string; entityId?: string; before?: unknown; after?: unknown },
): Promise<void> {
  await db.query(
    `insert into audit_log (actor, action, entity, entity_id, before, after) values ($1,$2,$3,$4,$5,$6)`,
    [
      entry.actor,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
