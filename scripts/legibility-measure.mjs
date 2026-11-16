#!/usr/bin/env node
// legibility-measure.mjs — Project Room agent-legibility instrument v1
//
// Measures the real token cost for an agent to become able to act in a
// Project Room instance: every discovery document the joining flow directs
// an arriving agent to read, plus the MCP surface (initialize instructions
// and the tools/list payload), itemised by component.
//
// Usage:
//   node legibility-measure.mjs [baseUrl] [--json <out.json>] [--bearer-env LEGIBILITY_BEARER]
//   LEGIBILITY_BEARER=<saved identity secret> node legibility-measure.mjs http://127.0.0.1:48765/
//
// Read-only by design: it issues GETs and MCP initialize / tools/list
// handshakes only. It never calls tools/call, never mints, never writes.
// With a bearer (an already-saved identity secret supplied by the operator)
// it additionally measures the authenticated tools/list profiles
// (core / lean / full) that the anonymous handshake cannot reach.
//
// TOKEN METHOD: no real tokenizer (tiktoken / gpt-tokenizer / js-tiktoken)
// is present in this environment (checked: repo node_modules + global
// require). Token figures are therefore ESTIMATES by the named estimator
//   estTokens = ceil(utf8Chars / 4)
// applied to the exact response text as received, and every component also
// reports raw bytes and character counts so all numbers are recomputable.
// If a tokenizer package becomes available, swap estimateTokens() only.
//
// CRAWL RULE (v1): start at GET / and follow only what the server itself
// directs an arriving agent to:
//   (a) Link-header / <link> targets on / with rel alternate|help|describedby;
//   (b) artefacts explicitly named as joining/discovery material in
//       /llms.txt or /llms-full.txt (short packet, full packet, agent card,
//       MCP server card, skills index, kits catalog, governance, OpenAPI
//       inventory, join prompt, agent skill doc);
//   (c) the targets of the MCP tools/list _meta.discovery block.
// One level only. Byte-identical aliases are fetched to verify equality and
// counted ONCE. Human HTML doors (/room, /download, /receipts pages),
// crawler surfaces (sitemap), external origins (GitHub docs), and
// identity/room-scoped API reads (activation pack) are excluded and listed
// in the output with the reason. Conditional documents (named only for a
// sub-flow, e.g. the resource-sharing setup skill) are measured but kept
// out of the primary total.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const baseArg = args.find(a => !a.startsWith("--")) || "http://127.0.0.1:48765/";
const jsonOut = (() => { const i = args.indexOf("--json"); return i >= 0 ? args[i + 1] : null; })();
const bearer = process.env.LEGIBILITY_BEARER || null;
const base = baseArg.replace(/\/+$/, "");
const UA = "project-room-agent legibility-measure/1.0";

const sha256 = buf => createHash("sha256").update(buf).digest("hex");
export const estimateTokens = text => Math.ceil([...text].length / 4); // chars/4 estimator, named in every output

async function fetchText(path, { method = "GET", body = null, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) { // VM has an intermittent storage fault: EPERM/IOERR are environmental, retry
    try {
      const res = await fetch(base + path, {
        method,
        headers: { "user-agent": UA, accept: "application/json, text/plain, */*", ...headers },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "follow",
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, bytes: buf.length, text: buf.toString("utf8"), hash: sha256(buf), headers: res.headers };
    } catch (err) {
      lastErr = err;
      if (!/EPERM|EIO|IOERR|SQLITE_IOERR/i.test(String(err?.cause?.code || err?.code || err))) break;
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

async function mcp(payload, { auth = false, query = "" } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth && bearer) headers.authorization = `Bearer ${bearer}`;
  return fetchText("/mcp" + query, { method: "POST", body: payload, headers });
}

const components = []; // {id,label,path,status,bytes,chars,estTokens,hash,counted,note}
function record(id, label, path, r, { counted = true, note = "" } = {}) {
  const chars = [...r.text].length;
  const c = { id, label, path, status: r.status, bytes: r.bytes, chars, estTokens: estimateTokens(r.text), sha256: r.hash.slice(0, 16), counted, note };
  components.push(c);
  return c;
}

const excluded = [];
function exclude(label, path, reason, extra = {}) { excluded.push({ label, path, reason, ...extra }); }

// ---- 0. Root: seed discovery from Link headers (HTML itself is a human door, not counted)
const root = await fetchText("/");
const linkTargets = [...String(root.headers.get("link") || "").matchAll(/<([^>]+)>/g)].map(m => m[1]);
exclude("Root HTML page", "/", "Human door; only its Link headers seed the crawl", { linkTargets });

// ---- 1. Directed discovery documents (canonical path; aliases verified, counted once)
const DOCS = [
  ["llms-short", "Short agent packet", "/llms.txt", {}],
  ["llms-full", "Full agent packet", "/llms-full.txt", {}],
  ["agent-card", "Agent card (A2A discovery card)", "/.well-known/agent-card.json", { aliases: ["/.well-known/agent.json", "/agent-card.json"] }],
  ["mcp-server-card", "MCP server card (embeds public + enrolled tool lists)", "/.well-known/mcp.json", { aliases: ["/room/mcp/server-card"] }],
  ["skills-index", "Skills index (Link rel=describedby from /)", "/skills", {}],
  ["agent-skills-index", "Agent-skills discovery index", "/.well-known/agent-skills/index.json", {}],
  ["agent-skill-doc", "Agent skill doc (work-in-project-room SKILL.md)", "/SKILL.md", { aliases: ["/.well-known/agent-skills/work-in-project-room/SKILL.md"] }],
  ["join-prompt", "Join prompt (same bytes room_join_prompt returns)", "/join.txt", {}],
  ["kits", "Kits catalog (room_join_kits returns this)", "/kits.txt", {}],
  ["governance", "Governance policy (named in llms.txt + tools/list _meta.discovery)", "/.well-known/governance.json", {}],
  ["openapi", "OpenAPI inventory of the curated machine surface", "/openapi.json", {}],
];
const docBodies = {};
for (const [id, label, path, opts] of DOCS) {
  const r = await fetchText(path);
  docBodies[id] = r.text;
  let note = "";
  for (const alias of opts.aliases || []) {
    const a = await fetchText(alias);
    note += ` alias ${alias}: ${a.status}, ${a.bytes} B, identical=${a.hash === r.hash};`;
  }
  if (path === "/llms.txt") { const roomAlias = await fetchText("/room/llms.txt"); note += ` alias /room/llms.txt: identical=${roomAlias.hash === r.hash};`; }
  record(id, label, path, r, { note: note.trim() });
}
// Conditional: only directed at agents asked to share resources / verify a second computer.
{
  const r = await fetchText("/skills/project-room-setup/SKILL.md");
  record("setup-skill", "Setup skill doc (CONDITIONAL: resource-sharing sub-flow only)", "/skills/project-room-setup/SKILL.md", r,
    { counted: false, note: "llms-full.txt directs only agents asked to share resources or verify peer execution to read this; excluded from the primary total." });
}
// Referenced but not served by this instance: recorded, not counted.
for (const p of ["/docs/agents", "/docs/agents/paste"]) {
  const r = await fetchText(p);
  exclude("Connection guide (referenced in llms.txt)", p, `Referenced by llms.txt but this instance answers ${r.status}; not counted`, { status: r.status, bytes: r.bytes });
}
exclude("AGENT-START-HERE.md (GitHub)", "https://github.com/Uuriko/project-room/blob/main/docs/AGENT-START-HERE.md",
  "External origin, not served by the instance; measure from a local checkout separately if needed");

// ---- 2. MCP surface (anonymous handshake: initialize + tools/list)
const init = await mcp({ jsonrpc: "2.0", id: "leg-init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legibility-measure", version: "1.0" } } });
let instructions = "";
try { instructions = JSON.parse(init.text)?.result?.instructions || ""; } catch { /* recorded below */ }
record("mcp-instructions", "MCP initialize: server instructions string", "POST /mcp initialize → result.instructions",
  { status: init.status, bytes: Buffer.byteLength(instructions), text: instructions, hash: sha256(Buffer.from(instructions)) },
  { note: `Full initialize response was ${init.bytes} B; only the instructions string an agent must ingest is counted here.` });

async function toolsList(id, label, pathLabel, opts, counted = true, note = "") {
  const r = await mcp({ jsonrpc: "2.0", id: "leg-list", method: "tools/list", params: opts.params || {} }, opts);
  let tools = [];
  try { tools = JSON.parse(r.text)?.result?.tools || []; } catch { /* keep empty */ }
  const toolsBytes = Buffer.byteLength(JSON.stringify(tools));
  const c = record(id, label, pathLabel, r, { counted, note });
  c.toolCount = tools.length;
  c.toolsArrayBytes = toolsBytes;
  c.toolsArrayEstTokens = estimateTokens(JSON.stringify(tools));
  c.perTool = tools.map(t => {
    const s = JSON.stringify(t);
    return { name: t.name, bytes: Buffer.byteLength(s), estTokens: estimateTokens(s), descriptionChars: [...(t.description || "")].length, schemaBytes: Buffer.byteLength(JSON.stringify(t.inputSchema || {})) };
  }).sort((a, b) => b.bytes - a.bytes);
  return c;
}

const anonList = await toolsList("mcp-tools-anon", "MCP tools/list — anonymous default (what a new agent's host ingests)", "POST /mcp tools/list (no auth)", {});
await toolsList("mcp-tools-anon-fullreq", "MCP tools/list — profile=full requested anonymously", "POST /mcp?profile=full tools/list (no auth)", { query: "?profile=full" },
  false, "Finding probe, not counted: the anonymous handler ignores the profile selector and returns the same discovery list; the full catalog requires a saved identity.");

// Server-card embedded catalogs: the card is already counted as a document;
// these extractions rank its enrolled (core-profile member) list at no
// extra fetch cost.
let cardCatalogs = null;
try {
  const card = JSON.parse(docBodies["mcp-server-card"]);
  const rank = list => (list || []).map(t => { const s = JSON.stringify(t); return { name: t.name, bytes: Buffer.byteLength(s), estTokens: estimateTokens(s) }; }).sort((a, b) => b.bytes - a.bytes);
  cardCatalogs = {
    public: { count: card.tools?.public?.length || 0, bytes: Buffer.byteLength(JSON.stringify(card.tools?.public || [])), perTool: rank(card.tools?.public) },
    enrolledCore: { count: card.tools?.enrolled?.length || 0, bytes: Buffer.byteLength(JSON.stringify(card.tools?.enrolled || [])), perTool: rank(card.tools?.enrolled) },
  };
  cardCatalogs.enrolledCore.estTokens = estimateTokens(JSON.stringify(card.tools?.enrolled || []));
  cardCatalogs.public.estTokens = estimateTokens(JSON.stringify(card.tools?.public || []));
} catch { /* card unparsable: noted in JSON */ }

// ---- 3. Authenticated profiles (only when the operator supplies a saved identity)
const authProfiles = {};
if (bearer) {
  for (const profile of ["core", "lean", "full"]) {
    const c = await toolsList(`mcp-tools-auth-${profile}`, `MCP tools/list — authenticated profile=${profile}`, `POST /mcp tools/list {profile:"${profile}"} + Bearer`, { auth: true, params: { profile } }, false, "Authenticated scenario; not part of the anonymous primary total.");
    authProfiles[profile] = { toolCount: c.toolCount, responseBytes: c.bytes, responseEstTokens: c.estTokens, toolsArrayBytes: c.toolsArrayBytes, toolsArrayEstTokens: c.toolsArrayEstTokens, perTool: c.perTool };
  }
} else {
  exclude("Authenticated MCP profiles (core/lean/full)", "POST /mcp tools/list + Bearer",
    "Not measured live: no bearer supplied and this instrument never mints one (read-only). Supply LEGIBILITY_BEARER with an already-saved identity secret to measure them.");
}

// ---- Totals & report
const counted = components.filter(c => c.counted);
const totalBytes = counted.reduce((s, c) => s + c.bytes, 0);
const totalTokens = counted.reduce((s, c) => s + c.estTokens, 0);
for (const c of counted) c.sharePct = +(100 * c.estTokens / totalTokens).toFixed(1);

const fmt = n => n.toLocaleString("en-US");
console.log(`\nLegibility baseline — ${base}`);
console.log(`Token method: ESTIMATE, estTokens = ceil(chars/4) on the exact response text (no tiktoken/gpt-tokenizer present in this environment). Bytes are exact wire bytes.\n`);
console.log(`${"component".padEnd(58)} ${"bytes".padStart(9)} ${"est.tokens".padStart(11)} ${"share".padStart(6)}`);
for (const c of components) {
  console.log(`${(c.counted ? "" : "(cond) ") + c.label.slice(0, 56).padEnd(58)} ${fmt(c.bytes).padStart(9)} ${fmt(c.estTokens).padStart(11)} ${(c.counted ? c.sharePct + "%" : "—").padStart(6)}  [${c.status}]${c.toolCount ? ` tools=${c.toolCount}` : ""}`);
}
console.log(`${"PRIMARY TOTAL (directed crawl, aliases counted once)".padEnd(58)} ${fmt(totalBytes).padStart(9)} ${fmt(totalTokens).padStart(11)}`);
console.log(`\nAnonymous MCP arrival alone (instructions + tools/list): ${fmt(components.find(c => c.id === "mcp-instructions").estTokens + anonList.estTokens)} est. tokens, ${anonList.toolCount} tools.`);
if (cardCatalogs) console.log(`Enrolled/core catalog embedded in the server card: ${cardCatalogs.enrolledCore.count} tools, ${fmt(cardCatalogs.enrolledCore.bytes)} B, ~${fmt(cardCatalogs.enrolledCore.estTokens)} est. tokens (tools array only).`);
for (const [p, v] of Object.entries(authProfiles)) console.log(`Authenticated profile=${p}: ${v.toolCount} tools, tools array ${fmt(v.toolsArrayBytes)} B, ~${fmt(v.toolsArrayEstTokens)} est. tokens.`);

const out = {
  instrument: "legibility-measure.mjs v1",
  base, measuredAt: new Date().toISOString(),
  tokenMethod: { kind: "estimate", formula: "ceil(utf8Chars/4)", tokenizer: null, note: "No tiktoken/gpt-tokenizer/js-tiktoken found in repo node_modules or globally; bytes and chars are exact and every figure is recomputable." },
  crawlRule: "One level from GET / Link headers + artefacts named as joining/discovery material in llms.txt/llms-full.txt + tools/list _meta.discovery targets; byte-identical aliases verified and counted once; human HTML doors, sitemap, external origins and identity-scoped API reads excluded with reasons.",
  components, excluded, cardCatalogs, authProfiles: Object.keys(authProfiles).length ? authProfiles : null,
  totals: { primaryBytes: totalBytes, primaryEstTokens: totalTokens },
};
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(out, null, 2) + "\n"); console.log(`\nJSON written to ${jsonOut}`); }
