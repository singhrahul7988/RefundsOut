// Applies db/schema.sql. Idempotent, so it is safe to run on every deploy.
// Run: npm run db:migrate
import { readFile } from "node:fs/promises";
import { pool } from "../src/db/client";

const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
await pool.query(sql);
const { rows } = await pool.query(
  `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
);
console.log(`Schema applied. Tables: ${rows.map((r) => r.table_name).join(", ")}`);
await pool.end();
