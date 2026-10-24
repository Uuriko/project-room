// Drift guard for skills/project-room/references/errors-catalog.md.
// PT-02 (ERRCAT-GUARD) rewrite. Base: main after DOCS-SPEC-FIX-1 (#4720)
// merged (its 17 rows, assistant_denied fix and ghost deletions are in the
// catalogue this guard reads). Landing order: #4720 (merged) -> PT-14's
// #4772 (28 delta rows) -> this guard; the pending exceptions below burn
// down as #4739 and #4772 land.
//
// The old guard passed 11/11 while 47 wire-visible codes were missing from
// the catalogue (audit d6 + PROOF lane 39 census). It was structurally blind:
// it walked server/ only (never cloudflare/), extracted only literal codes at
// fail()/reject()/ServiceError/AgentPluginError call sites plus a
// hand-maintained variable list, could not see custom throw helpers
// (railFail, envelopeFail, file-local check() wrappers) or codes passed
// through result objects into reject(...), and its patterns excluded
// hyphens (even the catalogued bond-missing was invisible to it).
//
// This rewrite COMPUTES the inventory from source. Emitter shapes covered:
//   1. fail()/reject() literals, status-first and code-first, and
//      new ServiceError()/new AgentPluginError() — hyphen-inclusive.
//   2. railFail(status, code) and envelopeFail(status, code) — the record-
//      rails and handoff-journal throw helpers (chartered names).
//   3. File-local check()-family wrappers (check, envelopeCheck) whose body
//      forwards a `code` parameter into one of the emitters above, when the
//      status is statically known (a numeric literal in the forwarding call,
//      or a status argument at the call site). Status-less helper throws are
//      NOT counted: the central catch renames a status-less error's code to
//      internal_error, so those codes never reach error.code on the wire
//      (d6 Scope 3). This is the rule that keeps validation vocabularies of
//      unrouted stores (FeedbackError & friends) out of the inventory.
//   4. Result objects that reach reject(...) passthroughs: object literals
//      with a numeric status/httpStatus adjacent to a code literal
//      (legal-store terms_changed, proof-page invalid_proof_query), nested
//      error: { code } bodies, and agentErrorBody()/workerErrorBody()
//      bodies (cloudflare room_unavailable).
//   5. Identifier-passed codes resolved from source, never a hand list:
//      file-local consts whose name mentions code (incl. plain CODE), and
//      src/ *_CODE constants imported or referenced by the emitting file
//      (TRUST_OFF_CODE, CHANNEL_ARCHIVED_CODE). Variable provenance: a code
//      argument that is a variable assigned from `error.code === '<lit>'`
//      alternatives (agent-plugin-routes signingCode) contributes those
//      literals at the call's status.
//   6. The collab wire registry: STATUS_BY_CODE keys in
//      server/inbox-collab-routes.mjs — collabHttpError rethrows those codes
//      as ServiceError, so the map is the surface's own registry. A key is
//      counted only when the code also occurs in an emit context elsewhere
//      (envelope_duplicate_id occurs only in the map: no emitter, excluded).
//   7. Scoped src/ extraction (the old hand list's legitimate residue):
//      exported *_CODE constants, and fail()/reject() literals plus
//      `return { code: '<lit>' }` result objects in src/ modules that a
//      server/ or cloudflare/ module imports (password-auth policy codes,
//      outside-agents planner). Client-local synthetics in src/ modules no
//      server module imports are never extracted.
//
// Named limits (scoped sub-extractors, per PT-02 kill criteria): primary
// throw helpers with other names (refuse, gmailFail, SpendGrantError &
// friends) are NOT generic inventory — lane 39 adjudicated gmail_*/telegram_*
// as send-status errorCode fields, not envelope codes, and the rest are
// unadjudicated. If one of those families is routed to the envelope later,
// name it here the way railFail/envelopeFail are named. Dynamic codes built
// by string composition are not statically extractable and are out of scope.
//
// Internal-vocabulary exclusions are explicit and context-keyed (see
// EXCLUSIONS below); every exclusion names why its codes never reach
// error.code on the wire, and a test asserts each exclusion still matches a
// live emit record so exclusions cannot silently rot into blind spots.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentErrorAx, ERROR_REGISTRY, errorRegistryAx } from "../src/agent-error.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "skills/project-room/references/errors-catalog.md");
const CODE = "[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*";
const CODE_RE = new RegExp(`^${CODE}$`);

function* walk(dir, exts) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, exts);
    else if (exts.some(x => e.name.endsWith(x))) yield p;
  }
}
const rel = p => p.slice(ROOT.length + 1).split("\\").join("/");

// ---------------------------------------------------------------------------
// Extraction core
// ---------------------------------------------------------------------------

const strLit = a => { if (typeof a !== "string") return null; const m = new RegExp(`^['"](${CODE})['"]$`).exec(a.trim()); return m ? m[1] : null; };
const numLit = a => { if (typeof a !== "string") return null; const m = /^(\d{3})$/.exec(a.trim()); return m ? Number(m[1]) : null; };

function splitArgs(text, openIdx) {
  const args = []; let depth = 0, cur = "", q = null, esc = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (q) { cur += ch; if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") { depth++; if (depth > 1) cur += ch; continue; }
    if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth === 0) { args.push(cur); return { args, end: i }; } cur += ch; continue; }
    if (ch === "," && depth === 1) { args.push(cur); cur = ""; continue; }
    cur += ch;
  }
  return { args, end: text.length };
}
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
const lineText = (text, idx) => { const s = text.lastIndexOf("\n", idx) + 1; const e = text.indexOf("\n", idx); return text.slice(s, e < 0 ? undefined : e); };

function findCalls(text, names) {
  const out = [];
  const re = new RegExp(`\\b(${names.join("|")})\\s*\\(`, "g");
  let m; while ((m = re.exec(text))) { const open = text.indexOf("(", m.index); const { args, end } = splitArgs(text, open); out.push({ name: m[1], args, idx: m.index, end }); }
  return out;
}

const BASE_EMITTERS = ["fail", "reject", "ServiceError", "AgentPluginError", "railFail", "envelopeFail"];
const HELPER_NAMES = new Set(["check", "envelopeCheck"]);

// Discover file-local check()-family wrappers: a local function with a `code`
// parameter whose body forwards that parameter into a base emitter.
function discoverHelpers(text) {
  const helpers = new Map();
  const defRe = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{|function\s+(\w+)\s*\(([^)]*)\)\s*\{|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*([^;{]+);/g;
  let m;
  while ((m = defRe.exec(text))) {
    const name = m[1] || m[3] || m[5];
    const paramsRaw = m[2] ?? m[4] ?? m[6] ?? "";
    // A wrapper under any name qualifies only via the restrictive shape: a
    // literal code default in its signature (see the defaultCode handling
    // below). Otherwise the name must be a chartered check-family name.
    if (!HELPER_NAMES.has(name) && !/\bcode\s*=\s*['"][a-z]/.test(paramsRaw)) continue;
    const params = paramsRaw.split(",").map(s => s.trim().split("=")[0].trim()).filter(Boolean);
    const codeIdx = params.indexOf("code");
    let body = "";
    if (m[7] !== undefined) body = m[7];
    else { const open = text.indexOf("{", m.index); let d = 0; for (let i = open; i < text.length && i < open + 3000; i++) { if (text[i] === "{") d++; else if (text[i] === "}") { d--; if (!d) { body = text.slice(open, i + 1); break; } } } }
    if (codeIdx < 0) {
      // Wrapper with a fixed code in its body, e.g.
      // check = (condition, message) => { if (!condition) fail("invalid_api_key", message); }
      const lit = new RegExp(`(?:fail|reject)\\(\\s*(?:\\d{3}\\s*,\\s*)?['"](${CODE})['"]`).exec(body);
      if (lit && BASE_EMITTERS.some(e => body.includes(e))) {
        const st = /(?:fail|reject)\(\s*(\d{3})/.exec(body);
        helpers.set(name, { fixedCode: lit[1], fixedStatus: st ? Number(st[1]) : null });
      }
      continue;
    }
    if (!BASE_EMITTERS.some(e => new RegExp(`\\b${e}\\s*\\(`).test(body)) && !/throw/.test(body)) continue;
    let fixedStatus = null, statusIdx = null;
    const inner = new RegExp(`(?:fail|reject|envelopeFail|railFail)\\(\\s*(\\d{3})\\s*,\\s*code\\b`).exec(body);
    if (inner) fixedStatus = Number(inner[1]);
    if (/throw[\s\S]{0,80}?\{\s*status\s*,\s*code/.test(body) || /(?:fail|reject)\(\s*status\s*,\s*code/.test(body)) statusIdx = params.indexOf("status");
    // Literal code default: `require = (condition, code = 'invalid_email_import')`
    // whose body forwards `code` into an emitter call carrying a numeric
    // status literal — the default IS an emit (callers omit the code).
    // Status-less forwards (work-handoff's requireHandoff -> HandoffError)
    // yield no record, per the status rule.
    let defaultCode = null, defaultStatus = null;
    const dm = new RegExp(`\\bcode\\s*=\\s*['"](${CODE})['"]`).exec(paramsRaw);
    if (dm) {
      defaultCode = dm[1];
      const fwd = new RegExp(`(?:fail|reject|envelopeFail|railFail)\\([^)]*\\bcode\\b[^)]*?(\\d{3})`).exec(body);
      defaultStatus = fixedStatus ?? (fwd ? Number(fwd[1]) : null);
    }
    helpers.set(name, { codeIdx, statusIdx, fixedStatus, defaultCode, defaultStatus });
  }
  return helpers;
}

function fileConstants(text, srcConsts) {
  const map = new Map();
  // Only real declarations resolve — a parameter default (`code = '<lit>'`
  // in a signature) must not become a file-wide constant: work-handoff's
  // requireHandoff default would otherwise brand every fail(code, ...) in
  // the file with invalid_work_handoff, a code that never reaches the wire.
  const re = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"](${CODE})['"]`, "g");
  let m; while ((m = re.exec(text))) if (/code/i.test(m[1])) map.set(m[1], m[2]);
  const imp = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*src\//g;
  while ((m = imp.exec(text))) for (const part of m[1].split(",")) { const name = part.trim().split(/\s+as\s+/).pop().trim(); if (srcConsts.has(name)) map.set(name, srcConsts.get(name)); }
  const use = new RegExp(`\\b([A-Z][A-Z0-9_]*_CODE)\\b`, "g");
  while ((m = use.exec(text))) if (srcConsts.has(m[1])) map.set(m[1], srcConsts.get(m[1]));
  return map;
}

// Codes a variable was assigned from, when the assignment is a
// `x.code === '<lit>'` alternative chain (agent-plugin-routes signingCode).
function provenanceLiterals(text, varName) {
  const out = [];
  const re = new RegExp(`\\b${varName}\\s*=\\s*([^;]{0,400});`, "g");
  let m; while ((m = re.exec(text))) { const lit = new RegExp(`\\.code\\s*===\\s*['"](${CODE})['"]`, "g"); let l; while ((l = lit.exec(m[1]))) out.push(l[1]); }
  return out;
}

function extractFile(path, text, constants) {
  const records = [];
  const push = (code, status, idx, shape) => { if (code && CODE_RE.test(code)) records.push({ code, status: status ?? null, file: path, line: lineOf(text, idx), shape, lineText: lineText(text, idx) }); };
  // Per-file fail default: `const fail = (code, message, status = 409)` —
  // a code-first call that passes no status emits the default, which is
  // statically readable here (room-assistant is the standing example).
  let failDefault = null;
  const fd = /(?:const|let|var)\s+fail\s*=\s*\(([^)]*)\)/.exec(text) || /function\s+fail\s*\(([^)]*)\)/.exec(text);
  if (fd) { const dm = /status\s*=\s*(\d{3})/.exec(fd[1]); if (dm && fd[1].trim().startsWith("code")) failDefault = Number(dm[1]); }
  const helpers = discoverHelpers(text);
  for (const [, h] of helpers) if (h.defaultCode && h.defaultStatus != null) push(h.defaultCode, h.defaultStatus, 0, "helper-default");
  const names = [...BASE_EMITTERS, ...helpers.keys()];
  for (const call of findCalls(text, names)) {
    const a = call.args;
    const resolve = v => { const s = strLit(v || ""); if (s) return s; const id = (v || "").trim(); return constants.get(id) || null; };
    if (call.name === "ServiceError" || call.name === "AgentPluginError") { push(resolve(a[1]), numLit(a[0]), call.idx, call.name); continue; }
    const h = helpers.get(call.name);
    if (h) {
      if (h.fixedCode) { push(h.fixedCode, h.fixedStatus, call.idx, `helper:${call.name}`); continue; }
      const status = h.fixedStatus ?? (h.statusIdx != null && h.statusIdx >= 0 ? numLit(a[h.statusIdx]) : null);
      if (status == null) continue; // status-less helper throw: renamed internal_error centrally
      const code = resolve(a[h.codeIdx]);
      if (code) push(code, status, call.idx, `helper:${call.name}`);
      else { const id = (a[h.codeIdx] || "").trim(); if (/^\w+$/.test(id)) for (const lit of provenanceLiterals(text, id)) push(lit, status, call.idx, `helper:${call.name}`); }
      continue;
    }
    // fail / reject / railFail / envelopeFail direct call
    const s0 = numLit(a[0]), c0 = resolve(a[0]), c1 = resolve(a[1]);
    if (s0 != null && c1) push(c1, s0, call.idx, call.name);
    else if (c0) push(c0, numLit(a[2]) ?? (call.name === "fail" ? failDefault : null), call.idx, call.name);
    else if (s0 != null && a[1] && /^\w+$/.test(a[1].trim())) for (const lit of provenanceLiterals(text, a[1].trim())) push(lit, s0, call.idx, call.name);
  }
  // Result objects / named bodies (shape 4)
  let m;
  const adj1 = new RegExp(`\\{[^{}]*?(?:status|httpStatus)\\s*:\\s*(\\d{3})\\s*,[^{}]*?\\bcode\\s*:\\s*['"](${CODE})['"]`, "g");
  const adj2 = new RegExp(`\\{[^{}]*?\\bcode\\s*:\\s*['"](${CODE})['"][^{}]*?,\\s*(?:status|httpStatus)\\s*:\\s*(\\d{3})`, "g");
  while ((m = adj1.exec(text))) push(m[2], Number(m[1]), m.index, "object");
  while ((m = adj2.exec(text))) push(m[1], Number(m[2]), m.index, "object");
  const errN = new RegExp(`error\\s*:\\s*\\{[^{}]*?\\bcode\\s*:\\s*['"](${CODE})['"]`, "g");
  while ((m = errN.exec(text))) { const st = /(?:status|httpStatus)\s*:\s*(\d{3})/.exec(m[0]); push(m[1], st ? Number(st[1]) : null, m.index, "error-object"); }
  const named = new RegExp(`\\b(?:agentErrorBody|workerErrorBody)\\s*\\(\\s*\\{[^{}]*?\\bcode\\s*:\\s*['"](${CODE})['"]`, "g");
  while ((m = named.exec(text))) { const st = /(?:status|httpStatus)\s*:\s*(\d{3})/.exec(m[0]); push(m[1], st ? Number(st[1]) : null, m.index, "named-body"); }
  return records;
}

function loadTree() {
  const files = new Map(); // rel path -> text, for server/ + cloudflare/
  for (const dir of ["server", "cloudflare"]) {
    for (const p of walk(join(ROOT, dir), [".mjs", ".js"])) files.set(rel(p), readFileSync(p, "utf8"));
  }
  const srcConsts = new Map();
  const srcFiles = new Map();
  for (const p of walk(join(ROOT, "src"), [".mjs", ".js"])) {
    const t = readFileSync(p, "utf8"); srcFiles.set(rel(p), t);
    const re = new RegExp(`export\\s+const\\s+(\\w+_CODE)\\s*=\\s*['"](${CODE})['"]`, "g");
    let m; while ((m = re.exec(t))) srcConsts.set(m[1], m[2]);
  }
  return { files, srcFiles, srcConsts };
}

// The collab wire registry (shape 6).
function statusByCodeRecords(files) {
  const path = "server/inbox-collab-routes.mjs";
  const text = files.get(path) || "";
  const start = text.indexOf("STATUS_BY_CODE");
  if (start < 0) return { records: [], uncorroborated: [] };
  const end = text.indexOf("}));", start);
  const region = text.slice(start, end < 0 ? undefined : end);
  const entries = new Map();
  for (const m of region.matchAll(new RegExp(`\\b(${CODE}):\\s*(\\d{3})\\b`, "g"))) entries.set(m[1], Number(m[2]));
  // Corroboration corpus: every walked file with the map region removed.
  const corpus = [...files.entries()].map(([p, t]) => p === path ? t.slice(0, start) + t.slice(end < 0 ? t.length : end) : t).join("\n");
  const records = [], uncorroborated = [];
  for (const [code, status] of entries) {
    if (new RegExp(`\\b${code.replace(/-/g, "[-]")}\\b`).test(corpus)) records.push({ code, status, file: path, line: lineOf(text, start), shape: "status-by-code", lineText: "" });
    else uncorroborated.push(code);
  }
  return { records, uncorroborated };
}

function computeInventory() {
  const { files, srcFiles, srcConsts } = loadTree();
  const records = [];
  for (const [p, t] of files) {
    if (p.endsWith(".check.mjs") || p.endsWith(".test-fixture.mjs")) continue; // test harnesses, not production paths (d6)
    if (p.startsWith("cloudflare/external-probe")) continue; // probe check-name vocabulary, not the room envelope (d6/lane 39)
    records.push(...extractFile(p, t, fileConstants(t, srcConsts)));
  }
  records.push(...statusByCodeRecords(files).records);
  // Scoped src/ extraction (shape 7): src modules a server/cloudflare module imports.
  const imported = new Set();
  for (const t of files.values()) for (const m of t.matchAll(/from\s*['"][^'"]*src\/([\w.-]+)['"]/g)) imported.add(m[1]);
  for (const [p, t] of srcFiles) {
    const base = p.split("/").pop();
    const re = new RegExp(`export\\s+const\\s+\\w+_CODE\\s*=\\s*['"](${CODE})['"]`, "g");
    let m; while ((m = re.exec(t))) records.push({ code: m[1], status: null, file: p, line: lineOf(t, m.index), shape: "src-const", lineText: "" });
    if (!imported.has(base)) continue;
    for (const call of findCalls(t, ["fail", "reject", "ServiceError", "AgentPluginError"])) {
      const a = call.args; const s0 = numLit(a[0]);
      const c = call.name === "ServiceError" || call.name === "AgentPluginError" ? strLit(a[1]) : (s0 != null ? strLit(a[1]) : strLit(a[0]));
      if (c) records.push({ code: c, status: s0 ?? numLit(a[2]), file: p, line: lineOf(t, call.idx), shape: "src-call", lineText: "" });
    }
    const ret = new RegExp(`return\\s*\\{\\s*code:\\s*['"](${CODE})['"]`, "g");
    while ((m = ret.exec(t))) records.push({ code: m[1], status: null, file: p, line: lineOf(t, m.index), shape: "src-result", lineText: "" });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Exclusions — internal vocabulary that never reaches error.code on the wire.
// Keyed on emit-site context; each entry names why. A test below asserts
// every exclusion still matches a live record (or names a code that no
// longer appears anywhere), so an exclusion cannot rot into a blind spot.
// ---------------------------------------------------------------------------
const EXCLUSIONS = [
  {
    // SSE stream diagnostics are recorded in a diagnostics log with the
    // stream's own HTTP status; the code is a log/event vocabulary, never an
    // error-envelope code (d6 Scope 1, not-catalogue-scope list).
    name: "sse-diagnostics",
    test: r => /diagnostics\.record\(/.test(r.lineText) && (r.code === "stream_lagging" || r.code === "stream_unavailable"),
  },
  {
    // Wiring-time invariant guards in the heartbeats factory: thrown while
    // the service is being constructed with a bad config (programmer
    // error at boot/wiring), never from a request handler, so no client
    // can receive them as error.code.
    name: "heartbeats-wiring-invariants",
    test: r => r.file === "server/agent-heartbeats.mjs" && (r.code === "invalid_heartbeat_config" || r.code === "invalid_wake_waiter"),
  },
];

let inventoryCache = null;
function inventory() {
  if (inventoryCache) return inventoryCache;
  const raw = computeInventory();
  const kept = raw.filter(r => !EXCLUSIONS.some(x => x.test(r)));
  const byCode = new Map();
  for (const r of kept) { if (!byCode.has(r.code)) byCode.set(r.code, []); byCode.get(r.code).push(r); }
  inventoryCache = { raw, kept, byCode };
  return inventoryCache;
}

// ---------------------------------------------------------------------------
// Catalogue parsing (hyphen-inclusive — the old parser could not even see
// the bond-missing row).
// ---------------------------------------------------------------------------
function catalogSection() {
  const md = readFileSync(CATALOG, "utf8");
  const i = md.indexOf("## Full code index");
  assert.ok(i > 0, "catalog is missing the '## Full code index' section");
  return md.slice(i);
}
function catalogRows() {
  const md = catalogSection();
  const rows = new Map();
  for (const m of md.matchAll(new RegExp(`^\\| \`(${CODE})\` \\| (\\S+) \\|`, "gm"))) {
    if (!rows.has(m[1])) rows.set(m[1], []);
    rows.get(m[1]).push({ status: m[2] });
  }
  return rows;
}
function catalogReserved() {
  const reserved = new Set();
  for (const line of catalogSection().split("\n")) {
    const m = new RegExp(`^\\| \`(${CODE})\` \\|`).exec(line);
    if (m && /\bReserved\b/.test(line)) reserved.add(m[1]);
  }
  return reserved;
}
function catalogRetry(code) {
  const md = catalogSection();
  const line = md.split("\n").find(l => l.startsWith(`| \`${code}\` |`));
  if (!line) return null;
  const cells = line.split(" | ");
  return cells[3] ? cells[3].trim() : null;
}

// ---------------------------------------------------------------------------
// Pending catalogue exceptions. Named sets, each tied to the work that
// carries its rows. Mechanics (asserted in the test below):
//   - the missing-from-catalogue set must EQUAL the union of these sets;
//   - no excepted code may be catalogued (the test fails the moment its
//     rows land, forcing the exception to be removed);
//   - every excepted code must be in the computed inventory (a code that
//     stops being emitted makes its exception stale, and the test fails);
//   - each set is asserted against a second literal copy, so growing a set
//     is a visible, failing edit rather than a silent one.
// ---------------------------------------------------------------------------
const PENDING_4739 = new Set(["buyer_signoff_required", "receipt_replayed"]); // PR #4739 (fix-wave lane 25, AX mappings ride with the rows)
// PT-14's delta rows: the 28 codes of the PROOF lane-39 census beyond the
// original 19 — 8 record-rails, 18 collab STATUS_BY_CODE, 2 envelope
// journal. They ride PR #4772 (base main, after #4720 merged).
const PENDING_PT14 = new Set([
  "candidate_mismatch", "invalid_signoff_trial", "invalid_signoff_contract",
  "invalid_contract_worker", "contract_trial_mismatch", "invalid_contract_rubric",
  "contract_rubric_mismatch", "contract_signoff_required",
  "assign_invalid", "assign_forbidden", "approval_not_human", "assignment_not_found",
  "lock_not_found", "handoff_no_account_scope", "handoff_forbidden",
  "invalid_handoff_envelope", "invalid_envelope_status", "invalid_envelope_room",
  "envelope_checks_required", "envelope_unknown_check", "envelope_expiry_system_only",
  "envelope_not_found", "envelope_recipient_only", "envelope_sender_only",
  "envelope_party_only", "invalid_envelope_transition",
  "envelope_expired", "envelope_request_conflict",
]);

// PT-02-discovered codes: computed by this guard, verified wire-visible at
// their emit sites during the PT-02 lane, and owed catalogue rows by the
// catalogue owner (follow-up to PT-14). Same mechanics as the other sets.
const PENDING_PT02 = new Set([
  "channel_archived",        // server/store.mjs fail(409, CHANNEL_ARCHIVED_CODE); AX-mapped already (src/agent-error.mjs)
  "envelope_actor_required", // server/work-handoff.mjs:409 envelopeCheck -> envelopeFail(422)
  "invalid_email_import",    // server/email-import.mjs require() -> ServiceError(422)
  "invalid_handoff_case",    // server/handoff-case.mjs CODE, check -> ServiceError(422)
  "invalid_handoff_packet",  // server/inbox-handoff.mjs CODE, check -> ServiceError(422)
  "invalid_handoff_status",  // server/inbox-handoff.mjs check -> ServiceError(422)
  "invalid_wake_cursor",     // server/agent-heartbeats.mjs:1036 check(false, 422, ...) on the wake-poll read path
]);

// Status pins — the assistant_denied class, enumerated. A code is pinned
// when its catalogue status cell is DISJOINT from every statically-read
// emit status: the catalogue documents a status the code never emits (or
// vice versa). The status test asserts the disjoint set EQUALS this pin
// set exactly — a newly disjoint code fails, and correcting a pinned cell
// fails until its pin is removed. Partial multi-status divergence (the
// emitted and catalogued sets intersect but neither contains the other) is
// NOT pinned or failed: it is a catalogue-quality backlog, enumerated in
// the PT-02 filing for the catalogue owner.
// Each pin: emitted = the only statically-read emit status; catalogued =
// the catalogue's status cell; sites = where the emit status is read.
const STATUS_PINS = [
  { code: "assistant_input_limit", emitted: 422, catalogued: 409, sites: "server/room-assistant.mjs fail('assistant_input_limit', msg, 422); catalogue carries the module fail default 409" },
  { code: "assistant_result_missing", emitted: 422, catalogued: 409, sites: "server/room-assistant.mjs fail('assistant_result_missing', msg, 422); catalogue carries the fail default 409" },
  { code: "assistant_run_missing", emitted: 404, catalogued: 409, sites: "server/room-assistant.mjs fail('assistant_run_missing', msg, 404); catalogue carries the fail default 409" },
  { code: "assistant_source_denied", emitted: 403, catalogued: 409, sites: "server/room-assistant.mjs fail('assistant_source_denied', msg, 403); catalogue carries the fail default 409" },
  { code: "channel_connection_not_found", emitted: 404, catalogued: 409, sites: "server/channel-drain.mjs + server/email-import.mjs fail(..., 'channel_connection_not_found', 404) / fail(404, ...); catalogue reads 409" },
  { code: "discussion_ahead", emitted: 409, catalogued: 422, sites: "server/work-discussion.mjs fail('discussion_ahead', msg, 409) at both sites; catalogue reads 422" },
  { code: "discussion_entry_too_large", emitted: 413, catalogued: 422, sites: "server/work-discussion.mjs emits 413; catalogue reads 422" },
  { code: "invalid_assistant_action", emitted: 422, catalogued: 409, sites: "server/room-assistant.mjs emits 422; catalogue carries the fail default 409" },
  { code: "invalid_assistant_config", emitted: 422, catalogued: 409, sites: "server/room-assistant.mjs emits 422; catalogue carries the fail default 409" },
  { code: "invalid_assistant_report", emitted: 422, catalogued: 409, sites: "server/room-assistant.mjs emits 422; catalogue carries the fail default 409" },
  { code: "invalid_reply_update", emitted: 422, catalogued: 409, sites: "server/graph-reply-journal.mjs emits 422; catalogue reads 409" },
  { code: "invalid_request_run", emitted: 422, catalogued: 409, sites: "server/request-runs.mjs emits 422; catalogue reads 409" },
  { code: "invalid_send_budget_scope", emitted: 400, catalogued: 500, sites: "server/channel-send-budgets.mjs:131 throw new ServiceError(400, 'invalid_send_budget_scope') — the only emit site in the repo; catalogue reads 500" },
  { code: "reply_context_unavailable", emitted: 409, catalogued: 422, sites: "server/reply-requests.mjs emits 409; catalogue reads 422" },
  { code: "reply_cursor_identity_changed", emitted: 409, catalogued: 422, sites: "server/reply-requests.mjs emits 409; catalogue reads 422" },
  { code: "reply_entry_too_large", emitted: 413, catalogued: 422, sites: "server/reply-requests.mjs emits 413; catalogue reads 422" },
  { code: "reply_follow_up_too_large", emitted: 413, catalogued: 422, sites: "server/reply-requests.mjs emits 413; catalogue reads 422" },
  { code: "reply_follow_up_unavailable", emitted: 409, catalogued: 422, sites: "server/reply-requests.mjs emits 409; catalogue reads 422" },
  { code: "reply_history_changed", emitted: 409, catalogued: 422, sites: "server/reply-requests.mjs emits 409; catalogue reads 422" },
  { code: "reply_observation_limit", emitted: 422, catalogued: 409, sites: "server/graph-reply-journal.mjs emits 422; catalogue reads 409" },
  { code: "reply_request_not_found", emitted: 404, catalogued: 422, sites: "server/reply-requests.mjs fail('reply_request_not_found', msg, 404); catalogue reads 422" },
  { code: "request_run_denied", emitted: 403, catalogued: 409, sites: "server/request-runs.mjs fail('request_run_denied', msg, 403); catalogue reads 409" },
  {
    code: "reputation_probation", emitted: 409, catalogued: 422,
    sites: "server/public-work-settlement.mjs:166 emits fail(409, 'reputation_probation') on the public-work surface; the catalogue documents 422 for the escrow surface, where server/bounty-escrow.mjs:553 throws EscrowError('reputation_probation') and the escrow route map converts it to 422 (the catalogue row carries the 'EscrowError route map' note). Two surfaces, two statuses, one code — this pin is a documentation split, not a wrong cell.",
  },
];

test("catalog exists and is linked from the skill", () => {
  assert.ok(readFileSync(CATALOG, "utf8").length > 10000, "catalog doc is unexpectedly small");
  const skill = readFileSync(join(ROOT, "skills/project-room/SKILL.md"), "utf8");
  assert.match(skill, /references\/errors-catalog\.md/, "SKILL.md must link the catalog");
  const errors = readFileSync(join(ROOT, "skills/project-room/references/errors.md"), "utf8");
  assert.match(errors, /references\/errors-catalog\.md/, "errors.md must point at the catalog");
});

test("every computed wire code is catalogued or in a named pending exception", () => {
  // The exception sets are exactly the chartered sets — asserted against
  // second literals so growing a set fails here, not in review.
  assert.deepEqual([...PENDING_4739].sort(), ["buyer_signoff_required", "receipt_replayed"],
    "PENDING_4739 must name exactly the two PR #4739 codes");
  assert.deepEqual([...PENDING_PT14].sort(), [
    "approval_not_human", "assign_forbidden", "assign_invalid", "assignment_not_found",
    "candidate_mismatch", "contract_rubric_mismatch", "contract_signoff_required",
    "contract_trial_mismatch", "envelope_checks_required", "envelope_expired",
    "envelope_expiry_system_only", "envelope_not_found", "envelope_party_only",
    "envelope_recipient_only", "envelope_request_conflict", "envelope_sender_only",
    "envelope_unknown_check", "handoff_forbidden", "handoff_no_account_scope",
    "invalid_contract_rubric", "invalid_contract_worker", "invalid_envelope_room",
    "invalid_envelope_status", "invalid_envelope_transition", "invalid_handoff_envelope",
    "invalid_signoff_contract", "invalid_signoff_trial", "lock_not_found",
  ], "PENDING_PT14 must name exactly the 28 lane-39 delta codes");
  assert.deepEqual([...PENDING_PT02].sort(), [
    "channel_archived", "envelope_actor_required", "invalid_email_import",
    "invalid_handoff_case", "invalid_handoff_packet", "invalid_handoff_status",
    "invalid_wake_cursor",
  ], "PENDING_PT02 must name exactly the seven PT-02-discovered codes");
  const { byCode } = inventory();
  const rows = catalogRows();
  const pending = new Set([...PENDING_4739, ...PENDING_PT14, ...PENDING_PT02]);
  for (const code of pending) {
    assert.ok(byCode.has(code), `pending-exception code '${code}' is not emitted anywhere the guard can see — the exception is stale, remove it`);
    assert.ok(!rows.has(code), `pending-exception code '${code}' is now catalogued — remove it from its pending set (its row-carrying work has landed)`);
  }
  const missing = [...byCode.keys()].filter(c => !rows.has(c)).sort();
  assert.deepEqual(missing, [...pending].sort(),
    `codes emitted on the wire but missing from the catalog (and not in a named pending exception): ${missing.filter(c => !pending.has(c)).join(", ")}`);
});

test("cloudflare walk and hyphenated codes are extracted (d6 blindnesses)", () => {
  const { byCode } = inventory();
  assert.ok(byCode.has("room_unavailable"), "room_unavailable (cloudflare/room.mjs workerErrorBody) was not extracted — the cloudflare/ walk is broken");
  assert.ok(byCode.get("room_unavailable").some(r => r.status === 503), "room_unavailable must carry its 503 emit status");
  assert.ok(byCode.has("bond-missing"), "bond-missing (hyphenated, server/bounty-disputes.mjs) was not extracted — the code pattern excludes hyphens again");
});

test("ServiceError codes constructed before throwing are extracted (#2897)", () => {
  const { byCode } = inventory();
  for (const code of ["transfer_ownership_required", "github_rate_limited", "aborted"]) {
    assert.ok(byCode.has(code), `construct-then-throw code '${code}' was not extracted`);
  }
});

test("variable- and constant-passed codes resolve from source, not a hand list", () => {
  // The old guard's hand-maintained VARIABLE_CODES, plus channel_archived
  // (which the hand list missed): every one must be COMPUTED now.
  const { byCode } = inventory();
  for (const code of ["trust_off", "channel_archived", "rate_limited",
    "invalid_signing_input", "invalid_card_signature",
    "invalid_password", "password_too_short", "password_too_long",
    "outside_agent_unlinked"]) {
    assert.ok(byCode.has(code), `variable/constant-passed code '${code}' was not computed from source`);
  }
  // All but channel_archived (PENDING_PT02 — its row is still owed) are
  // catalogued today.
  for (const code of ["trust_off", "rate_limited",
    "invalid_signing_input", "invalid_card_signature",
    "invalid_password", "password_too_short", "password_too_long",
    "outside_agent_unlinked"]) {
    assert.ok(catalogRows().has(code), `variable/constant-passed code '${code}' missing from the catalog`);
  }
});

test("STATUS_BY_CODE registry: every corroborated key is extracted, the map-only key is not", () => {
  const { files } = loadTree();
  const { records, uncorroborated } = statusByCodeRecords(files);
  assert.ok(records.length >= 30, `expected the collab registry's corroborated keys, got ${records.length}`);
  assert.deepEqual(uncorroborated, ["envelope_duplicate_id"],
    "envelope_duplicate_id is the one map key with no emitter; a new uncorroborated key must be adjudicated, not silently absorbed");
});

test("exclusions still match live emit records (they cannot rot into blind spots)", () => {
  const { raw } = inventory();
  for (const x of EXCLUSIONS) {
    assert.ok(raw.some(r => x.test(r)), `exclusion '${x.name}' no longer matches any emit record — remove it or re-justify it`);
  }
});

test("catalogued statuses are not disjoint from statically-read emit statuses", () => {
  // The provably-wrong class (assistant_denied at the old base: catalogue
  // 409, every emit site 403): catalogue numeric statuses and emitted
  // statuses share no value. Partial multi-status divergence is not
  // failed here — see STATUS_PINS and the header note.
  const { byCode } = inventory();
  const rows = catalogRows();
  const disjoint = [];
  for (const [code, recs] of byCode) {
    const cat = rows.get(code);
    if (!cat) continue;
    const catNums = [...new Set(cat.map(r => r.status).filter(s => /^\d+$/.test(s)).map(Number).filter(s => s !== 0))];
    if (!catNums.length) continue; // internal / status-0 rows claim no wire status (file_lease_conflict is the documented 0-row case)
    const emitted = [...new Set(recs.map(r => r.status).filter(s => s != null))];
    if (!emitted.length) continue;
    if (!emitted.some(s => catNums.includes(s))) disjoint.push(`${code}:${emitted.sort((x, y) => x - y).join("/")}:${catNums.sort((x, y) => x - y).join("/")}`);
  }
  const pins = STATUS_PINS.map(p => `${p.code}:${p.emitted}:${p.catalogued}`);
  assert.deepEqual(disjoint.sort(), pins.sort(),
    `disjoint status cells beyond the pinned set (pins: ${STATUS_PINS.map(p => `${p.code} — ${p.sites}`).join(" | ")}): ${disjoint.join(", ")}`);
});

test("no ghost rows: every catalogued code is emitted, referenced, or marked Reserved", () => {
  const { byCode } = inventory();
  const rows = catalogRows();
  const reserved = catalogReserved();
  // Reference corpus: a code string occurring anywhere in the source trees
  // (d6's ghost method) counts as a live reference — registry entries, AX
  // maps, client handlers. Only a code with NO occurrence outside the two
  // catalogue copies is a ghost.
  const tokens = new Set();
  for (const dir of ["server", "cloudflare", "src", "cli", "bridge", "client"]) {
    let base; try { base = join(ROOT, dir); readdirSync(base); } catch { continue; }
    for (const p of walk(base, [".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".yaml", ".yml", ".html", ".css"])) {
      if (p.includes("errors-catalog")) continue;
      for (const m of readFileSync(p, "utf8").matchAll(/[a-z][a-z0-9_-]+/g)) tokens.add(m[0]);
    }
  }
  const ghosts = [...rows.keys()].filter(c => !byCode.has(c) && !tokens.has(c) && !reserved.has(c)).sort();
  assert.deepEqual(ghosts, [], `catalogued codes with no emitter and no live reference anywhere (ghost rows): ${ghosts.join(", ")}`);
});

test("pinned doc statements: retry semantics match the catalog", () => {
  assert.equal(catalogRetry("already_claimed"), "no");
  assert.equal(catalogRetry("already_member"), "no");
  assert.equal(catalogRetry("rate_limited"), "wait");
  assert.equal(catalogRetry("mail_not_configured"), "no");
  assert.equal(catalogRetry("board_v2_retired"), "no");
  const rows = catalogRows();
  assert.ok(rows.get("board_v2_retired")?.some(r => r.status === "410"), "board_v2_retired must be documented as HTTP 410");
});

test("pinned doc statements: family recovery rules are present", () => {
  const md = readFileSync(CATALOG, "utf8");
  assert.match(md, /Keep the same command id if the earlier send was uncertain/, "input_refused family rule");
  assert.match(md, /Do not mint a new identity to fix access/, "401 family rule");
  assert.match(md, /Do not guess ids/, "404 family rule");
  assert.match(md, /errorId.*fingerprint|fingerprint.*errorId/, "5xx trace rule");
  assert.match(md, /Unknown error '<code>'/, "fallthrough explanation");
});

test("no JSON-RPC numeric code section is empty", () => {
  const md = readFileSync(CATALOG, "utf8");
  for (const code of ["-32700", "-32600", "-32601", "-32602", "-32603", "-32001", "-32003"]) {
    assert.ok(md.includes(`\`${code}\``), `JSON-RPC code ${code} missing from the catalog`);
  }
});

// #3055 recurrence guard (kept from the previous guard): the catalog-presence
// checks must also verify agentErrorAx() actually maps a code.
// AX pending (fix-wave lane 25's surface — this guard does not write AX
// mappings): PT-14 executed agentErrorAx() over its 28 new rows; exactly
// these two return the Unknown fallthrough and are owed named/family
// mappings by lane 25. While #4772 is unmerged the codes are not yet
// catalogued and this set is dormant; once catalogued, the AX test skips
// exactly these two, and the dedicated test below fails if one becomes
// AX-covered (forcing removal) — it must never grow silently.
const AX_PENDING_LANE25 = new Set(["handoff_no_account_scope", "envelope_request_conflict"]);
const AX_COVERAGE_EXCLUDED = AX_PENDING_LANE25;

function catalogAxRows() {
  const rows = [];
  for (const line of catalogSection().split("\n")) {
    const m = new RegExp(`^\\| \`(${CODE})\` \\| (\\S+) \\|`).exec(line);
    if (!m || !/^\d+$/.test(m[2]) || m[2] === "0") continue;
    const cells = line.split(" | ");
    rows.push({ code: m[1], httpStatus: Number(m[2]), message: cells[2] ? cells[2].trim() : "" });
  }
  return rows;
}

test("AX pending set is exactly the two lane-25 codes and stays honest", () => {
  assert.deepEqual([...AX_PENDING_LANE25].sort(), ["envelope_request_conflict", "handoff_no_account_scope"],
    "AX_PENDING_LANE25 must name exactly the two codes PT-14's executed probe found Unknown");
  const rows = catalogRows();
  for (const code of AX_PENDING_LANE25) {
    assert.ok(!PENDING_PT14.has(code) || !rows.has(code),
      `${code} cannot be both catalogue-pending and AX-pending — burn down PENDING_PT14 first`);
    if (!rows.has(code)) continue; // dormant: #4772 has not landed yet
    const ax = agentErrorAx({ httpStatus: 409, code, message: "" });
    assert.ok(ax.hint.startsWith("Unknown error"),
      `${code} is now AX-covered — remove it from AX_PENDING_LANE25 (lane 25's mapping landed)`);
  }
});

test("every catalogued server-emittable code has an AX recovery (#3055)", () => {
  const rows = catalogAxRows();
  assert.ok(rows.length > 800, `expected the full catalogued code set, got ${rows.length} numeric rows`);
  rows.push({ code: "file_lease_conflict", httpStatus: 409, message: "file_lease_conflict is AX-routed at 409 (see scope note above)" });
  const unmapped = [];
  for (const { code, httpStatus, message } of rows) {
    if (AX_COVERAGE_EXCLUDED.has(code)) continue;
    const ax = agentErrorAx({ httpStatus, code, message });
    if (ax.hint.startsWith("Unknown error")) unmapped.push(`${code} (${httpStatus})`);
  }
  assert.deepEqual(unmapped, [], `catalogued codes with no agentErrorAx() mapping or family coverage (Unknown fallthrough): ${unmapped.join(", ")}`);
});

// ---------------------------------------------------------------------------
// E4-REG (decision #19c) — kept verbatim from the previous guard.
// ---------------------------------------------------------------------------

function catalogRowFor(code, http) {
  for (const line of catalogSection().split("\n")) {
    const m = new RegExp(`^\\| \`(${CODE})\` \\| (\\S+) \\|`).exec(line);
    if (!m || m[1] !== code || Number(m[2]) !== http) continue;
    const cells = line.split(" | ");
    return {
      retry: cells[3] ? cells[3].trim() : null,
      recovery: cells[4] ? cells[4].replace(/\|\s*$/, "").trim() : null,
    };
  }
  return null;
}

const nextTextOf = ax => ax.next.map(s => s.command ?? s.path ?? `tool:${s.tool}`).join(" ; ");

const REGISTRY_FIXTURES = [
  ...["invalid_archive_request", "invalid_room_id", "invalid_keep_newest", "reason_required", "dry_run_required", "read_only", "archive_not_ready"].map(code => [code, { httpStatus: ERROR_REGISTRY[code].catalog.http }, ax => {
    assert.equal(ax.reason, code);
    assert.equal(ax.status, "action_required");
    assert.doesNotMatch(ax.hint, /^Unknown error/);
    assert.match(nextTextOf(ax), /.+/);
  }]),
  ["agent_not_registered", { httpStatus: 404, message: "No host has reported for this identity yet — POST /api/agent-heartbeats first, then poll." },
    ax => {
      assert.deepEqual(ax.next[0], { path: "/api/agent-heartbeats" });
      assert.match(ax.hint, /agent-heartbeats/);
    }],
  ["invalid_wake_poll", { httpStatus: 422, message: "hostId must be 1-128 chars, [A-Za-z0-9._-] — one wake waiter per host" },
    ax => {
      assert.match(ax.hint, /hostId/);
      assert.match(ax.hint, /1-128/);
    }],
  ["invalid_wake_poll", { httpStatus: 422, message: "waitMs must be 0..55000 milliseconds" },
    ax => {
      assert.match(ax.hint, /waitMs/);
      assert.match(ax.hint, /55000/);
    }],
  ["stale_public_work", { httpStatus: 409, message: "Task terms changed", workItemId: "task_9" },
    ax => {
      assert.deepEqual(ax.next[0], { path: "/api/public-work/tasks/task_9" });
      assert.match(ax.hint, /termsVersion/);
      assert.doesNotMatch(`${ax.hint} ${nextTextOf(ax)}`, /\/api\/session|room_read_work|workContext/);
    }],
  ["stale_public_work", { httpStatus: 409, message: "Task terms changed" },
    ax => {
      assert.deepEqual(ax.next[0], { path: "/api/public-work/tasks" });
    }],
  ["public_work_already_submitted", { httpStatus: 409, message: "This task already has a submitted receipt", workItemId: "task_9" },
    ax => {
      assert.deepEqual(ax.next[0], { path: "/api/public-work/tasks/task_9" });
      assert.match(nextTextOf(ax), /submittedReceiptId/);
      assert.match(ax.hint, /submitted receipt/);
    }],
  ["public_work_claim_conflict", { httpStatus: 409, message: "Task already claimed by alice (lease expires 2026-10-14T00:00:00.000Z)" },
    ax => {
      assert.match(ax.hint, /alice/);
      assert.match(ax.hint, /Wait for release or lease expiry/);
    }],
  ["public_work_claim_conflict", { httpStatus: 409, message: "Task already claimed by you (lease expires 2026-10-14T00:00:00.000Z)" },
    ax => {
      assert.match(ax.hint, /Renew/);
    }],
  ["stale_public_claim", { httpStatus: 409, message: "Claim generation changed (submitted 1, current 2)" },
    ax => {
      assert.match(ax.hint, /generation 2/);
      assert.match(nextTextOf(ax), /NOT saved/);
    }],
  ["stale_public_claim", { httpStatus: 409, message: "Claim expired: the lease lapsed or the claim was released (generation 1 is no longer held)" },
    ax => {
      assert.match(ax.hint, /expired/);
    }],
  ["stale_card", { httpStatus: 422, message: "The card signature is stale; sign a fresh joinRequest" },
    ax => {
      assert.match(ax.hint, /issuedAt/);
      assert.match(nextTextOf(ax), /fresh joinRequest/);
      assert.doesNotMatch(`${ax.hint} ${nextTextOf(ax)}`, /\/api\/session|room_read_work|workContext|expectedRevision/);
    }],
  ["guest_scope_denied", { httpStatus: 403, message: "Guest members cannot perform this action" },
    ax => {
      assert.equal(ax.reason, "guest_scope_denied");
      assert.match(ax.hint, /Guest/);
      assert.match(ax.hint, /full members/);
      assert.match(nextTextOf(ax), /full membership/);
    }],
  ["guest_invite_account_session_required", { httpStatus: 403, message: "Guest invites are managed from the room owner's signed-in account session" },
    ax => {
      assert.equal(ax.reason, "guest_invite_account_session_required");
      assert.match(ax.hint, /signed-in account session/);
      assert.match(ax.hint, /owner delegate/);
      assert.match(nextTextOf(ax), /agent-invites/);
      assert.doesNotMatch(`${ax.hint} ${nextTextOf(ax)}`, /Ask the owner to mint/);
    }],
  ["proof_required", { httpStatus: 428, message: "Identity mint proof required" },
    ax => {
      assert.match(ax.hint, /SHA-256/);
      assert.match(nextTextOf(ax), /agent-invites\/redeem/);
    }],
];

test("registry-migrated codes: shipped envelope equals the registry resolution (E4-REG)", () => {
  assert.ok(ERROR_REGISTRY && typeof ERROR_REGISTRY === "object", "ERROR_REGISTRY must be exported from src/agent-error.mjs");
  assert.ok(typeof errorRegistryAx === "function", "errorRegistryAx must be exported from src/agent-error.mjs");
  const migrated = Object.keys(ERROR_REGISTRY);
  assert.deepEqual(migrated.sort(), ["agent_not_registered", "archive_not_ready", "dry_run_required", "guest_invite_account_session_required", "guest_scope_denied", "invalid_archive_request", "invalid_keep_newest", "invalid_room_id", "invalid_wake_poll", "proof_required",
    "public_work_already_submitted", "public_work_claim_conflict", "public_work_claim_limit", "public_work_deadline_passed", "public_work_renewal_limit", "read_only", "reason_required", "referral_invites_parked", "stale_card", "stale_public_claim", "stale_public_work"],
    "the migrated set is the joining-path set; growing it is a deliberate edit here too");
  for (const [code, ctx, check] of REGISTRY_FIXTURES) {
    const shipped = agentErrorAx({ code, ...ctx });
    const registered = errorRegistryAx(code, ctx);
    assert.ok(registered, `${code} must resolve through the registry`);
    assert.deepEqual(shipped, registered, `${code}: shipped envelope diverges from the registry`);
    assert.doesNotMatch(shipped.hint, /^Unknown error/, `${code} must not hit the Unknown fallthrough`);
    check(shipped);
  }
});

test("catalog rows for registry-migrated codes match the registry declaration (E4-REG)", () => {
  for (const [code, entry] of Object.entries(ERROR_REGISTRY)) {
    assert.ok(entry.catalog, `${code}: registry entry must declare its catalog row`);
    const row = catalogRowFor(code, entry.catalog.http);
    assert.ok(row, `${code}: no catalog row at HTTP ${entry.catalog.http}`);
    assert.equal(row.retry, entry.catalog.retry, `${code}: catalog Retry cell diverges from the registry`);
    assert.equal(row.recovery, entry.catalog.recovery, `${code}: catalog Recovery cell diverges from the registry`);
  }
});

test("flagship #3055 codes name their catalogued recovery, not 'no known recovery'", () => {
  const cases = [
    ["bond_proposed_by_peer", 409, 'That agent already proposed a bond to you (bondId bond_1). Answer it with bond.accept { bondId: "bond_1" } or bond.decline, then propose again.', /bond\.accept/],
    ["file_lease_conflict", 409, 'Work "w1" overlaps files leased to alice (claim_1) until 2026-10-14T00:00:00.000Z: src/a.mjs', /leased to alice/],
    ["peer_not_found", 404, "That ID cannot resolve to an available agent peer in this room. Use get_room_context to find linked room members.", /get_room_context/],
    ["invite_unavailable", 404, "No invite was issued for this code. Ask the inviter for a fresh code", /fresh code/],
    ["credential_too_old", 410, "This credential is too old; ask the owner for a new invite.", /fresh|expired/i],
    ["discussion_reset_required", 409, "Discussion changed; discard retained discussion and restart a consistent read", /Discard all retained discussion text/],
    ["cursor_stale", 409, "The list changed; start again without a cursor", /without a cursor/],
    ["ndjson_required", 415, "Use application/x-ndjson", /NDJSON/],
    ["wake_dead", 409, "This wake is dead; requeue it explicitly.", /[Rr]equeue/],
  ];
  for (const [code, httpStatus, message, recovery] of cases) {
    const ax = agentErrorAx({ httpStatus, code, message });
    assert.doesNotMatch(ax.hint, /^Unknown error/, `${code} must not hit the Unknown fallthrough`);
    assert.match(ax.hint, recovery, `${code} hint must name its catalogued recovery`);
  }
});
