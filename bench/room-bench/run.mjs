#!/usr/bin/env node
// Room-Bench: run real Room agent tasks through the hosted MCP connector under
// three tool profiles (full, core, lean) and score success, steps, tokens and
// wrong-tool calls. Scripted mode (default) replays a known-good tool path, so it
// measures what the catalog costs and whether the path exists in each profile.
// --llm mode drives an OpenAI-compatible model when BENCH_LLM_URL/BENCH_LLM_KEY are set.
// Auth: ROOM_ORIGIN + ROOM_TOKEN env, or ROOM_CONNECTION=<connection.json>. Never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { LEAN, SEARCH_TOOL } from "./profiles.mjs";
import { TASKS } from "./tasks.mjs";

const conn = process.env.ROOM_CONNECTION ? JSON.parse(readFileSync(process.env.ROOM_CONNECTION, "utf8")) : {};
const ORIGIN = process.env.ROOM_ORIGIN || conn.origin || "http://127.0.0.1:8787";
const TOKEN = process.env.ROOM_TOKEN || conn.token;
if (!TOKEN) { console.error("set ROOM_TOKEN or ROOM_CONNECTION"); process.exit(2); }
const FILLER = Number(process.env.BENCH_FILLER || 205);
const scrub = (t) => t.split(TOKEN).join("<token>").replace(/rak_[A-Za-z0-9_-]{8,}/g, "rak_<redacted>");
const tok = (bytes) => Math.ceil(bytes / 4); // rough chars-per-token estimate

async function rpc(method, params, query = "?profile=full") {
  const r = await fetch(ORIGIN + "/mcp" + query, { method: "POST",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = scrub(await r.text());
  let j; try { j = JSON.parse(text); } catch { j = { error: { message: text.slice(0, 200) } }; }
  return { j, bytes: text.length };
}
async function call(name, args) {
  const { j, bytes } = await rpc("tools/call", { name, arguments: args });
  const res = j.result; let out = res?.structuredContent;
  if (!out && res?.content?.[0]?.text) { try { out = JSON.parse(res.content[0].text); } catch { out = res.content[0].text; } }
  const err = !!(j.error || res?.isError || out?.status >= 400);
  return { out: out ?? j.error, err, bytes };
}
async function listing(query) { const { j, bytes } = await rpc("tools/list", {}, query); return { tools: j.result.tools, bytes }; }
async function post(room, body) {
  for (let tries = 0; ; tries++) {
    const r = await fetch(`${ORIGIN}/api/rooms/${room}/commands`, { method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), type: "message.posted", data: { messageId: crypto.randomUUID(), body } }) });
    if (r.ok) return;
    const wait = Number(r.headers.get("retry-after") || 5);
    if (r.status !== 429 || tries > 20 || wait > 120) throw new Error(`seed post ${r.status} retry-after=${wait}`);
    await new Promise((ok) => setTimeout(ok, wait * 1000 + 250));
  }
}

let seeded = false;
const NEEDLE = "NEEDLE-" + Date.now().toString(36);
async function setup(tag) {
  // BENCH_ROOM reuses one scratch room you own (room creation is rate limited);
  // each profile still gets its own work item.
  const w = `bench-readme-${tag}-${Date.now().toString(36)}`;
  let room = process.env.BENCH_ROOM, me;
  if (room) {
    me = (await call("room_list_work", { roomId: room })).out?.member?.id;
    if (seeded) return { room, me, w };
  } else {
    room = `bench-${tag}-${Date.now().toString(36)}-delete-me`;
    const c = await call("room_create", { title: `Room-Bench ${tag} (delete me)`, purpose: "Room-Bench scratch room", roomId: room, requestId: crypto.randomUUID() });
    if (c.err) throw new Error("room_create failed: " + JSON.stringify(c.out).slice(0, 300));
    me = c.out.ownerMemberId;
  }
  await post(room, `${NEEDLE}: the deploy key rotates on Fridays`);
  for (let i = 0; i < FILLER; i++) await post(room, `filler ${i}`);
  await post(room, "QUESTION: what is six times seven?");
  if (process.env.BENCH_ROOM) seeded = true;
  return { room, me, w };
}

async function runProfile(name, list) {
  const listed = new Set(list.tools.map((t) => t.name));
  if (name === "lean") listed.add(SEARCH_TOOL);
  const schemaOf = Object.fromEntries((await listing("?profile=full")).tools.map((t) => [t.name, JSON.stringify(t).length]));
  const s = await setup(name);
  const rows = [];
  for (const task of TASKS) {
    const steps = (task.alt?.[name]) || task.steps;
    let n = 0, bytes = 0, wrong = 0, results = [], blocked = null;
    for (const st of steps) {
      if (!listed.has(st.tool)) {
        if (name !== "lean") { blocked = st.tool; break; }
        n++; bytes += schemaOf[st.tool] || 0; // one search_actions round trip returns the schema
      }
      let after = 0, found = false;
      for (let page = 0; page < (st.page ? 10 : 1); page++) {
        const r = await call(st.tool, st.args(s, after)); n++; bytes += r.bytes;
        const ok = st.expectError ? r.err : (!r.err && (st.ok ? st.ok(r.out) : true));
        if (r.err && !st.expectError) { wrong++; if (process.env.BENCH_DEBUG) console.error(st.tool, JSON.stringify(r.out).slice(0, 400)); }
        if (st.save && !r.err) st.save(s, r.out);
        if (st.page) {
          const msgs = r.out?.messages || [];
          found = JSON.stringify(msgs).includes(NEEDLE);
          if (found || !msgs.length) { results.push({ ok, err: r.err, found }); break; }
          after = r.out?.next ?? Math.max(...msgs.map((m) => m.sequence ?? 0));
          continue;
        }
        results.push({ ok, err: r.err });
      }
    }
    const pass = !blocked && !!task.check(s, results);
    const contextTokens = n * tok(list.bytes) + tok(bytes);
    rows.push({ task: task.id, pass, steps: n, wrong, blocked, responseTokens: tok(bytes), contextTokens });
    console.log(name, task.id, pass ? "PASS" : "FAIL", `steps=${n} wrong=${wrong}`, blocked ? `blocked:${blocked}` : "");
  }
  return { profile: name, tools: listed.size, listTokens: tok(list.bytes), room: s.room, rows };
}

const full = await listing("?profile=full");
const core = await listing("");
const lean = { tools: full.tools.filter((t) => LEAN.includes(t.name)), bytes: 0 };
lean.tools.push({ name: SEARCH_TOOL, description: "Find any other Room action by intent; returns its name and schema.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } });
lean.bytes = JSON.stringify(lean.tools).length;
const only = process.env.BENCH_PROFILES?.split(",") || ["full", "core", "lean"];
const out = [];
for (const [n, l] of [["full", full], ["core", core], ["lean", lean]]) if (only.includes(n)) out.push(await runProfile(n, l));
const summary = out.map((p) => ({ profile: p.profile, tools: p.tools, listTokens: p.listTokens, passed: p.rows.filter((r) => r.pass).length, of: p.rows.length,
  steps: p.rows.reduce((a, r) => a + r.steps, 0), wrong: p.rows.reduce((a, r) => a + r.wrong, 0), contextTokens: p.rows.reduce((a, r) => a + r.contextTokens, 0) }));
console.table(summary);
writeFileSync(process.env.BENCH_OUT || "room-bench-result.json", JSON.stringify({ mode: "scripted", origin: ORIGIN, at: new Date().toISOString(), summary, profiles: out }, null, 1));
