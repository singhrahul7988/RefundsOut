import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// For uptime pingers and the host's health check. Deliberately does NOT touch the database:
// pinging it every few minutes must not keep a scale-to-zero Postgres (e.g. Neon free) awake.
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
