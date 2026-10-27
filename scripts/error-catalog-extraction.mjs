// Shared extraction for the errors-catalog guard
// (tests/errors-catalog-drift.test.js) and the catalog generator
// (scripts/gen-error-catalog.mjs). One extractor, two consumers: the guard
// and the generator must see exactly the same codes, or the catalog drifts
// again behind a green test — the failure this module exists to cure.
//
// The original extractor only matched literal codes handed directly to
// fail()/reject()/new ServiceError()/new AgentPluginError() plus
// `error: { code: "…" }`. Whole emit shapes were invisible to it (verified
// 2026-10-27, clean-slate lane 24 + the job3 cure lane):
//   - local code-forwarding helpers discovered per file from their own
//     definitions (check/refuse/railFail/envelopeFail/gmailFail/stitchError/
//     notFound/require/…): the code is a named parameter, so the extraction
//     is positional — the literal (or ternary of literals, or *_CODE
//     constant) sitting in the definition's `code` parameter slot;
//   - coded error classes (constructor parameter named `code` whose body
//     assigns this.code), and classes with a fixed this.code = "…" literal;
//   - super(status, "code") in ServiceError subclasses
//     (storage_unavailable in server/store.mjs);
//   - codes passed through UPPER_SNAKE constants (CHANNEL_ARCHIVED_CODE,
//     WAKE_SIGNAL_FENCED_CODE, ENVELOPE_CODE, …), including constants
//     defined under src/ (CHANNEL_ARCHIVED_CODE lives in src/events.js and
//     is emitted by server/store.mjs);
//   - fail/reject/ServiceError calls whose code argument is an expression
//     (a ternary of code literals — gmail_not_found — not a bare literal);
//   - divergent envelopes: json(res, NNN, { error: "code" }) where `error`
//     is a plain string (invalid_attention_query, unsupported_grant_type),
//     and { error: { status, code: "…" } } returns with keys before `code`
//     (invalid_proof_query), and { ok: false, …, code: "…" } results
//     (terms_changed);
//   - fallback codes: error.code ?? "code" inside a reject() call
//     (next_actions_error) and `const code = … ? … : "code"`
//     (settlement_failed).
//
// Extraction is deliberately shape-based, never a code allowlist: a new
// code in any of these shapes is seen the day it is written. Codes the
// extractor sees that are verified NOT to reach clients as a response
// error.code are dispositioned in NOT_WIRE_CODES below, each with its
// evidence; the guard fails if a disposition rots (code no longer
// extracted, or code gains a catalog row and must leave the list).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function* walk(dir, exts = [".mjs"]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, exts);
    else if (exts.some(x => e.name.endsWith(x))) yield p;
  }
}

// Split the argument list of a call whose "(" is at openIdx into top-level
// argument strings (quotes, templates and nesting respected).
function callArgs(text, openIdx) {
  let depth = 0, q = null, esc = false;
  const start = openIdx + 1;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (q) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return splitArgs(text.slice(start, i)); }
  }
  return splitArgs(text.slice(start));
}

function splitArgs(s) {
  const args = []; let depth = 0, q = null, esc = false, cur = "";
  for (const c of s) {
    if (q) { cur += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { args.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() || args.length) args.push(cur);
  return args;
}

// String literals that appear at the top level of an expression (a literal
// nested inside another string — e.g. a quoted word inside a message — is
// not a code candidate).
function literals(expr) {
  const out = []; let q = null, esc = false, cur = "";
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (q) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === q) { if (/^[a-z][a-z0-9_]*$/.test(cur)) out.push(cur); q = null; cur = ""; }
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; cur = ""; }
  }
  return out;
}

function paramsList(s) { return splitArgs(s).map(p => p.trim()); }
function codeIndexOf(params) {
  for (let i = 0; i < params.length; i++) if (params[i].split("=")[0].trim() === "code") return i;
  return -1;
}

const cache = new Map();

export function extractLiveCodes(root) {
  if (cache.has(root)) return cache.get(root);
  const codes = new Set();
  const SERVER = join(root, "server");
  const files = [...walk(SERVER)];
  const texts = new Map(files.map(f => [f, readFileSync(f, "utf8")]));

  // --- baseline shapes (the original extractor, unchanged) -------------
  const callRe = /(?:fail|reject)\(\s*(?:"([a-z][a-z0-9_]*)"|'([a-z][a-z0-9_]*)'|(\d{3}))\s*(?:,\s*(?:"([a-z][a-z0-9_]*)"|'([a-z][a-z0-9_]*)'|(\d{3})))?/g;
  const svcRe = /new ServiceError\(\s*(\d{3})\s*,\s*["']([a-z][a-z0-9_]*)["']/g;
  const apRe = /new AgentPluginError\(\s*(\d{3})\s*,\s*["']([a-z][a-z0-9_]*)["']/g;
  const adhocRe = /error:\s*\{\s*code:\s*"([a-z][a-z0-9_]*)"/g;
  for (const f of files) {
    const t = texts.get(f);
    const add = (re, idxs) => { let m; re.lastIndex = 0; while ((m = re.exec(t))) for (const i of idxs) if (m[i]) codes.add(m[i]); };
    add(callRe, [1, 2, 4, 5]); add(svcRe, [2]); add(apRe, [2]); add(adhocRe, [1]);
  }

  // UPPER_SNAKE string constants across server/ and src/ (code constants
  // are defined in both trees; src/events.js defines CHANNEL_ARCHIVED_CODE).
  const constMap = new Map();
  for (const dir of [SERVER, join(root, "src")]) {
    for (const f of walk(dir, [".mjs", ".js"])) {
      const t = readFileSync(f, "utf8");
      for (const m of t.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([a-z][a-z0-9_]*)["']/g)) constMap.set(m[1], m[2]);
    }
  }

  // Coded classes: constructor parameter named `code` + this.code assigned
  // in the class body. Fixed-code classes contribute their literal directly.
  const classCodeIdx = new Map();
  for (const f of files) {
    const t = texts.get(f);
    for (const m of t.matchAll(/class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+[\w$.]+)?\s*\{/g)) {
      const body = t.slice(m.index, m.index + 1200);
      const cm = /constructor\s*\(([^)]*)\)/.exec(body);
      if (cm) { const idx = codeIndexOf(paramsList(cm[1])); if (idx >= 0 && /this\.code\s*=/.test(body)) classCodeIdx.set(m[1], idx); }
    }
    for (const m of t.matchAll(/this\.code\s*=\s*["']([a-z][a-z0-9_]*)["']/g)) codes.add(m[1]);
  }

  // Extract the code carried by one call argument expression: a plain
  // literal, a *_CODE-style constant, or a ternary whose BRANCHES carry
  // literals (the condition does not — fail("x", verb === "cancel" ? …)
  // must not yield "cancel").
  const extractArg = expr => {
    const e = expr.trim();
    let depth = 0, q = null, esc = false, qIdx = -1;
    for (let i = 0; i < e.length; i++) {
      const c = e[i];
      if (q) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "?" && depth === 0 && e[i + 1] !== "." && e[i + 1] !== "?") { qIdx = i; break; }
    }
    if (qIdx >= 0) {
      let d = 0, qq = null, ee = false, nest = 1, cIdx = -1;
      for (let i = qIdx + 1; i < e.length; i++) {
        const c = e[i];
        if (qq) { if (ee) ee = false; else if (c === "\\") ee = true; else if (c === qq) qq = null; continue; }
        if (c === '"' || c === "'" || c === "`") { qq = c; continue; }
        if (c === "(" || c === "[" || c === "{") d++;
        else if (c === ")" || c === "]" || c === "}") d--;
        else if (c === "?" && d === 0) nest++;
        else if (c === ":" && d === 0) { nest--; if (nest === 0) { cIdx = i; break; } }
      }
      if (cIdx > qIdx) { extractArg(e.slice(qIdx + 1, cIdx)); extractArg(e.slice(cIdx + 1)); return; }
    }
    for (const l of literals(e)) codes.add(l);
    if (/^[A-Z][A-Z0-9_]*$/.test(e) && constMap.has(e)) codes.add(constMap.get(e));
  };

  for (const f of files) {
    const t = texts.get(f);
    // super(status, "code") — ServiceError subclasses (storage_unavailable).
    for (const m of t.matchAll(/super\(\s*\d{3}\s*,\s*["']([a-z][a-z0-9_]*)["']/g)) codes.add(m[1]);
    // error: { …, code: "…" } with keys before code (invalid_proof_query).
    for (const m of t.matchAll(/error:\s*\{[^{}]*?\bcode:\s*["']([a-z][a-z0-9_]*)["']/g)) codes.add(m[1]);
    // Divergent string envelope, only at a real HTTP json() site.
    for (const m of t.matchAll(/json\(\s*res\s*,\s*\d{3}\s*,\s*\{\s*error:\s*["']([a-z][a-z0-9_]*)["']/g)) codes.add(m[1]);
    // { ok: false, …, code: "…" } result objects (terms_changed).
    for (const m of t.matchAll(/\bok:\s*false[^{}]{0,80}?\bcode:\s*["']([a-z][a-z0-9_]*)["']/g)) codes.add(m[1]);
    // .code = "…" assignments.
    for (const m of t.matchAll(/\.code\s*=\s*["']([a-z][a-z0-9_]*)["']/g)) codes.add(m[1]);
    // const code = … ? … : "…" fallback (settlement_failed).
    for (const m of t.matchAll(/(?:const|let)\s+code\s*=[^;]*\?\s*[^:;]+:\s*["']([a-z][a-z0-9_]*)["']/g)) codes.add(m[1]);
    // fail/reject with an expression in a code slot (ternary codes,
    // error.code ?? "fallback" in slot 1, *_CODE constants).
    for (const m of t.matchAll(/(?<![\w$.])(?:fail|reject)\s*\(/g)) {
      const args = callArgs(t, t.indexOf("(", m.index));
      for (let i = 0; i < Math.min(2, args.length); i++) extractArg(args[i]);
    }
    // ServiceError / AgentPluginError with an expression code at slot 1.
    for (const m of t.matchAll(/new\s+(?:ServiceError|AgentPluginError)\s*\(/g)) {
      const args = callArgs(t, t.indexOf("(", m.index));
      if (args[1]) extractArg(args[1]);
    }
    // Coded classes: new ClassName(…, "code", …) at the constructor's
    // code position.
    for (const [name, idx] of classCodeIdx) {
      const re = new RegExp(`new\\s+${name}\\s*\\(`, "g"); let mm;
      while ((mm = re.exec(t))) { const args = callArgs(t, t.indexOf("(", mm.index)); if (args[idx]) extractArg(args[idx]); }
    }
    // Local code-forwarding helpers, discovered from their definitions in
    // this file: a parameter named `code` whose body forwards that code
    // onward (throw / a *Fail-style call carrying code / error.code / super).
    const helpers = new Map();
    const consider = (name, params, body) => {
      const idx = codeIndexOf(params); if (idx < 0) return;
      if (!/(throw|[A-Za-z_$][\w$]*\s*\([^)]*\bcode\b|error\.code|\.code\s*=|super\s*\()/.test(body)) return;
      if (!/\bcode\b/.test(body)) return;
      helpers.set(name, idx);
      const def = params[idx].split("=").slice(1).join("=");
      if (def) for (const l of literals(def)) codes.add(l);
    };
    let m;
    const arrowRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{([\s\S]{0,400}?)\n?\s*\};?/g;
    while ((m = arrowRe.exec(t))) consider(m[1], paramsList(m[2]), m[3]);
    const arrowRe2 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*([^\n;]{0,200})/g;
    while ((m = arrowRe2.exec(t))) consider(m[1], paramsList(m[2]), m[3]);
    const arrowRe3 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*\{([\s\S]{0,400}?)\}/g;
    while ((m = arrowRe3.exec(t))) consider(m[1], [m[2]], m[3]);
    const arrowRe4 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*([^\n;{]{0,200})/g;
    while ((m = arrowRe4.exec(t))) consider(m[1], [m[2]], m[3]);
    const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{([\s\S]{0,400}?)\n\s*\}/g;
    while ((m = fnRe.exec(t))) consider(m[1], paramsList(m[2]), m[3]);
    const methodRe = /(?:^|\n)\s+(?:async\s+)?(_?[A-Za-z][\w$]*)\(([^)]*)\)\s*\{([\s\S]{0,500})/g;
    while ((m = methodRe.exec(t))) consider(m[1], paramsList(m[2]), m[3]);
    for (const [name, idx] of helpers) {
      if (name === "fail" || name === "reject") continue; // covered above
      const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g"); let mm;
      while ((mm = re.exec(t))) { const args = callArgs(t, t.indexOf("(", mm.index)); if (args[idx] !== undefined) extractArg(args[idx]); }
    }
  }
  cache.set(root, codes);
  return codes;
}

// Codes the extractor sees that are verified NOT to reach clients as a
// response error.code, each with the evidence. A code belongs here only
// while that evidence holds: the guard fails if a listed code is no
// longer extracted (stale disposition) or gains a catalog row (then it
// is wire after all and the disposition must be deleted). Verified
// 2026-10-27 against main 927a642029 + PR #5016 (job3 cure lane),
// building on clean-slate lane 24's vetted non-gap classes.
export const NOT_WIRE_CODES = new Map([
  // Session-adapter / bridge surface: server/session-adapter/** is not
  // imported by server/http.mjs; the bridge has its own doc
  // (server/session-adapter/BRIDGE-API.md).
  ["bridge_down", "session-adapter internal (this.code fixed literal); adapter surface, own BRIDGE-API.md doc"],
  // GitHub App integration layer: GitHubAppError codes are consumed by
  // internal repo/claim sync paths; no route conversion emits them.
  ["config_failed", "GitHub App internal (github-app/); no route conversion"],
  ["invalid_installation", "GitHub App internal (github-app/); no route conversion"],
  ["invalid_repo", "GitHub App internal (github-app/); no route conversion"],
  ["not_configured", "GitHub App internal (github-app/); no route conversion"],
  ["token_failed", "GitHub App internal (github-app/); no route conversion"],
  // Boot-time instance lock: thrown before the process ever serves.
  ["instance_lock_held", "boot-time instance lock (instance-lock.mjs); process never serves"],
  ["instance_lock_io", "boot-time instance lock (instance-lock.mjs); process never serves"],
  // Programmer-contract validation (constructors / factory options /
  // internal callbacks), thrown at construction time, never per request.
  ["invalid_retention_run", "RetentionRunError constructor contract (retention-run.mjs)"],
  ["invalid_store", "identity-verification factory-option contract; thrown at store construction"],
  ["invalid_clock", "identity-verification factory-option contract; thrown at store construction"],
  ["invalid_authority", "feedback-store authority-option contract; thrown at store construction"],
  ["invalid_heartbeat_config", "AgentHeartbeats constructor contract (staleAfterMs option)"],
  ["invalid_wake_waiter", "AgentHeartbeats internal callback contract (onWake is server-supplied)"],
  // Channel contract layer: ContractError codes from
  // server/channel-connection.mjs and server/email-envelope.mjs are
  // converted by every consumer (invalid_channel_update at
  // channel-import, invalid_inbox_source / invalid_email_import at
  // inbox/email-import, or swallowed to a boolean); the original code
  // never reaches the wire.
  ["invalid_channel_capabilities", "channel-connection ContractError; converted by consumers"],
  ["invalid_channel_participant", "channel-connection ContractError; converted by consumers"],
  ["invalid_email_connection", "channel-connection ContractError; converted by consumers"],
  ["unsupported_channel", "channel-connection ContractError; converted by consumers"],
  ["duplicate_email_attachment", "email-envelope ContractError; converted by consumers"],
  ["email_attachment_observation_conflict", "email-envelope ContractError; converted by consumers"],
  ["email_input_limit", "email-envelope ContractError; converted by consumers"],
  ["email_recipient_limit", "email-envelope ContractError; converted by consumers"],
  ["email_reply_needs_recipient", "email-envelope ContractError; converted by consumers"],
  ["email_reply_unavailable", "email-envelope ContractError; converted by consumers"],
  ["email_version_mismatch", "email-envelope ContractError; converted by consumers"],
  ["unsupported_email_address", "email-envelope ContractError; converted by consumers"],
  ["unsupported_email_reply_options", "email-envelope ContractError; converted by consumers"],
  // Merge queue: server/merge-queue.mjs is consumed only by
  // scripts/merge-queue-* operator tooling and tests.
  ["merge_queue_busy", "merge-queue.mjs: operator tooling only, no server route"],
  ["merge_queue_forbidden", "merge-queue.mjs: operator tooling only, no server route"],
  ["merge_queue_invalid_input", "merge-queue.mjs: operator tooling only, no server route"],
  ["merge_queue_unknown_entry", "merge-queue.mjs: operator tooling only, no server route"],
  // Push delivery internals: thrown inside delivery/payload building,
  // never in the subscription request path (contrast the rowed
  // push_endpoint_*/push_key_* request-path codes).
  ["push_fetch_unavailable", "push delivery-internal (web-push delivery path only)"],
  ["push_payload_room_required", "push delivery-internal (payload building only)"],
  ["push_payload_too_large", "push delivery-internal (payload building only)"],
  // Diagnostic / result records, not response error.code values.
  ["room_read_failed", "owner-overview diagnostics record code, not a response code"],
  ["email_routing_not_accepted", "inbound email-routing worker rejection, not an HTTP response code"],
  // Converted at the only route consumer: matchmaking-routes guard()
  // maps every status-less LaneError to 422 invalid_matchmaking_input
  // (tests/matchmaking-routes.test.js: 'bad input is 422 and never a
  // 500'). The LaneError code itself never reaches the wire.
  ["authority_mismatch", "LaneError converted by matchmaking guard to invalid_matchmaking_input"],
  ["decision_expired", "LaneError converted by matchmaking guard to invalid_matchmaking_input"],
  ["missing_author", "LaneError converted by matchmaking guard to invalid_matchmaking_input"],
  ["not_a_courier", "LaneError converted by matchmaking guard to invalid_matchmaking_input"],
  // Swallowed per row: openingsFromRows catches DeclarationError and
  // skips the row, so not_matchable never surfaces as a response code.
  ["not_matchable", "DeclarationError swallowed per-row by openingsFromRows (work-declarations.mjs)"],
]);
