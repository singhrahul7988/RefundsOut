// Drives a real headless Edge over the DevTools protocol to test the client-only paths:
//   - the Review grid renders rows, groups and the total row
//   - "Ask the grid" (AG Grid AI Toolkit schema -> Gemini -> api.setState) actually filters the grid
//   - the browser console has no errors from our code
// Usage: node scripts/qa-browser.mjs <review-page-url>
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
if (!url) { console.error("usage: node scripts/qa-browser.mjs <url>"); process.exit(2); }
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"];
const port = 9333;
const edge = spawn(EDGE[0], [`--remote-debugging-port=${port}`, "--headless=new", "--disable-gpu", "--window-size=1440,1400", `--user-data-dir=${mkdtempSync(join(tmpdir(), "ro-cdp-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => { cond ? passed++ : failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " · " + detail : ""}`); };

try {
  let targets = [];
  for (let i = 0; i < 40 && !targets.length; i++) { await sleep(500); try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map(); const consoleErrors = [];
  ws.onclose = (ev) => { for (const [, r] of pending) r({ closed: true, code: ev.code }); pending.clear(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 20000 });
    if (res.closed) throw new Error(`DevTools connection closed (code ${res.code})`);
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return res.result?.result?.value;
  };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url });
  // wait for the grid to have rows
  const ROWS = `[...document.querySelectorAll('.ag-body-viewport [role="row"]')]`;
  let rows = 0;
  for (let i = 0; i < 60 && rows === 0; i++) { await sleep(500); rows = (await evaluate(`${ROWS}.length`)) ?? 0; }
  const leaf = await evaluate(`${ROWS}.filter(r => !r.classList.contains('ag-row-group')).length`);
  ok("Review grid renders rows", rows > 0 && leaf > 0, `${rows} rows, ${leaf} buyer rows`);
  const groups = await evaluate(`document.querySelectorAll('.ag-row-group').length`);
  ok("rows are grouped by rule", groups > 0, `${groups} group rows`);
  const total = await evaluate(`[...document.querySelectorAll('.ag-root [role="row"]')].map(r => r.innerText.replace(/\\s+/g,' ').trim()).find(t => /^Total/.test(t)) ?? ''`);
  ok("grand total row is shown", /Total/.test(total), total.slice(0, 80));
  const pinned = await evaluate(`document.querySelectorAll('.ag-floating-top [role="row"]').length`);
  console.log(`      pinned decision rows: ${pinned}`);

  // Ask the grid
  const typed = await evaluate(`(() => { const el = document.getElementById('ask'); if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, 'only refunds over $100, biggest first');
    el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
  ok("typed a question into Ask the grid", typed === "only refunds over $100, biggest first");
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => /^\\s*Ask\\s*$/.test(b.textContent) || b.textContent.trim() === 'Ask'); b && b.click(); return !!b; })()`);
  let askDone = false;
  for (let i = 0; i < 90 && !askDone; i++) { await sleep(1000); askDone = await evaluate(`!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reset')`); }
  ok("Ask the grid completes (Reset button appears)", askDone);
  await sleep(1500);
  const after = await evaluate(`(() => { const cells = [...document.querySelectorAll('.ag-center-cols-container .ag-row:not(.ag-row-group) [col-id="refund"]')].map(c => Number(c.innerText.replace(/[^0-9.]/g,'')) ).filter(n => !isNaN(n) && n > 0); return { n: cells.length, min: Math.min(...cells), max: Math.max(...cells), first: cells[0], last: cells[cells.length-1] }; })()`);
  ok("grid now shows only refunds over $100", after.n > 0 && after.min > 100, JSON.stringify(after));
  ok("and sorts biggest first", after.n < 2 || after.first >= after.last, `first ${after.first}, last ${after.last}`);
  const err = await evaluate(`document.querySelector('[role="alert"]')?.innerText ?? ''`);
  ok("no error banner on the page", !err, err);

  const ours = consoleErrors.filter((e) => !/License|ag-grid.com|DevTools|Download the React DevTools|hydrat/i.test(e));
  ok("no console errors from our code", ours.length === 0, ours.slice(0, 3).join(" | ").slice(0, 300));
  ws.close();
} catch (e) {
  ok("browser test ran", false, e.message);
} finally {
  edge.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
