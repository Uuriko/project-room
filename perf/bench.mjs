#!/usr/bin/env node
// NEXT-7: Room speed bench. Fixed-seed, deterministic; measures the server write
// and read path, the room snapshot payload and the client search keystroke path
// over a seeded room. No production access, no secrets, disposable temp store.
//
//   node perf/bench.mjs                          # 2,000 messages, server + search phases
//   node perf/bench.mjs --messages 1000          # CI gate size
//   node perf/bench.mjs --json --out perf.json   # machine-readable summary
//   node perf/bench.mjs --write-baseline         # update perf/bench-baseline.json
//   node perf/bench.mjs --check                  # fail vs the committed baseline
//   node perf/bench.mjs --browser                # also run the browser phase (skipped if chromium is absent)
//
// Gate thresholds (NEXT-7): first-message +10%, own-send-to-visible +20%,
// JS bytes +5%, request count +5, snapshot KB +10%, post-ack p95 +25%,
// search keystroke p95 absolute < 100 ms. Baseline changes only in a PR that says why.
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { searchMessages } from "../src/conversation.js";
import { searchWork } from "../src/work-selectors.js";

const dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MESSAGES = 2000, GATE_MESSAGES = 1000;
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// Replica of src/app.js clipGraphemes (app.js is browser-coupled and cannot be imported here).
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const clipGraphemes = (text, maxUnits) => {
  const value = String(text ?? "");
  if (value.length <= maxUnits) return value;
  let taken = 0;
  for (const { segment } of graphemes.segment(value)) { if (taken + segment.length > maxUnits) break; taken += segment.length; }
  return value.slice(0, taken);
};
const pct = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };

function parseArgs(argv) {
  const out = { messages: DEFAULT_MESSAGES, json: false, out: null, check: false, writeBaseline: false, browser: false, seed: 0x5eed };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const need = () => { const v = argv[i + 1]; if (v === undefined) throw new Error(`${key} needs a value`); i += 1; return v; };
    if (key === "--messages") out.messages = Number(need());
    else if (key === "--json") out.json = true;
    else if (key === "--out") out.out = need();
    else if (key === "--check") out.check = true;
    else if (key === "--write-baseline") out.writeBaseline = true;
    else if (key === "--browser") out.browser = true;
    else if (key === "--seed") out.seed = Number(need());
    else if (key === "--help" || key === "-h") out.help = true;
    else throw new Error(`unknown argument ${key}`);
  }
  return out;
}

// Deterministic PRNG so every run seeds the same room.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WORDS = ["launch", "review", "deploy", "snapshot", "timeline", "agent", "fix", "query", "perf", "search", "room", "draft", "board", "claim", "stream", "message"];

function seedBodies(count, rand) {
  const bodies = [];
  for (let i = 0; i < count; i += 1) {
    const n = 8 + Math.floor(rand() * 20);
    const parts = [];
    for (let k = 0; k < n; k += 1) parts.push(WORDS[Math.floor(rand() * WORDS.length)]);
    bodies.push(`seed-${i} ${parts.join(" ")}`);
  }
  return bodies;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(new URL(import.meta.url).pathname + " --messages N [--json] [--out f] [--check] [--write-baseline] [--browser]"); return; }
  const directory = mkdtempSync(join(tmpdir(), "project-room-bench-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize([...initialRoom("commons", "owner")]);
  // Deterministic clock, spaced like the repo's own browser fixtures, so the
  // per-identity flood guard measures the write path, not the bench cadence.
  let clock = Date.now();
  store.now = () => clock;
  const server = createRoomServer({ store, streamInterval: 50 });
  const result = { config: { messages: args.messages, seed: args.seed }, seed: {}, server: {}, search: {}, browser: null };
  let origin = null;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const ownerKey = store.issueAccessKey("commons", "owner");
    const auth = { "content-type": "application/json", authorization: `Bearer ${ownerKey}` };
    const rand = mulberry32(args.seed);
    const bodies = seedBodies(args.messages, rand);
    // Seed write cost: the cost the room pays to build a 2,000-message history.
    // Posts go through the store's own command path (the HTTP flood guard is not
    // the thing under test; perf/local-baseline.js rotates identities the same way).
    const writeMs = [];
    const t0 = performance.now();
    for (let i = 0; i < args.messages; i += 1) {
      clock += 2100;
      const s = performance.now();
      const r = store.command(ownerKey, "commons", { id: `bench-seed-${i}`, type: "message.posted", data: { messageId: `bench-seed-${i}`, body: bodies[i] } });
      if (!r || r.error) throw new Error(`seed post ${i} -> ${JSON.stringify(r).slice(0, 200)}`);
      writeMs.push(performance.now() - s);
    }
    result.seed = { messages: args.messages, wallMs: Math.round(performance.now() - t0), writePerMessageP50: +pct(writeMs, 0.5).toFixed(2), writePerMessageP95: +pct(writeMs, 0.95).toFixed(2) };
    // Snapshot payload: what the client must download to hold the room.
    const full = await fetch(`${origin}/api/rooms/commons`, { headers: auth });
    const fullBody = await full.text();
    const recent = await fetch(`${origin}/api/rooms/commons?messages=recent`, { headers: auth });
    const recentBody = await recent.text();
    result.server.snapshotFullKB = +(Buffer.byteLength(fullBody) / 1024).toFixed(1);
    result.server.snapshotRecentKB = +(Buffer.byteLength(recentBody) / 1024).toFixed(1);
    const snapshot = JSON.parse(fullBody);
    // Post-ack latency: POST to visible-in-snapshot roundtrip.
    const acks = [];
    for (let i = 0; i < 40; i += 1) {
      clock += 2100;
      const id = `bench-ack-${i}`, s = performance.now();
      const r = await fetch(`${origin}/api/rooms/commons/commands`, { method: "POST", headers: auth,
        body: JSON.stringify({ id, type: "message.posted", data: { messageId: id, body: `ack probe ${i} ${WORDS[i % WORDS.length]}` } }) });
      if (r.status !== 200 && r.status !== 201) throw new Error(`ack post -> ${r.status}`);
      await r.text(); acks.push(performance.now() - s);
    }
    result.server.postAckP50 = +pct(acks, 0.5).toFixed(2);
    result.server.postAckP95 = +pct(acks, 0.95).toFixed(2);
    // Send-to-stream: post a message and time its arrival on the SSE stream.
    const streamBody = await (await fetch(`${origin}/api/rooms/commons/stream`, { headers: auth })).body.getReader();
    const arrival = (async () => {
      const decoder = new TextDecoder(); let buffer = "";
      for (;;) {
        const { value, done } = await streamBody.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("probe-arrival")) return performance.now();
      }
    })();
    const sendAt = performance.now();
    await fetch(`${origin}/api/rooms/commons/commands`, { method: "POST", headers: auth,
      body: JSON.stringify({ id: "bench-arrival", type: "message.posted", data: { messageId: "bench-arrival", body: "probe-arrival marker" } }) });
    const landed = await arrival;
    result.server.sendToStreamMs = landed === null ? null : +(landed - sendAt).toFixed(2);
    streamBody.cancel().catch(() => {});
    // Search keystroke path: the work one keystroke pays, recorded per query over
    // the held snapshot exactly as renderSearch does it (search + result HTML build).
    const state = snapshot.state;
    const members = state.members ?? {};
    const queries = ["review", "deploy snapshot", "agent fix", "board claim", "message", "stream", "zzz-no-match"];
    const coreMs = [], htmlMs = [], keyMs = [];
    for (const q of queries) {
      for (let rep = 0; rep < 6; rep += 1) {
        const s0 = performance.now();
        const parsed = { term: q, mentionsOnly: false };
        const res = searchMessages(state, q, 50, { viewer: members.owner ?? null, ...parsed });
        const s1 = performance.now();
        const html = res.messages.map((m) => `<li><a><strong>${esc(members[m.authorId]?.displayName || "")}</strong><span>${esc(m.deletedAt ? "Message deleted" : clipGraphemes(m.body ?? "", 240))}</span></a></li>`).join("");
        const s2 = performance.now();
        coreMs.push(s1 - s0); htmlMs.push(s2 - s1); keyMs.push(s2 - s0);
      }
    }
    result.search = { queriesRun: queries.length * 6, coreP50: +pct(coreMs, 0.5).toFixed(2), coreP95: +pct(coreMs, 0.95).toFixed(2), htmlP50: +pct(htmlMs, 0.5).toFixed(2), htmlP95: +pct(htmlMs, 0.95).toFixed(2), keystrokeP50: +pct(keyMs, 0.5).toFixed(2), keystrokeP95: +pct(keyMs, 0.95).toFixed(2) };
    // Optional browser phase: first message, own send to visible, page weight,
    // and true type-to-result with the input handler in the loop.
    if (args.browser) {
      result.browser = {};
      let browser = null;
      let dbgPage = null;
      try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        dbgPage = page;
        page.on("pageerror", (e) => console.error("[bench-pageerror]", String(e).slice(0, 200)));
        const started = performance.now();
        await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
        const bytes = [], requests = { count: 0 };
        page.on("response", (r) => { requests.count += 1; bytes.push(Number(r.headers()["content-length"] || 0)); });
        // Sign in through the session endpoint with the owner access key.
        await page.evaluate(async ({ origin, key }) => { await fetch(`${origin}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessKey: key }) }); }, { origin, key: ownerKey });
        // The entry point only probes for a session when a client-side hint
        // exists (QAU-006); a fresh browser has none, so seed the same hint a
        // returning user's browser carries before reloading.
        await page.evaluate(() => { try { localStorage.setItem("pr-last-room", "commons"); localStorage.setItem("pr-last-room-title", "commons"); localStorage.setItem("pr-had-account", "1"); } catch (e) {} });
        await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
        await page.locator('[data-message-record-id]').first().waitFor({ timeout: 15000 });
        result.browser.firstMessageMs = +(performance.now() - started).toFixed(0);
        const jsBytes = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".js") || e.name.includes(".js?")).reduce((a, e) => a + e.transferSize, 0));
        result.browser.jsKB = +(jsBytes / 1024).toFixed(1);
        result.browser.requestCount = requests.count;
        // Own send to visible: type into the composer, send, wait for own row.
        const sendStart = performance.now();
        await page.fill("#message-input", "bench own-send probe");
        await page.press("#message-input", "Enter");
        await page.locator('[data-message-record-id]', { hasText: "bench own-send probe" }).first().waitFor({ timeout: 10000 });
        result.browser.ownSendToVisibleMs = +(performance.now() - sendStart).toFixed(0);
        // Type-to-result: keystroke -> search results visible in #search-list.
        const keyLatencies = [];
        // The topbar search form ships hidden: open it through its own toggle,
        // then click the input so focus is stable before the keystroke loop
        // (a bare page.type raced the composer focus back and lost keystrokes).
        await page.evaluate(() => { const f = document.getElementById("search-form"); if (f?.hidden) document.getElementById("topbar-search-toggle")?.click(); });
        for (const term of ["review", "snapshot", "agent"]) {
          await page.click("#message-search");
          for (const ch of term) {
            // Watch the results list AND the count line: a keystroke whose
            // render outputs the same first page and count fires no mutation,
            // which must read as a fast render, not a 5s stall.
            await page.evaluate(() => { globalThis.__benchObserved = 0; new MutationObserver(() => { globalThis.__benchObserved = performance.now(); }).observe(document.getElementById("search-list"), { childList: true, subtree: true }); new MutationObserver(() => { globalThis.__benchObserved = performance.now(); }).observe(document.getElementById("search-count"), { childList: true, characterData: true, subtree: true }); });
            const t = performance.now();
            await page.type("#message-search", ch, { delay: 0 });
            // The app renders synchronously in the input handler, so by the
            // time type() returns the render is done. A keystroke whose
            // output is identical fires no mutation: record the type()
            // round-trip as the render bound, never a timeout stall.
            const roundTrip = +(performance.now() - t).toFixed(1);
            const observed = await page.evaluate(() => globalThis.__benchObserved > 0);
            keyLatencies.push(observed ? await page.evaluate((t0) => globalThis.__benchObserved - t0, t) : roundTrip);
          }
          await page.fill("#message-search", "");
        }
        result.browser.typeToResultP50 = +pct(keyLatencies, 0.5).toFixed(1);
        result.browser.typeToResultP95 = +pct(keyLatencies, 0.95).toFixed(1);
        await browser.close();
      } catch (error) {
        try {
          const dbg = await dbgPage.evaluate(() => ({ v: document.getElementById("message-search")?.value, kids: document.getElementById("search-list")?.childElementCount, active: document.activeElement?.id || document.activeElement?.tagName, formHidden: document.getElementById("search-form")?.hidden }));
          console.error("[bench-dbg]", JSON.stringify(dbg), "|", String(error.stack || error).split("\n").slice(0, 3).join(" / ").slice(0, 300));
        } catch { /* page gone */ }
        result.browser = { skipped: true, reason: String(error.message || error).slice(0, 200) };
      } finally {
        // A failure path that leaves the browser open keeps the Node process
        // alive forever (the phase never exits): close it on every path.
        if (browser) { try { await browser.close(); } catch { /* already gone */ } }
      }
    }
  } finally {
    server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  }
  const baselinePath = join(dir, "bench-baseline.json");
  if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
  if (args.writeBaseline) writeFileSync(baselinePath, JSON.stringify(result, null, 2) + "\n");
  if (args.check) {
    if (!existsSync(baselinePath)) { console.error("no baseline at perf/bench-baseline.json"); process.exitCode = 2; }
    else {
      const base = JSON.parse(readFileSync(baselinePath, "utf8"));
      const checks = [];
      const cmp = (label, got, want, factor) => checks.push({ label, got, baseline: want, factor, ok: got == null || want == null ? true : got <= want * factor });
      cmp("snapshotFullKB", result.server.snapshotFullKB, base.server?.snapshotFullKB, 1.10);
      cmp("postAckP95", result.server.postAckP95, base.server?.postAckP95, 1.25);
      if (result.browser && !result.browser.skipped && base.browser && !base.browser.skipped) {
        cmp("firstMessageMs", result.browser.firstMessageMs, base.browser.firstMessageMs, 1.10);
        cmp("ownSendToVisibleMs", result.browser.ownSendToVisibleMs, base.browser.ownSendToVisibleMs, 1.20);
        cmp("jsKB", result.browser.jsKB, base.browser.jsKB, 1.05);
        // The contract is +5 absolute, not multiplicative: a request-count
        // regression passes only when it adds at most 5 requests.
        checks.push({ label: "requestCount<=+5", got: result.browser.requestCount, baseline: base.browser.requestCount, ok: result.browser.requestCount == null || base.browser.requestCount == null ? true : result.browser.requestCount <= base.browser.requestCount + 5 });
        // The build prompt's absolute target: every keystroke answers in <100ms.
        if (result.browser.typeToResultP95 != null && base.browser.typeToResultP95 != null)
          checks.push({ label: "typeToResultP95<100ms", got: result.browser.typeToResultP95, ok: result.browser.typeToResultP95 < 100 });
      }
      // --browser --check means the browser phase MUST have run: a skipped
      // phase would silently gate nothing, so the check fails instead.
      if (args.browser && (!result.browser || result.browser.skipped)) {
        checks.push({ label: "browserPhaseRan", got: result.browser?.reason ?? "absent", ok: false });
      }
      const abs = { label: "searchKeystrokeP95<100ms", got: result.search.keystrokeP95, ok: result.search.keystrokeP95 != null && result.search.keystrokeP95 < 100 };
      checks.push(abs);
      for (const c of checks) if (c.ok === false) process.exitCode = 1;
      if (args.json) console.log(JSON.stringify({ result, checks }, null, 2));
      else for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.label}: got ${c.got}${c.baseline !== undefined ? ` baseline ${c.baseline}` : ""}`);
    }
  } else if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`seed ${result.seed.messages} msgs in ${result.seed.wallMs}ms (p50 ${result.seed.writePerMessageP50}ms/msg)`);
    console.log(`snapshot full ${result.server.snapshotFullKB}KB / recent ${result.server.snapshotRecentKB}KB`);
    console.log(`post ack p50 ${result.server.postAckP50}ms p95 ${result.server.postAckP95}ms; send->stream ${result.server.sendToStreamMs}ms`);
    console.log(`search keystroke p50 ${result.search.keystrokeP50}ms p95 ${result.search.keystrokeP95}ms (core p95 ${result.search.coreP95}ms, html p95 ${result.search.htmlP95}ms)`);
    if (result.browser) console.log(result.browser.skipped ? `browser phase skipped (${result.browser.reason})` : `first message ${result.browser.firstMessageMs}ms, own send ${result.browser.ownSendToVisibleMs}ms, js ${result.browser.jsKB}KB, reqs ${result.browser.requestCount}, type-to-result p50 ${result.browser.typeToResultP50}ms p95 ${result.browser.typeToResultP95}ms`);
  }
}
import { dirname } from "node:path";
main().catch((e) => { console.error(e); process.exitCode = 1; });
