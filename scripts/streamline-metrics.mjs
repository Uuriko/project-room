#!/usr/bin/env node
// Streamline metrics: repeatable numbers for the MVP "Streamline audit".
//   node scripts/streamline-metrics.mjs agent   MCP list sizes, context reads, wake latency
//   node scripts/streamline-metrics.mjs human   owner landing: requests, bytes, visible controls
// In-process Room on 127.0.0.1 only. Prints sizes and timings, never credentials.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

async function startLocal() {
  const { createAcceptanceFixture } = await import("./acceptance-fixture.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", ownerKey: f.store.issueAccessKey("commons", "owner"),
    close: async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); },
  };
}

async function agentMetrics({ origin, roomId, ownerKey }) {
  const { join } = await import("../room-acp/src/join.mjs");
  const { RoomClient } = await import("../room-acp/src/room.mjs");
  const api = async (path, body, key) => {
    const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", origin }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = {}; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, bytes: Buffer.byteLength(text) };
  };
  const room = `/api/rooms/${roomId}`, out = {};
  const name = "MetricsAgent";
  const minted = await api(`${room}/agent-invites`, { profile: "member", displayName: name }, ownerKey);
  const home = mkdtempSync(joinPath(tmpdir(), "streamline-"));
  const connection = await join({ link: `${origin}/join/${minted.json.code}`, displayName: name, env: { ...process.env, ROOM_ACP_HOME: home } });
  const key = connection.credential;
  for (const profile of ["core", "lean", "full"]) {
    const r = await api(`/mcp?profile=${profile}`, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { profile } }, key);
    const tools = r.json?.result?.tools ?? [];
    out[`tools_${profile}`] = { tools: tools.length, bytes: r.bytes, approxTokens: Math.round(r.bytes / 4), hasClaim: tools.some(t => t.name === "room_claim") };
  }
  for (const path of [room, `${room}/work-claims`, "/llms.txt", "/llms-full.txt"]) {
    const r = await api(path, null, key); out[`read ${path}`] = { status: r.status, bytes: r.bytes };
  }
  const client = new RoomClient({ apiBase: origin, roomId, memberId: connection.memberId, credential: key });
  const hostId = `metrics-${randomUUID().slice(0, 6)}`;
  await client.heartbeat({ hostId });
  const waiting = client.poll({ hostId, waitMs: 15000 }).then(value => [Date.now(), value]);
  await new Promise(resolve => setTimeout(resolve, 300));
  const sent = Date.now();
  await api(`${room}/commands`, { id: randomUUID(), type: "message.posted", data: { messageId: `m-${randomUUID()}`, body: `@${name} ping` } }, ownerKey);
  const [woke, value] = await waiting;
  out.wakeLatencyMs = woke - sent; out.wakeDelivered = (value?.pendingWakes ?? []).length > 0;
  rmSync(home, { recursive: true, force: true });
  return out;
}

async function humanMetrics({ origin, ownerKey }) {
  const { chromium } = await import("playwright");
  const { signInFixture } = await import("./auth-signin.mjs");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let bytes = 0, requests = 0;
    page.on("response", async response => { requests++; try { bytes += (await response.body()).length; } catch { /* redirects */ } });
    await page.goto(origin + "/"); await signInFixture(page, ownerKey, { returnTo: `${origin}/?room=commons` });
    bytes = 0; requests = 0; const start = Date.now();
    await page.reload(); await page.locator("#main:visible, #workspace-nav:visible").first().waitFor({ timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    const readyMs = Date.now() - start;
    const dom = await page.evaluate(() => {
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && globalThis.getComputedStyle(el).visibility !== "hidden"; };
      const controls = [...globalThis.document.querySelectorAll("button, a[href], [role=tab], summary, select, input")];
      return { visibleControls: controls.filter(visible).length, totalControls: controls.length, domNodes: globalThis.document.querySelectorAll("*").length };
    });
    return { readyMs, requests, bytes, ...dom };
  } finally { await browser.close(); }
}

const mode = process.argv[2] ?? "agent";
const target = await startLocal();
try {
  const result = mode === "human" ? await humanMetrics(target) : await agentMetrics(target);
  console.log(JSON.stringify({ mode, ...result }, null, 1));
} finally { await target.close(); }
process.exit(0);
