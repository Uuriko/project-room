// Linear parity acceptance probes. Each of the 36 capabilities on the Linear
// parity plan gets one executable probe that returns "parity", "partial" or
// "missing" with evidence. Probes are behavioral (REST/MCP against a running
// server) where the capability has an API; otherwise they check the shipped
// module or route. Unknown request fields are refused with 422 by the Board
// API, so "field accepted" is a measurable signal for missing fields.
import { existsSync } from "node:fs";
import { join } from "node:path";

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export function makeClient(origin, secret) {
  let n = 0;
  const H = { "Content-Type": "application/json", "User-Agent": "project-room-agent parity", ...(secret ? { Authorization: "Bearer " + secret } : {}) };
  const rest = async (path, body, method) => {
    const r = await fetch(origin + path, { method: method || (body === undefined ? "GET" : "POST"), headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const rpc = async (method, params) => {
    const r = await fetch(origin + "/mcp", { method: "POST", headers: { ...H, Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
    const t = await r.text(); try { return JSON.parse(t); } catch { const m = t.match(/data: (.*)/); return m ? JSON.parse(m[1]) : { status: r.status }; }
  };
  return { rest, rpc };
}

async function timed(fn, n = 20) { const xs = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t); } return { p50: +pct(xs, 0.5).toFixed(1), p95: +pct(xs, 0.95).toFixed(1) }; }

export async function runProbes({ origin, secret, mcpSecret, roomId, repo }) {
  const c = makeClient(origin, secret);
  const m = makeClient(origin, mcpSecret || secret);
  const has = (...files) => files.some((f) => existsSync(join(repo, f)));
  const W = `/api/rooms/${roomId}/work-claims`;
  const uid = () => "lp-" + Math.random().toString(36).slice(2, 10);
  const accepts = async (extra) => { const id = uid(); const r = await c.rest(W, { id, title: "parity probe " + id, note: "n", ...extra }); return { ok: r.status === 201 || r.status === 200, status: r.status, id }; };
  const tools = ((await m.rpc("tools/list", { profile: "full" })).result?.tools || []).map((t) => t.name);
  const tool = (name) => tools.includes(name);
  const R = [];
  const add = (cap, status, evidence, kind = "api") => R.push({ cap, status, evidence, kind });

  const base = await accepts({ tags: ["bug"] });
  const item = base.ok ? (await c.rest(`${W}/${base.id}`)).body : null;
  add("Issues / tasks", base.ok && item ? "parity" : "missing", `POST work-claims ${base.status}`);
  const st = await c.rest(`${W}/${base.id}/update`, { state: "in_progress" });
  const custom = await c.rest(`${W}/${base.id}/update`, { state: "in_review_custom" });
  add("Workflow states", custom.status < 300 ? "parity" : st.status < 500 ? "partial" : "missing", `fixed states; custom state ${custom.status}`);
  const del = await accepts({ delegate: "x" });
  add("Assign + agent delegate", del.ok ? "parity" : "partial", `assignee only; delegate field ${del.status}`);
  const sess = JSON.stringify(item || {}).includes("agentSession");
  add("Agent session states", sess ? "parity" : "missing", `agentSession on claim read: ${sess}`);
  add("Ack / stale timers", has("server/ack-deadline.mjs", "server/claim-ack.mjs") ? "parity" : "partial", "lease only unless ack-deadline module ships", "code");
  add("Agent instructions", has("server/decision-log.mjs") ? "parity" : "partial", "room-guide/required-reading; decision log module", "code");
  add("Mentions / notifications", tool("room_needs_me") && has("server/notifications.mjs", "server/human-push.mjs") ? "parity" : "partial", "room_needs_me + notifications + push");
  add("Wake on mention/assign", has("server/wake-adapter.mjs", "server/agent-wake.mjs") ? "parity" : "partial", "wake adapter module", "code");
  const cyc = await accepts({ cycleId: "c1" });
  add("Cycles", cyc.ok ? "parity" : "missing", `cycleId field ${cyc.status}`);
  const ms = await accepts({ milestone: "m1" });
  add("Projects / milestones", ms.ok ? "parity" : has("server/project-map.mjs") ? "partial" : "missing", `parentClaimId/project-map; milestone ${ms.status}`);
  add("Triage", has("server/board-triage.mjs") ? "parity" : has("server/inbox-triage.mjs") ? "partial" : "missing", "inbox-triage only", "code");
  const due = await accepts({ dueAt: "2030-01-01T00:00:00Z" });
  add("SLAs", due.ok ? "parity" : has("server/sla-clocks.mjs") ? "partial" : "missing", `dueAt on task ${due.status}`);
  add("Labels", base.ok ? "parity" : "missing", "tags accepted on create");
  const pri = await accepts({ priority: 2 });
  add("Priority", pri.ok ? "parity" : "missing", `priority field ${pri.status}`);
  const est = await accepts({ estimate: 3 });
  add("Estimates", est.ok ? "parity" : "missing", `estimate field ${est.status}`);
  const sv = await c.rest(`${W}?view=saved-probe`);
  add("Search / filters / views", tool("room_list_work") ? (sv.status === 200 && sv.body?.view ? "parity" : "partial") : "missing", `room_list_work query; saved view ${sv.status}`);
  add("Keyboard / palette", has("src/command-palette.mjs") ? "parity" : has("src/board-keyboard.mjs") ? "partial" : "missing", "board-keyboard only; no command-palette module", "code");
  const lat = await timed(() => c.rest(W));
  const mlat = await timed(() => m.rpc("tools/list", {}));
  add("Speed / sync", lat.p50 < 100 && mlat.p50 < 100 ? "partial" : "missing", `board read p50 ${lat.p50} ms p95 ${lat.p95}; tools/list p50 ${mlat.p50} ms (target <100; no local-first sync)`, "speed");
  const oa = await c.rest("/openapi.json");
  add("API", oa.status === 200 && tools.length > 0 ? "parity" : "partial", `openapi ${oa.status}; ${tools.length} MCP tools`);
  add("Outbound webhooks", has("server/outbound-webhooks.mjs") ? "parity" : "missing", "outbound-webhooks", "code");
  add("Inbound event to task", has("server/inbound-hooks.mjs", "server/inbound-task-hooks.mjs") ? "parity" : "missing", "signed inbound hook module", "code");
  add("Hosted MCP", tools.length > 0 ? "parity" : "missing", `tools/list ${tools.length}`);
  add("GitHub", has("server/claim-pr-sync.mjs") ? "parity" : "partial", "claim-pr-sync", "code");
  add("Slack", has("server/slack-inbound.mjs") ? "parity" : "partial", "outbound adapter only", "code");
  add("Figma / Sentry", has("server/sentry.mjs", "server/figma.mjs") ? "parity" : "missing", "none", "code");
  add("Automations / Loops", has("server/automations.mjs") ? "parity" : "missing", "no user rules module", "code");
  add("Mobile", has("public/manifest.webmanifest", "public/manifest.json", "manifest.webmanifest") ? "partial" : "missing", "PWA + web push", "code");
  add("Inbox", tool("room_needs_me") ? "parity" : "missing", "room_needs_me");
  add("Docs", has("server/room-docs.mjs") ? "parity" : "missing", "pins/decisions only", "code");
  add("Insights", has("server/board-insights.mjs") ? "parity" : "partial", "sla-dashboard; no Board throughput", "code");
  add("Permissions", has("server/owner-delegates.mjs") ? "parity" : "partial", "grants, scoped keys, roles", "code");
  add("SSO / SAML", has("server/saml.mjs") ? "parity" : "missing", "OAuth + passkeys only", "code");
  add("Audit log", has("server/agent-audit.mjs") ? "parity" : "missing", "agent-audit", "code");
  add("Import", has("server/github-issue-import.mjs", "server/jira-import.mjs") ? "parity" : "missing", "email/channel import only", "code");
  add("Linear sync", has("server/linear-sync.mjs") ? "parity" : "missing", "none", "code");
  add("Asks / Pulse", has("server/asks.mjs") ? "parity" : "partial", "intake + room-digest", "code");
  const score = { parity: R.filter((r) => r.status === "parity").length, partial: R.filter((r) => r.status === "partial").length, missing: R.filter((r) => r.status === "missing").length };
  return { rows: R, score, points: score.parity + score.partial / 2, speed: { boardRead: lat, toolsList: mlat } };
}
