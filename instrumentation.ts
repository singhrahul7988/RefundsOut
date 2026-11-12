// Runs once when the server starts. Puts half-finished refunds back in the queue after a crash or deploy.
// Safe because every refund reuses its fixed PayPal-Request-Id, so PayPal returns the original instead of paying twice.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { resumeInterruptedRuns } = await import("./src/run/runner");
    const n = await resumeInterruptedRuns();
    if (n) console.log(`[refundsout] resumed ${n} interrupted run(s)`);
  } catch (err) {
    console.error("[refundsout] could not resume runs:", err);
  }
}
