#!/usr/bin/env node
// Synthetic agent journeys: a cold agent that only knows the origin.
// Each task follows what public discovery (llms.txt, agents.json, openapi.json,
// MCP tools/list) and the server's own `next` hints say, records whether the
// route it needed was discoverable, and scores pass/fail on the end state
// (outcome-based, like tau-bench: the state must change, not just a 2xx).
// Usage: node scripts/qa2/agent-journeys.mjs --origin http://127.0.0.1:4173 [--mcp URL] [--json out.json] [--md out.md] [--trials 1]
// Writes: one room named qa2-journey-* (archived at the end) and 2 identities (revoked at the end).
import { argv, exit } from "node:process";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const origin = arg("origin", "http://127.0.0.1:4173");
const mcpUrl = arg("mcp", `${origin}/mcp`);
const trials = Number(arg("trials", "1"));
const UA = "project-room-qa2-journeys/1";

let calls = 0, rateLimited = 0;
async function http(method, path, { token, body, accept = "application/json" } = {}) {
  calls++;
  const headers = { "user-agent": UA, accept };
  if (body !== undefined) { headers["content-type"] = "application/json"; headers.origin = origin; }
  if (token) headers.authorization = `Bearer ${token}`;
  const started = performance.now();
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch(path.startsWith("http") ? path : origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status !== 429) break;
    rateLimited++;
    const wait = Math.min(Number(r.headers.get("retry-after") || 30), 65) * 1000; // a well-behaved agent honours Retry-After
    await r.text(); await new Promise(res => setTimeout(res, wait));
  }
  let text = await r.text();
  if (/^(event|data):/.test(text.slice(0, 10))) text = text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("\n");
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers, ms: Math.round(performance.now() - started) };
}
const mcp = async (token, method, params) => http("POST", mcpUrl, { token, body: { jsonrpc: "2.0", id: randomUUID(), method, params }, accept: "application/json, text/event-stream" });
const toolResult = r => r.json?.result?.structuredContent ?? (() => { try { return JSON.parse(r.json?.result?.content?.[0]?.text); } catch { return null; } })();
const cmd = (type, data) => ({ id: randomUUID(), type, data });
const ok = r => r.status >= 200 && r.status < 300;

async function runTrial(trial) {
  const stamp = `${Date.now().toString(36)}${trial}`;
  const tasks = [];
  const S = {}; // state shared across tasks
  const recovery = join(tmpdir(), `qa2-journey-${stamp}.json`);
  const save = () => writeFileSync(recovery, JSON.stringify({ origin, room: S.room, ids: [S.a, S.b].filter(Boolean).map(x => ({ identityId: x.identityId, secret: x.secret })) }), { mode: 0o600 });
  async function task(id, title, fn) {
    const before = calls, t0 = performance.now();
    const rec = { id, title, pass: false, discoverable: null, notes: [] };
    try { await fn(rec); } catch (e) { rec.notes.push(`error: ${e.message}`); }
    rec.calls = calls - before; rec.ms = Math.round(performance.now() - t0);
    tasks.push(rec);
  }
  // corpus = everything a cold agent can read without credentials
  const corpus = {};
  await task("J1", "Discover the agent entry points from the origin", async rec => {
    const home = await http("GET", "/", { accept: "text/html" });
    const link = home.headers.get("link") || "";
    rec.notes.push(`Link header rel=help: ${/rel="help"/.test(link)}; <link rel=help> in HTML: ${/rel="help"[^>]*llms\.txt|llms\.txt[^>]*rel="help"/.test(home.text)}`);
    for (const p of ["/llms.txt", "/agents.json", "/openapi.json", "/.well-known/agent-card.json", "/.well-known/mcp.json"]) { const r = await http("GET", p, { accept: "*/*" }); corpus[p] = ok(r) ? r.text : ""; if (!ok(r)) rec.notes.push(`${p} -> ${r.status}`); }
    const tl = await mcp(null, "tools/list", {}); corpus.mcpAnon = tl.text;
    rec.pass = Boolean(corpus["/llms.txt"] && corpus["/openapi.json"] && /rel="help"/.test(link + home.text));
    rec.discoverable = true;
  });
  const documented = needle => Object.values(corpus).some(t => t.includes(needle));
  await task("J2", "Mint an identity", async rec => {
    rec.discoverable = documented("/api/agent-identities");
    const r = await http("POST", "/api/agent-identities", { body: { displayName: `qa2-journey-a-${stamp}` } });
    if (r.status === 428) rec.notes.push("428 proof_required (identity mint proof flow) - journey must solve the proof; see #1298");
    S.a = r.json; save();
    rec.pass = ok(r) && typeof r.json?.secret === "string";
  });
  await task("J3", "Create my own room", async rec => {
    rec.discoverable = documented("/api/agent-rooms");
    const r = await http("POST", "/api/agent-rooms", { token: S.a.secret, body: { title: `qa2-journey-${stamp}`, purpose: "QA2 synthetic agent journey; archived when done" } });
    S.room = r.json?.roomId; S.createNext = r.json?.next ?? []; save();
    rec.pass = ok(r) && Boolean(S.room);
  });
  const R = () => `/api/rooms/${encodeURIComponent(S.room)}`;
  await task("J4", "Post a message and read it back (HTTP)", async rec => {
    const hint = S.createNext.find(n => /post/.test(n.action));
    rec.discoverable = Boolean(hint) || documented("message.posted");
    const body = `journey hello ${stamp}`;
    const r = await http("POST", hint?.path ?? `${R()}/commands`, { token: S.a.secret, body: cmd("message.posted", { messageId: randomUUID(), body }) });
    const ev = await http("GET", `${R()}/events?limit=20`, { token: S.a.secret });
    rec.pass = ok(r) && ev.text.includes(body);
  });
  await task("J5", "Invite a second agent using the route the server suggests", async rec => {
    const hint = S.createNext.find(n => /invite/.test(n.action));
    rec.notes.push(`room-create next suggests ${hint?.method} ${hint?.path}`);
    S.b = (await http("POST", "/api/agent-identities", { body: { displayName: `qa2-journey-b-${stamp}` } })).json; save();
    let code = null;
    if (hint) { const r = await http(hint.method, hint.path, { token: S.a.secret, body: { profile: "collaborate" } }); code = r.json?.code ?? null; if (!code) rec.notes.push(`suggested route -> ${r.status} ${r.json?.error?.code ?? ""}: ${r.json?.error?.message ?? ""}`); }
    rec.discoverable = Boolean(code) || documented("/agent-invites\"") || documented("/agent-invites ");
    if (!code) { const r = await http("POST", `${R()}/agent-invites`, { token: S.a.secret, body: { profile: "collaborate" } }); code = r.json?.code; rec.notes.push(`fallback /agent-invites (needs source knowledge) -> ${r.status}`); rec.fallbackUsed = true; }
    const red = await http("POST", "/api/agent-invites/redeem", { token: S.b.secret, body: { code, displayName: `qa2-journey-b` } });
    rec.pass = ok(red) && !rec.fallbackUsed;
  });
  await task("J6", "Peer @mentions me and I find it via needs-me", async rec => {
    rec.discoverable = documented("needs-me");
    await http("POST", `${R()}/commands`, { token: S.b.secret, body: cmd("message.posted", { messageId: randomUUID(), body: `@qa2-journey-a-${stamp} please review` }) });
    const n = await http("GET", "/api/needs-me", { token: S.a.secret });
    rec.pass = ok(n) && (n.json?.items ?? []).some(i => i.kind === "mention" && i.roomId === S.room);
  });
  await task("J7", "Bond with the peer and send a private DM it can read", async rec => {
    rec.discoverable = documented("bond.propose") || documented("bond_propose");
    const p = await http("POST", `${R()}/commands`, { token: S.a.secret, body: cmd("bond.propose", { to: S.b.identityId }) });
    const bondId = p.json?.event?.data?.bondId;
    await http("POST", `${R()}/commands`, { token: S.b.secret, body: cmd("bond.accept", { bondId }) });
    const dmBody = `journey-dm-${stamp}`;
    await http("POST", `${R()}/commands`, { token: S.a.secret, body: cmd("dm.posted", { messageId: randomUUID(), to: S.b.identityId, body: dmBody }) });
    const n = await http("GET", "/api/needs-me", { token: S.b.secret });
    rec.pass = (n.json?.items ?? []).some(i => i.kind === "dm" && String(i.summary).includes(dmBody));
  });
  await task("J8", "Work-claim lifecycle: create, claim, progress, done", async rec => {
    const createDoc = documented("/work-claims\"") && /POST[^\n]{0,80}work-claims/.test(Object.values(corpus).join("\n"));
    const statesDoc = documented("in_progress");
    rec.discoverable = createDoc && statesDoc;
    rec.notes.push(`create documented: ${createDoc}; states documented: ${statesDoc}`);
    const id = `journey-${stamp}`;
    const c = await http("POST", `${R()}/work-claims`, { token: S.a.secret, body: { id, title: "journey task" } });
    const cl = await http("POST", `${R()}/work-claims/${id}/claim`, { token: S.b.secret, body: { note: "taking it", leaseHours: 1 } });
    const ip = await http("POST", `${R()}/work-claims/${id}/update`, { token: S.b.secret, body: { state: "in_progress" } });
    const done = await http("POST", `${R()}/work-claims/${id}/update`, { token: S.b.secret, body: { state: "done", note: "finished" } });
    rec.pass = ok(c) && ok(cl) && ok(ip) && ok(done) && done.json?.state === "done";
  });
  await task("J9", "Webhook: subscribe, see a delivery attempt, unsubscribe", async rec => {
    rec.discoverable = documented("/api/agent-webhooks");
    const s = await http("POST", "/api/agent-webhooks", { token: S.a.secret, body: { url: "https://example.com/qa2-journey", events: ["message.posted"] } });
    const sub = s.json?.subscriptionId;
    await http("POST", `${R()}/commands`, { token: S.b.secret, body: cmd("message.posted", { messageId: randomUUID(), body: "journey webhook trigger" }) });
    let seen = false;
    for (let i = 0; i < 6 && !seen; i++) { await new Promise(r => setTimeout(r, 2000)); const j = await http("GET", `/api/agent-webhooks/${sub}/deliveries`, { token: S.a.secret }); seen = (j.json?.deliveries ?? []).length > 0; }
    const d = await http("DELETE", `/api/agent-webhooks/${sub}`, { token: S.a.secret });
    rec.notes.push(`delivery journal populated: ${seen}`);
    rec.pass = ok(s) && ok(d) && seen;
  });
  await task("J10", "MCP: list tools, post with a tool, read it back with a tool", async rec => {
    const tl = await mcp(S.a.secret, "tools/list", {});
    const names = (tl.json?.result?.tools ?? []).map(t => t.name);
    rec.discoverable = names.includes("room_post_message") && names.includes("room_read_messages");
    const body = `journey mcp ${stamp}`;
    const p = await mcp(S.a.secret, "tools/call", { name: "room_post_message", arguments: { roomId: S.room, body } });
    const r = await mcp(S.a.secret, "tools/call", { name: "room_read_messages", arguments: { roomId: S.room, limit: 50 } });
    rec.pass = p.json?.result && !p.json.result.isError && JSON.stringify(toolResult(r) ?? {}).includes(body);
  });
  await task("J11", "Archive the room when finished", async rec => {
    rec.discoverable = documented("room.archived") || documented("room_archive");
    const r = await http("POST", `${R()}/commands`, { token: S.a.secret, body: cmd("room.archived", {}) });
    const ap = await http("GET", `${R()}/activation-pack`, { token: S.a.secret });
    rec.pass = ok(r) && ap.json?.room?.state === "archived";
    if (!rec.pass) rec.notes.push(`archive ${r.status}; activation-pack room.state=${ap.json?.room?.state}`);
  });
  await task("J12", "Revoke my identities; the old secret stops working", async rec => {
    rec.discoverable = documented("/revoke");
    let first = null;
    for (const who of [S.b, S.a]) { const r = await http("POST", `/api/agent-identities/${who.identityId}/revoke`, { token: who.secret, body: {} }); if (!first) first = r; if (r.status === 422) await http("POST", `/api/agent-identities/${who.identityId}/revoke`, { token: who.secret, body: { confirm: true } }); }
    rec.notes.push(`first revoke without confirm -> ${first.status} ${first.json?.error?.code ?? ""}`);
    const after = await http("GET", "/api/agent-rooms", { token: S.a.secret });
    rec.pass = after.status === 401;
    if (rec.pass) rmSync(recovery, { force: true });
  });
  return tasks;
}

const all = [];
for (let t = 0; t < trials; t++) all.push(await runTrial(t));
const ids = all[0].map(t => t.id);
const summary = ids.map(id => { const runs = all.map(r => r.find(t => t.id === id)); return { id, title: runs[0].title, passAt1: runs[0].pass, passHatK: runs.every(r => r.pass), discoverable: runs[0].discoverable, calls: runs[0].calls, ms: runs[0].ms, notes: runs[0].notes }; });
const passed = summary.filter(s => s.passAt1).length, coldOk = summary.filter(s => s.passAt1 && s.discoverable).length;
const lines = [`# Agent journeys against ${origin} (${new Date().toISOString()})`, "", `pass@1 ${passed}/${summary.length}; pass^${trials} ${summary.filter(s => s.passHatK).length}/${summary.length}; cold-discoverable and passed ${coldOk}/${summary.length}; 429 retries ${rateLimited}`, "", "| task | pass | discoverable | calls | ms | notes |", "| --- | --- | --- | --- | --- | --- |", ...summary.map(s => `| ${s.id} ${s.title} | ${s.passAt1 ? "yes" : "NO"} | ${s.discoverable ? "yes" : "NO"} | ${s.calls} | ${s.ms} | ${s.notes.join("; ").replace(/\|/g, "/")} |`)];
console.log(lines.join("\n"));
if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ origin, trials, summary, runs: all }, null, 2));
if (arg("md")) writeFileSync(arg("md"), lines.join("\n") + "\n");
exit(passed === summary.length ? 0 : 1);
