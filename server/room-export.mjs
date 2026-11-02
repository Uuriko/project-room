// Durable Object export. The on-disk server copies its sqlite file
// (scripts/backup-room.mjs). A Durable Object cannot hand that file out, so
// this streams the same store as NDJSON and replays it into a fresh file.
// The secret columns named in EXPORT_SECRET_COLUMNS and raw secret shapes
// inside other cells (see the patterns at TOKEN_SOURCE) are sha256 hex.
// Everything else round-trips verbatim.
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RoomStore, INTEGRITY_FAILURES_SCHEMA } from "./store.mjs";
import { wakeListenerLeaseSchema, wakeRoomActivitySchema } from "./agent-heartbeats.mjs";
import { PATROL_SCHEMA } from "./patrol.mjs";
import { PROJECT_MAP_SCHEMA, PROJECT_MAP_TABLES } from "./project-map-store.mjs";
import { PROJECTION_SHAPE_UPGRADES_SCHEMA } from "./legacy-message-shape.mjs";
import { auditRecovery } from "./recovery.mjs";
import { Buffer } from "node:buffer";
import { ensureOAuthProviderSchema, OAUTH_PROVIDER_TABLES } from "./oauth-provider-store.mjs";
import { ensureMcpInviteOAuthSchema, inviteOAuthDatabase } from "./mcp-invite-oauth.mjs";
import { mcpEventSubscriptionsSchema } from "./mcp-event-subscriptions.mjs";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const TOKEN_SOURCE = "(?:pri_|rak_|ga1\\.)[A-Za-z0-9_-]{8,}";
// L08-C5: TOKEN_SOURCE alone left every other common secret shape in an
// export verbatim — GitHub/vendor tokens, AWS key ids, Bearer/Basic
// credentials, JWTs, PEM blocks, credential assignments
// (password=<redacted> / "token": "…") and Cookie/Set-Cookie header values all
// passed through. The patterns below close those shapes; every match is
// replaced by the sha256 hex of the secret part, the same treatment
// TOKEN_SOURCE matches have always had, so a scrubbed export stays
// correlatable without carrying the credential.
const VENDOR_TOKEN_SOURCE = "(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[baprs]-|sk-(?:proj|svcacct)-|sk-ant-|(?:sk|rk)_(?:live|test)_)[A-Za-z0-9_-]{8,}";
// F1-Q1 cure (stacked on L08-C5): the shapes a non-author recheck still
// found verbatim at the L08-C5 head — legacy OpenAI keys (sk- + a long
// alphanumeric run; the hyphenated sk-live-… non-shape stays untouched
// because the run stops at the first hyphen), SendGrid, npm, Vault and
// Telegram bot tokens, and the bare AWS secret access key (exactly 40
// base64-alphabet chars with mixed case and a digit — a 40-char hex
// digest has no uppercase and is not matched).
const OPENAI_LEGACY_SOURCE = "sk-[A-Za-z0-9]{20,}";
const SENDGRID_SOURCE = "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}";
const NPM_SOURCE = "npm_[A-Za-z0-9]{30,}";
const VAULT_SOURCE = "hvs\\.[A-Za-z0-9_-]{8,}";
const TELEGRAM_SOURCE = "\\b\\d{5,}:[A-Za-z0-9_-]{30,}";
// Anchored at run starts (previous char is not in the class) so the
// mixed-case check in the replacer runs once per 40-char run, not once
// per character — an unbounded lookahead version was quadratic on
// long base64-ish prose.
const AWS_SECRET_RE = /(^|[^A-Za-z0-9/+=])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g;
const AWS_KEY_SOURCE = "(?:AKIA|ASIA)[0-9A-Z]{16}";
// A JWT's signature segment is optional in the wild (alg=none and
// truncated copies still expose the payload), so the third segment is
// optional and segments may be as short as 4 chars.
const JWT_SOURCE = "eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}(?:\\.[A-Za-z0-9_-]{4,})?";
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
// The capture also stops at a double quote (F1-Q6 D9): in the
// whole-store NDJSON path the "string" is a whole JSON document on one
// line, and an unbounded capture swallowed every field after a Cookie:
// string, producing truncated, unrestorable rows. Trade-off: a cookie
// value containing a literal quote in a flat prose cell is now hashed
// only up to that quote — accepted, because in NDJSON text the quote is
// structural and quoted cookie values in prose are the rarer case.
const COOKIE_HEADER_RE = /\b(Set-Cookie|Cookie)(\s*:\s*)([^\r\n"]+)/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
// Slack webhook URLs carry their secret as the last path segment; only
// that segment is hashed, so the hook's team/channel ids stay readable.
const SLACK_WEBHOOK_RE = /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/)([A-Za-z0-9_-]{8,})/g;
// URL userinfo (https://user:pass@host, postgres://user:pass@host, any
// scheme://user:pass@host connection string): the password between the
// first ":" and the "@" is hashed; scheme, user and host stay readable.
// The scheme is length-bounded: unbounded, the scheme character class
// backtracked across every long alphanumeric run in a cell (quadratic
// on the multi-hundred-KB strings exports routinely carry).
const URL_USERINFO_RE = /([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}:)([^\s/@]{4,})(@)/g;
// Credential assignments. Two value forms:
// - quoted ("password=\"p@ss,word;x\"", "\"password\": \"correct horse\""):
//   everything up to the matching quote is the value, spaces and , ;
//   delimiters included — the L08-C5 class stopped at the first space or
//   delimiter and leaked the tail of exactly the most realistic
//   passwords.
// - unquoted (password=correct horse battery staple): space-separated
//   chunks, where a chunk may itself contain , or ; when flanked by
//   non-space characters; the value ends at a , ; " ' } ] < & or
//   newline that is not inside a chunk.
// Key names gain passphrase, dbPass and the AWS secret-access-key name.
const ASSIGNMENT_RE = /\b(passphrase|db[_-]?pass|password|passwd|pwd|api[_-]?key|apikey|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id|sessionid|session|secret|token|cookie|sid)(?:(\s*[:=]\s*|["']\s*[:=]\s*)(["'])((?:(?!\3)[\s\S]){4,}?)\3|(["']?\s*[:=]\s*["']?)((?:[^\s"',;}\]<&]+(?:[,;][^\s"',;}\]<&]+)*)(?: (?:[^\s"',;}\]<&]+(?:[,;][^\s"',;}\]<&]+)*))*))/gi;
// Key names whose string values are credentials by position, however the
// value is shaped (a bare password or session id matches no pattern
// above). Matched on name parts, so "author" is not a credential key
// while "accessToken" and "session_id" are.
const SECRET_KEY_PARTS = new Set(["password", "passwd", "pwd", "passphrase", "pass", "dbpass", "private", "privatekey", "secret", "token", "credential", "credentials", "authorization", "cookie", "session", "sessionid", "sid", "apikey"]);

function isSecretKey(key) {
  const parts = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return parts.some(part => SECRET_KEY_PARTS.has(part)) || parts.join("").includes("apikey");
}
const FIRST = ["accounts", "rooms", "events", "commands", "member_accounts", "account_access_events", "credentials", "account_credentials", "account_session_slots", "cursors", "projection_checkpoints"];

const sha256Hex = value => createHash("sha256").update(value).digest("hex");

function quoteIdent(name) {
  if (!IDENT.test(name)) throw new Error("Export names a table or column this store will not write");
  return `"${name}"`;
}

// #3599: the columns whose values are secret material, named exactly per
// table. Exports replace them with a sha256 placeholder; restores never
// load the placeholder as a live value (see createSanitizedCellTracker).
// This exact set replaces a name regex that also hashed two columns
// holding no secrets at all — accounts.password_reset_required (an
// INTEGER 0/1 flag) and bounty_records.verifier (a member lane id:
// approval authority) — silently corrupting both on every restore. A
// column joins this set only by being named here, never by matching a
// name pattern. Already-hashed columns (hash, *_hash) are digests, not
// secrets, and round-trip as they are; auth_epoch is a counter.
export const EXPORT_SECRET_COLUMNS = Object.freeze({
  account_login_methods: Object.freeze(["verifier"]),
  agent_push_configs: Object.freeze(["push_token"]),
  agent_webhook_subs: Object.freeze(["secret"]),
  gmail_linked_mailboxes: Object.freeze(["encrypted"]),
  gmail_mailboxes: Object.freeze(["encrypted"]),
  gmail_pending: Object.freeze(["encrypted"]),
  human_push_subscriptions: Object.freeze(["auth", "p256dh"]),
  // The callback document contains current and previous signing secrets.
  mcp_event_subscriptions: Object.freeze(["document"]),
  oauth_pending_states: Object.freeze(["slot_token", "verifier"]),
  public_rooms: Object.freeze(["join_token"]),
  referral_invite_keys: Object.freeze(["private_seed"])
});
const SECRET_COLUMN_SETS = new Map(Object.entries(EXPORT_SECRET_COLUMNS)
  .map(([table, columns]) => [table, new Set(columns)]));

export function isExportSecretColumn(table, column) {
  return SECRET_COLUMN_SETS.get(table)?.has(column) ?? false;
}

// Watermark marker for exports written under the exact policy above.
// Streams without it were written by the pre-#3599 name-regex exporter
// and are "legacy" to every restore (see createSanitizedCellTracker).
export const BACKUP_SANITIZE_POLICY = 2;

// A token split by zero-width characters (a common paste artefact) is
// not byte-valid as pasted, but its suffix still identifies the
// credential. Match the known token prefixes tolerating zero-width
// chars inside the run and hash the rejoined value, so the hash equals
// the unsplit token's hash.
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\uFEFF]/g;
const ZERO_WIDTH_ANY = /[\u200B\u200C\u200D\uFEFF]/;
const zwspTolerant = source => source.replaceAll("[A-Za-z0-9_-]", "[A-Za-z0-9_\\-\\u200B\\u200C\\u200D\\uFEFF]");
const SPLIT_TOKEN_RE = new RegExp(`(?:${zwspTolerant(TOKEN_SOURCE)}|${zwspTolerant(VENDOR_TOKEN_SOURCE)})`, "g");

function scrubTokens(value) {
  let out = value.replace(PEM_RE, match => sha256Hex(match));
  out = out.replace(SPLIT_TOKEN_RE, match => ZERO_WIDTH_ANY.test(match) ? sha256Hex(match.replace(ZERO_WIDTH_CHARS, "")) : match);
  out = out.replace(COOKIE_HEADER_RE, (_match, name, separator, headerValue) => `${name}${separator}${sha256Hex(headerValue.trim())}`);
  out = out.replace(AUTH_SCHEME_RE, (_match, scheme, separator, token) => `${scheme}${separator}${sha256Hex(token)}`);
  out = out.replace(SLACK_WEBHOOK_RE, (_match, prefix, secret) => `${prefix}${sha256Hex(secret)}`);
  out = out.replace(URL_USERINFO_RE, (_match, prefix, secret, at) => `${prefix}${sha256Hex(secret)}${at}`);
  out = out.replace(ASSIGNMENT_RE, (match, name, quotedSeparator, quote, quotedSecret, plainSeparator, plainSecret) => {
    if (quotedSecret !== undefined) return `${name}${quotedSeparator}${quote}${sha256Hex(quotedSecret)}${quote}`;
    if (plainSecret !== undefined && plainSecret.length >= 4) return `${name}${plainSeparator}${sha256Hex(plainSecret)}`;
    return match;
  });
  out = out.replace(new RegExp(JWT_SOURCE, "g"), match => sha256Hex(match));
  out = out.replace(new RegExp(`(?:${TOKEN_SOURCE}|${VENDOR_TOKEN_SOURCE}|${AWS_KEY_SOURCE}|${OPENAI_LEGACY_SOURCE}|${SENDGRID_SOURCE}|${NPM_SOURCE}|${VAULT_SOURCE}|${TELEGRAM_SOURCE})`, "g"), match => sha256Hex(match));
  out = out.replace(AWS_SECRET_RE, (match, prefix, token) => /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token) ? `${prefix}${sha256Hex(token)}` : match);
  return out;
}

// Under a credential-named key the whole string value is the secret, so it
// is hashed whole at any depth instead of being pattern-matched.
function scrubSecretValue(value) {
  if (typeof value === "string") return value ? sha256Hex(value) : value;
  if (Array.isArray(value)) return value.map(item => scrubSecretValue(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[scrubTokens(key)] = scrubSecretValue(item);
    return out;
  }
  return value;
}

// MGMT-PANEL Slice 1 (MF-7): the recursive counterpart of scrubTokens for
// parsed event JSON. scrubTokens above works on one flat string cell of the
// whole-store NDJSON export; an event log is nested JSON, so the operator
// per-room export walks objects, arrays, string values and string keys and
// applies the same scrub at any depth. Coverage is the product's own token
// shapes plus the common credential shapes named at TOKEN_SOURCE above
// (vendor tokens, AWS key ids, Bearer/Basic credentials, JWTs, PEM blocks,
// credential assignments and cookie headers), and any string value sitting
// under a credential-named key. It is still a shape denylist, not a proof
// that no secret remains: an unshaped secret in prose can pass through.
export function scrubEventTokens(value) {
  if (typeof value === "string") return scrubTokens(value);
  if (Array.isArray(value)) return value.map(item => scrubEventTokens(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[scrubTokens(key)] = isSecretKey(key) ? scrubSecretValue(item) : scrubEventTokens(item);
    return out;
  }
  return value;
}

// F1-Q6 cell-path parity: a string cell usually carries a whole JSON
// document as text, where the flat scrubTokens has no key context — a
// bare value, an array, or a nested object under a credential-named key
// matched no pattern and left verbatim (D1–D7), while the event path
// whole-hashes it. This scanner restores the key context at text level:
// it finds "<key>" : spans, unescapes the key (JSON.parse of the quoted
// token) and tests it with the same isSecretKey as the event path; on a
// hit it consumes the complete following JSON value (escape-aware
// string, balanced array/object) and replaces it with
// scrubSecretValue of its parsed form — hashes computed over the
// unescaped string, exactly as the event path computes them, so the
// same secret hashes identically in both exports. Numbers, booleans
// and null under a secret key are left as-is in both paths (a shared
// residual, named in the PR body; not a parity gap). The scanner runs
// BEFORE scrubTokens so ASSIGNMENT_RE never fragment-hashes a quoted
// value the whole-value rule owns, and all text outside consumed spans
// keeps the exact flat-pattern behaviour. Malformed values are left to
// scrubTokens rather than throwing. Consequence imported from the
// event path by design (D13): innocuous strings sitting under a
// credential-named container are whole-hashed in the cell path too —
// position is treated as credential, as scrubSecretValue already does.
function scanJsonStringEnd(text, start) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

function scanJsonValueEnd(text, start) {
  if (text[start] === '"') return scanJsonStringEnd(text, start);
  if (text[start] === "{" || text[start] === "[") {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        const end = scanJsonStringEnd(text, i);
        if (end === -1) return -1;
        i = end - 1;
      } else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  const primitive = /^[^\s,}\]]+/.exec(text.slice(start));
  return primitive ? start + primitive[0].length : -1;
}

const ASSIGNMENT_TAIL_RE = /\b(passphrase|db[_-]?pass|password|passwd|pwd|api[_-]?key|apikey|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id|sessionid|session|secret|token|cookie|sid)\s*[:=]\s*$/i;

function bestEffortUnescape(content) {
  try { return JSON.parse(`"${content}"`); } catch { /* fall through */ }
  return content.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, esc) => esc.startsWith("u")
    ? String.fromCharCode(parseInt(esc.slice(1), 16))
    : ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" })[esc] ?? esc);
}

function hashMalformedSecretValue(span) {
  if (span.startsWith('"')) return `"${sha256Hex(bestEffortUnescape(span.slice(1)))}"`;
  return span
    .replace(/"((?:\\.|[^"\\])*)"/g, (_m, inner) => `"${sha256Hex(bestEffortUnescape(inner))}"`)
    .replace(/"([^"]*)$/, (_m, inner) => `"${sha256Hex(bestEffortUnescape(inner))}"`);
}

function scrubCellText(text) {
  if (!text.includes('"')) return scrubTokens(text);
  const chunks = [];
  let plainFrom = 0;
  let i = 0;
  const flushPlain = upto => { if (upto > plainFrom) chunks.push(scrubTokens(text.slice(plainFrom, upto))); };
  while (i < text.length) {
    const quote = text.indexOf('"', i);
    if (quote === -1) break;
    const keyEnd = scanJsonStringEnd(text, quote);
    if (keyEnd === -1) break;
    let colon = keyEnd;
    while (colon < text.length && /\s/.test(text[colon])) colon++;
    if (text[colon] !== ":") {
      // A value string, not a key: scrub its UNESCAPED content, so the
      // flat patterns see real quotes and newlines instead of \" and
      // \n (in raw JSON text an escaped quote truncates the assignment
      // capture at the backslash and an escaped newline defeats the
      // word boundary before a following credential name — both leaked).
      // Re-escaped with JSON.stringify only when the scrub changed it;
      // an unchanged string keeps its original bytes.
      let content = null;
      try { content = JSON.parse(text.slice(quote, keyEnd)); } catch { content = null; }
      if (typeof content === "string") {
        flushPlain(quote);
        // Flat-prose guard: if the plain text just flushed ends with a
        // credential assignment awaiting its quoted value
        // (password="…"), this string IS that value — hash it whole
        // instead of pattern-scrubbing its content standalone, which
        // would sever name from value and leak it.
        if (ASSIGNMENT_TAIL_RE.test(text.slice(Math.max(plainFrom, quote - 80), quote))) {
          chunks.push(`"${sha256Hex(content)}"`);
        } else {
          const scrubbed = scrubTokens(content);
          chunks.push(scrubbed === content ? text.slice(quote, keyEnd) : JSON.stringify(scrubbed));
        }
        plainFrom = keyEnd;
      }
      i = keyEnd;
      continue;
    }
    let key = null;
    try { key = JSON.parse(text.slice(quote, keyEnd)); } catch { key = null; }
    if (typeof key !== "string" || !isSecretKey(key)) { i = colon + 1; continue; }
    let valueStart = colon + 1;
    while (valueStart < text.length && /\s/.test(text[valueStart])) valueStart++;
    const valueEnd = scanJsonValueEnd(text, valueStart);
    if (valueEnd === -1) {
      // Malformed cell (unterminated string / unbalanced brackets)
      // under a credential key: fail closed — hash the value content
      // to end-of-cell instead of letting it pass to the flat patterns,
      // which cannot bound an unterminated value.
      flushPlain(valueStart);
      chunks.push(hashMalformedSecretValue(text.slice(valueStart)));
      plainFrom = text.length;
      i = text.length;
      break;
    }
    const span = text.slice(valueStart, valueEnd);
    let replacement = span;
    if (span.startsWith('"') || span.startsWith("[") || span.startsWith("{")) {
      try { replacement = JSON.stringify(scrubSecretValue(JSON.parse(span))); } catch { replacement = span; }
    }
    // The key, colon and spacing stay in the plain stream; the consumed
    // value span is emitted as the scanner's replacement and is NOT
    // re-run through scrubTokens (which would hash the hash and break
    // correlation with the event path's whole-value hash).
    flushPlain(valueStart);
    chunks.push(replacement);
    i = valueEnd;
    plainFrom = valueEnd;
  }
  flushPlain(text.length);
  return chunks.join("");
}

export function sanitizeCell(table, column, value) {
  if (value === null || value === undefined) return null;
  if (isExportSecretColumn(table, column)) return sha256Hex(typeof value === "string" ? value : String(value));
  // REL-14: BLOB cells (room file bytes) leave as base64. JSON.stringify of a
  // Uint8Array is an object of indices that replay could not bind, so any room
  // holding a file produced an export that could not be restored.
  // A Durable Object's SQL API returns BLOB cells as ArrayBuffer, not
  // Uint8Array, and JSON.stringify(ArrayBuffer) is {}: every room file's
  // bytes left production backups as an empty object until this was handled.
  if (value instanceof Uint8Array) return { $base64: Buffer.from(value).toString("base64") };
  if (value instanceof ArrayBuffer) return { $base64: Buffer.from(new Uint8Array(value)).toString("base64") };
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
    return { $base64: Buffer.from(new Uint8Array(value)).toString("base64") };
  if (ArrayBuffer.isView(value)) return { $base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  // D8: a caller handing sanitizeCell a parsed object/array gets the
  // event path's scrub, not a silent passthrough. (Current SQL callers
  // only pass string/number/null/BLOB cells; JSON arrives as a string
  // and is handled below.)
  if (value && typeof value === "object") return scrubEventTokens(value);
  if (typeof value !== "string") return value;
  return scrubCellText(value);
}
function sanitizeRow(table, row) {
  const out = {};
  for (const [column, value] of Object.entries(row)) out[column] = sanitizeCell(table, column, value);
  return out;
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => row.name).filter(name => IDENT.test(name));
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(column => column.name);
}

function exportTableOrder(db) {
  const present = new Set(tableNames(db));
  const ordered = FIRST.filter(table => present.has(table));
  for (const table of [...present].sort()) if (!ordered.includes(table)) ordered.push(table);
  return ordered;
}

// Tables read in keyset pages, never in one .all(): a table dump would
// otherwise hold every row, including every file and message body, in memory
// at once. Pages use .all() because the Durable Object database adapter has no
// iterate(). Row order matches the old unpaged SELECT (rowid order, and the
// parent-first order for credentials), so the output bytes do not change.
// Tables holding large cells use small pages.
const EXPORT_PAGE_ROWS = 500;
const EXPORT_PAGE_ROWS_BY_TABLE = Object.freeze({ room_attachments: 4, events: 100 });

function* exportTableRows(db, table, columns, pageRows) {
  const list = columns.map(quoteIdent).join(", ");
  const name = quoteIdent(table);
  const limit = Math.max(1, Math.min(pageRows, EXPORT_PAGE_ROWS_BY_TABLE[table] ?? pageRows));
  if (table === "credentials" && columns.includes("parent_hash")) {
    // hash is the primary key, so (parent_hash IS NOT NULL, hash) is a unique key.
    const page = db.prepare(`SELECT ${list}, (parent_hash IS NOT NULL) AS "__k" FROM ${name}
      WHERE (parent_hash IS NOT NULL) > ? OR ((parent_hash IS NOT NULL) = ? AND hash > ?)
      ORDER BY parent_hash IS NOT NULL, hash LIMIT ?`);
    let k = -1;
    let hash = "";
    for (;;) {
      const rows = page.all(k, k, hash, limit);
      for (const { __k, ...row } of rows) yield row;
      if (rows.length < limit) return;
      ({ __k: k, hash } = rows.at(-1));
    }
  }
  const withoutRowid = /WITHOUT\s+ROWID/i.test(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql ?? "");
  if (withoutRowid || columns.some(column => column.toLowerCase() === "rowid")) {
    // No rowid to page on: read the table whole, as before.
    yield* db.prepare(`SELECT ${list} FROM ${name}`).all();
    return;
  }
  const page = db.prepare(`SELECT rowid AS "__rid", ${list} FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
  let after = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const rows = page.all(after, limit);
    for (const { __rid, ...row } of rows) yield row;
    if (rows.length < limit) return;
    after = rows.at(-1).__rid;
  }
}

export function* exportNdjsonLines(db, { pageRows = EXPORT_PAGE_ROWS } = {}) {
  const rooms = db.prepare("SELECT id, sequence FROM rooms ORDER BY id").all();
  const events = db.prepare("SELECT count(*) AS n FROM events").get().n;
  yield JSON.stringify({ kind: "watermark", version: 1, sanitizePolicy: BACKUP_SANITIZE_POLICY, backedUpAt: Date.now(), rooms, events }) + "\n";
  // #3325: pin every loadable table's content in the trailer, accumulated
  // over the sanitized rows exactly as they are yielded below.
  const digests = createTableDigests();
  for (const table of exportTableOrder(db)) {
    const columns = tableColumns(db, table);
    if (!columns.length) continue;
    for (const row of exportTableRows(db, table, columns, pageRows)) {
      const sanitized = sanitizeRow(table, row);
      digests.add(table, sanitized);
      yield JSON.stringify({ table, row: sanitized }) + "\n";
    }
  }
  yield JSON.stringify(exportTrailer(db, digests.finish())) + "\n";
}

// End-of-stream integrity trailer. The watermark is taken before the first
// table is dumped, but the Durable Object serves requests between stream
// pulls, so a write can land mid-stream. The watermark's event count does not
// always see it: a write whose event row misses the events scan but whose
// side effects land in a later-scanned table keeps the dumped count equal to
// the watermark while the data is inconsistent (a torn backup that used to
// replay with verified:true). The trailer re-reads the event log after the
// last table, so replay can refuse a torn export loudly. The hash is over the
// sanitized cells, exactly as the rows were yielded, so a future sanitize
// rule cannot cause a false mismatch. Rooms need no trailer: a room created
// mid-stream fails the events foreign key, and any other room tear moves the
// event count.
const TRAILER_PAGE_ROWS = 2000;
export function exportTrailer(db, tables = null) {
  // Keyset pages, not one .all(): a room with many events would otherwise hold
  // every row in memory at the end of each export. Pages use .all() because the
  // Durable Object database adapter has no iterate().
  const page = db.prepare("SELECT room_id, sequence, id FROM events WHERE room_id > ? OR (room_id = ? AND sequence > ?) ORDER BY room_id, sequence LIMIT ?");
  const hash = createHash("sha256");
  let count = 0;
  let roomId = "";
  let sequence = -1;
  for (;;) {
    const rows = page.all(roomId, roomId, sequence, TRAILER_PAGE_ROWS);
    for (const row of rows) {
      hash.update(`${sanitizeCell("events", "room_id", row.room_id)}\t${sanitizeCell("events", "sequence", row.sequence)}\t${sanitizeCell("events", "id", row.id)}\n`);
    }
    count += rows.length;
    if (rows.length < TRAILER_PAGE_ROWS) break;
    ({ room_id: roomId, sequence } = rows.at(-1));
  }
  const trailer = { kind: "trailer", version: 1, events: count, eventsHash: hash.digest("hex") };
  // Trailer version 2 carries the per-table content digests (#3325). A
  // caller that cannot supply them (a bare event-log read) still gets a
  // version 1 trailer, which restores report at the weaker level.
  if (tables && Object.keys(tables).length) {
    trailer.version = 2;
    trailer.tables = tables;
  }
  return trailer;
}

// Refuses a torn export: the parsed event rows must be exactly the event log
// the trailer saw at end of stream. Older exports have no trailer and replay
// as before (the caller reports trailer: "absent").
export function verifyTrailer(trailer, byTable) {
  const rows = byTable.get("events") ?? [];
  if (rows.length !== trailer.events)
    throw new Error(`Backup is torn: the export holds ${rows.length} events but its trailer counts ${trailer.events}; a write landed mid-export. Re-take the backup.`);
  const tuples = rows.map(row => [row.room_id, row.sequence, row.id]);
  tuples.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const hash = createHash("sha256");
  for (const [roomId, sequence, id] of tuples) hash.update(`${roomId}\t${sequence}\t${id}\n`);
  if (hash.digest("hex") !== trailer.eventsHash)
    throw new Error("Backup is torn: the event log changed during the export (same count, different rows). Re-take the backup.");
  return true;
}

// #3325: the trailer above pins only the event log, so a tampered or
// corrupted non-event row — a credential's expiry, a revoked flag, an
// account's active bit — restored as verified. Trailer version 2 also pins
// every table a restore can load: a sha256 over the sanitized rows exactly
// as yielded (the same treatment the event hash gives event cells), plus
// the row count. Tables no restore path ever loads are excluded on both
// sides: the DO runtime markers and retired tables in REPLAY_SKIPPED_TABLES,
// the claim writer permit (the target's own authority, never the export's),
// and Cloudflare-internal _cf_ tables. (The set itself is defined with
// REPLAY_SKIPPED_TABLES below.)
function contentDigestSkipped(table) {
  return table.startsWith("_cf_") || CONTENT_DIGEST_SKIPPED_TABLES.includes(table);
}

export function createTableDigests() {
  const tables = new Map();
  return {
    add(table, row) {
      if (contentDigestSkipped(table)) return;
      let entry = tables.get(table);
      if (!entry) {
        entry = { hash: createHash("sha256"), rows: 0 };
        tables.set(table, entry);
      }
      entry.hash.update(`${JSON.stringify(row)}\n`);
      entry.rows += 1;
    },
    finish() {
      const out = {};
      for (const [table, entry] of tables) out[table] = { rows: entry.rows, sha256: entry.hash.digest("hex") };
      return out;
    }
  };
}

export function tableDigestsOf(byTable) {
  const digests = createTableDigests();
  for (const [table, rows] of byTable) for (const row of rows) digests.add(table, row);
  return digests.finish();
}

// The restore's content-verification level for a parsed export, named so a
// weaker legacy export never reports the same bare "verified" as a fully
// pinned one: "full" (trailer v2 table digests verified), "events-only"
// (trailer v1: only the event log is pinned), "watermark-only" (no
// trailer at all). Throws when a pinned digest disagrees with the rows the
// export actually holds — the tamper/corruption case.
export function contentVerificationLevel(trailer, computed) {
  if (!trailer) return "watermark-only";
  if (!trailer.tables) return "events-only";
  for (const [table, expected] of Object.entries(trailer.tables)) {
    const actual = computed[table];
    if (!actual)
      throw new Error(`Export trailer pins table ${table} but the export holds no rows for it`);
    if (actual.rows !== expected.rows || actual.sha256 !== expected.sha256)
      throw new Error(`Export table digest does not match for ${table}: the backup's ${table} rows differ from the rows the exporter pinned (tampered or corrupted backup). Re-take the backup.`);
  }
  for (const table of Object.keys(computed))
    if (!Object.hasOwn(trailer.tables, table))
      throw new Error(`Export holds rows for table ${table} that its trailer does not pin`);
  return "full";
}

// Shape gate shared by both NDJSON parsers (here and restore-ndjson.mjs).
export function assertTrailerShape(record) {
  const malformed = () => new Error("Export trailer is malformed");
  if (record.version !== 1 && record.version !== 2) throw malformed();
  if (!Number.isSafeInteger(record.events) || typeof record.eventsHash !== "string" || !/^[0-9a-f]{64}$/.test(record.eventsHash)) throw malformed();
  if (record.version === 2 && record.tables === undefined) throw malformed();
  if (record.tables !== undefined) {
    if (!record.tables || typeof record.tables !== "object" || Array.isArray(record.tables)) throw malformed();
    for (const [table, entry] of Object.entries(record.tables)) {
      if (!IDENT.test(table) || !entry || typeof entry !== "object" || Array.isArray(entry)
        || !Number.isSafeInteger(entry.rows) || entry.rows < 0
        || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw malformed();
    }
  }
}

export function exportNdjsonText(db) {
  return [...exportNdjsonLines(db)].join("");
}

export function exportNdjsonStream(db) {
  const encoder = new TextEncoder();
  const lines = exportNdjsonLines(db);
  return new ReadableStream({
    pull(controller) {
      const next = lines.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    }
  });
}

export function authorizeOperatorExport(authorization, expected) {
  if (typeof expected !== "string" || expected.length < 16) return "unconfigured";
  const match = /^Bearer ([^\s]+)$/i.exec(typeof authorization === "string" ? authorization : "");
  const presented = match?.[1] ?? "";
  const actual = sha256Hex(presented);
  const wanted = sha256Hex(expected);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(wanted)) ? "ok" : "denied";
}

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const ndjsonHeaders = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

export function operatorExportResponse(request, token, db) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/operator/export") return null;
  const auth = authorizeOperatorExport(request.headers.get("authorization"), token);
  if (auth === "unconfigured") return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (request.method !== "GET" && request.method !== "HEAD") return jsonResponse(405, { error: { code: "method_not_allowed", message: "Use GET or HEAD" } });
  if (auth === "denied") return jsonResponse(401, { error: { code: "unauthorized", message: "Operator token required" } });
  if (!db) return jsonResponse(503, { error: { code: "unavailable", message: "Export unavailable" } });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: ndjsonHeaders });
  return new Response(exportNdjsonStream(db), { status: 200, headers: ndjsonHeaders });
}

// REL-14: the inverse of sanitizeCell's BLOB encoding. Any other object is
// refused by name instead of failing as an unbindable parameter.
export function cellOf(value) {
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$base64" && typeof value.$base64 === "string") {
    // Buffer.from skips characters it cannot decode; only canonical base64 is a BLOB.
    const bytes = Buffer.from(value.$base64, "base64");
    if (bytes.toString("base64") !== value.$base64) throw new Error("Export BLOB cell is not canonical base64");
    return bytes;
  }
  throw new Error("Export cell is an object that is not an encoded BLOB");
}

// REL-14 (Instinct-3 4534): a file row carries its own byte_length and sha256;
// replay proves the decoded bytes against both, so a tampered BLOB is refused.
export function checkStoredBytes(table, row) {
  if (!(row.bytes instanceof Uint8Array)) return;
  if (typeof row.byte_length === "number" && row.bytes.length !== row.byte_length)
    throw new Error(`Export ${table} row ${row.id ?? "?"} bytes do not match its byte_length`);
  if (typeof row.sha256 === "string" && sha256Hex(row.bytes) !== row.sha256)
    throw new Error(`Export ${table} row ${row.id ?? "?"} bytes do not match its sha256`);
}

// #3599: the restore-side counterpart of the export policy. Every restore
// path resolves each decoded cell through this tracker before inserting
// it, so a sha256 placeholder can never land as a live value:
// - Secret columns (EXPORT_SECRET_COLUMNS): the stream cell is a
//   placeholder, never the secret. It loads as NULL — or "" where the
//   column is NOT NULL — a value that can never function as the original,
//   and the substitution is counted in report(), so the loss is explicit
//   in the restore result and consumers fail closed visibly instead of
//   comparing against a hash string.
// - Legacy streams (watermark without sanitizePolicy 2, written by the
//   pre-#3599 name-regex exporter) also hashed two non-secret columns.
//   accounts.password_reset_required only ever held 0 or 1, whose
//   placeholders are the two known digests, so the true value is
//   recovered exactly; an unrecognized placeholder refuses the restore
//   rather than guessing a security flag. bounty_records.verifier is
//   unrecoverable and loads as NULL, which grants nobody authority
//   (agent mode fails closed with no verifier seated; human mode never
//   consulted it; legacy mode keeps the poster's own authority) — and is
//   counted in report() so the operator can re-appoint a verifier.
// - Everything else loads verbatim.
// The trailer digests (#3325/#3536) are computed over the stream rows
// before this resolution, so they keep pinning the export exactly as
// written; this tracker defines what the restored cells MEAN.
export function createSanitizedCellTracker(db, { legacySanitize = false } = {}) {
  const counts = new Map();
  const notNullByTable = new Map();
  const record = (table, column) => {
    const key = `${table}.${column}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const secretSubstitute = (table, column) => {
    if (!notNullByTable.has(table)) {
      const set = new Set();
      for (const info of db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all())
        if (info.notnull) set.add(info.name);
      notNullByTable.set(table, set);
    }
    return notNullByTable.get(table).has(column) ? "" : null;
  };
  return {
    resolve(table, column, value) {
      if (value === null || value === undefined) return null;
      if (isExportSecretColumn(table, column)) {
        record(table, column);
        return table === "mcp_event_subscriptions" && column === "document" ? "{}" : secretSubstitute(table, column);
      }
      // Sanitized callback keys cannot resume delivery. Require a fresh
      // authenticated subscribe and challenge after restoring an NDJSON backup.
      if (table === "mcp_event_subscriptions" && column === "state") {
        record(table, column);
        return "inactive";
      }
      if (legacySanitize && table === "accounts" && column === "password_reset_required") {
        record(table, column);
        if (value === sha256Hex("0")) return 0;
        if (value === sha256Hex("1")) return 1;
        throw new Error("Legacy backup holds an unrecognized placeholder in accounts.password_reset_required (the pre-#3599 exporter hashed this flag); refusing to guess its value. Restore from a current backup or repair the cell by hand.");
      }
      if (legacySanitize && table === "bounty_records" && column === "verifier") {
        record(table, column);
        return null;
      }
      return value;
    },
    report() {
      const out = {};
      for (const [key, count] of [...counts.entries()].sort()) {
        const dot = key.indexOf(".");
        (out[key.slice(0, dot)] ??= {})[key.slice(dot + 1)] = count;
      }
      return out;
    }
  };
}

function parseExport(ndjson) {
  if (typeof ndjson !== "string" || !ndjson.trim()) throw new Error("Export is empty");
  const byTable = new Map();
  let watermark = null;
  let trailer = null;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); }
    catch { throw new Error("Export line is not JSON"); }
    if (record?.kind === "watermark") {
      if (watermark) throw new Error("Export has more than one watermark");
      watermark = record;
      continue;
    }
    if (record?.kind === "trailer") {
      if (trailer) throw new Error("Export has more than one trailer");
      assertTrailerShape(record);
      trailer = record;
      continue;
    }
    if (typeof record?.table !== "string" || !record.row || typeof record.row !== "object" || Array.isArray(record.row)) throw new Error("Export line is not a table row");
    const rows = byTable.get(record.table) ?? [];
    rows.push(record.row);
    byTable.set(record.table, rows);
  }
  if (!watermark || watermark.version !== 1 || !Number.isSafeInteger(watermark.events)) throw new Error("Export is missing its watermark");
  return { watermark, byTable, trailer };
}

function insertOrder(names) {
  const ordered = FIRST.filter(table => names.has(table));
  for (const table of [...names].sort()) if (!ordered.includes(table)) ordered.push(table);
  return ordered;
}

// Tables a production Durable Object export can carry that a fresh Node
// store never creates. The two runtime markers belong to the Durable Object
// writer fence (cloudflare/storage.mjs) and mean nothing in a sqlite file.
// The retired Emissary tables stay in upgraded databases (no DROP was ever
// issued) but no module reads them. abuse_rate_buckets is rate-limit state
// the Durable Object creates on first use (server/abuse-rate-buckets.mjs); a
// restored store starts with fresh budgets. The wake-accounting tables
// (server/wake-metrics.mjs, #3345) are the same shape: lazily created
// telemetry — outcome counters plus a bounded loss journal — and a restored
// store restarts its accounting window; the reliability STOCK (pending /
// acked / stranded) is derived from the wake tables themselves, which do
// replay. Replay skips these and reports the row counts; the export itself
// still holds the rows.
export const REPLAY_SKIPPED_TABLES = Object.freeze([
  "room_runtime_version", "room_writer_permit",
  "emissary_drops", "emissary_idempotency", "emissary_invite_attribution",
  "emissary_journal", "external_identities", "external_receipts",
  "abuse_rate_buckets", "agent_wake_counters", "agent_wake_failures"
]);

const CLAIM_PERMIT_TABLE = "public_work_claim_writer_permit";

// #3325: tables excluded from the trailer's content digests (see
// createTableDigests above): exactly the tables no restore path loads.
export const CONTENT_DIGEST_SKIPPED_TABLES = Object.freeze([...REPLAY_SKIPPED_TABLES, CLAIM_PERMIT_TABLE]);

// Replay into a new sqlite file, then run the same checks as backupRoom.
// audit "strict" (default) refuses a store the recovery audit rejects.
// audit "report" still requires the row load, foreign keys, quick_check,
// file bytes and the event count to match, but returns an audit failure
// instead of throwing: the recovery audit replays every room with the
// current reducer, and production rooms written by older code can differ
// from that replay while the live room serves them fine. A disaster
// restore needs the data back and the drift named, not a refusal.
// Restore only the known lazy schemas, never backup-supplied DDL. Streaming
// restore calls this when it encounters the first row in a native namespace.
export function ensureNativeAgentRestoreSchema(db, names) {
  // Production also creates these application schemas lazily. Restore their
  // rows using code-owned DDL; never accept schema supplied by the export.
  if (["agent_wake_listener_leases", "agent_wake_signal_claims", "agent_host_disconnects"].some(table => names.has(table))) db.exec(wakeListenerLeaseSchema);
  if (names.has("agent_wake_room_activity")) db.exec(wakeRoomActivitySchema);
  if (names.has("integrity_failures")) db.exec(INTEGRITY_FAILURES_SCHEMA);
  if (["patrol_cursor", "patrol_claims", "patrol_messages", "patrol_findings", "patrol_blocks"].some(table => names.has(table))) db.exec(PATROL_SCHEMA);
  if (PROJECT_MAP_TABLES.some(table => names.has(table))) db.exec(PROJECT_MAP_SCHEMA);
  if (names.has("projection_shape_upgrades")) db.exec(PROJECTION_SHAPE_UPGRADES_SCHEMA);
  if (OAUTH_PROVIDER_TABLES.some(table => table.startsWith("oauth_provider_") && names.has(table))) ensureOAuthProviderSchema(db);
  if (OAUTH_PROVIDER_TABLES.some(table => table.startsWith("oauth_invite_") && names.has(table))) {
    ensureMcpInviteOAuthSchema(db);
    ensureOAuthProviderSchema(inviteOAuthDatabase(db));
  }
  if (names.has("mcp_event_subscriptions") || names.has("mcp_event_outbox")) db.exec(mcpEventSubscriptionsSchema);
}

export function replayNdjson(ndjson, filename, { audit = "strict", retainTables = null } = {}) {
  if (audit !== "strict" && audit !== "report") throw new Error("audit must be strict or report");
  if (retainTables != null && typeof retainTables !== "function") throw new Error("retainTables must be a function");
  if (!filename) throw new Error("Missing replay paths");
  const { watermark, byTable, trailer } = parseExport(ndjson);
  // Fail fast on a torn export, before any store is created: a mid-stream
  // write the watermark could not see must never verify. #3325: the
  // trailer's per-table content digests are computed over the complete
  // parsed stream (before any table is skipped below) and verified with
  // the other post-load checks.
  const trailerState = trailer ? (verifyTrailer(trailer, byTable), "verified") : "absent";
  const computedDigests = tableDigestsOf(byTable);
  const directory = dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (existsSync(filename)) throw new Error("Refusing to replay into an existing store");
  const store = new RoomStore(filename);
  try {
    ensureNativeAgentRestoreSchema(store.db, new Set(byTable.keys()));
    // #3599: sanitized cells resolve to safe substitutes, never the
    // placeholder; legacy streams get the legacy resolutions.
    const tracker = createSanitizedCellTracker(store.db, { legacySanitize: watermark.sanitizePolicy !== BACKUP_SANITIZE_POLICY });
    // A room restore passes the tables it is willing to load. Names outside
    // that set fail the check below, including directory tables and unknown
    // tables. The default restore sees every table the fresh store created.
    const retained = retainTables ? retainTables(store.db) : null;
    if (retained != null && !(retained instanceof Set)) throw new Error("retainTables must return the tables this store keeps");
    const existing = retained ?? new Set(tableNames(store.db));
    const skipped = {};
    for (const table of REPLAY_SKIPPED_TABLES) {
      if (existing.has(table) || !byTable.has(table)) continue;
      skipped[table] = byTable.get(table).length;
      byTable.delete(table);
    }
    const order = insertOrder(new Set(byTable.keys()));
    for (const table of order) if (!existing.has(table)) throw new Error("Export names a table this store does not have");
    store.db.exec("PRAGMA foreign_keys=OFF");
    // The public claim fence (server/public-work-claim-fence.mjs) aborts any
    // write to a public namespace's claims unless its permit is open. Replay
    // opens it for the bulk load and closes it again, as at rest; the
    // exported permit row is not replayed.
    const claimPermit = existing.has(CLAIM_PERMIT_TABLE);
    byTable.delete(CLAIM_PERMIT_TABLE);
    const loadOrder = order.filter(table => table !== CLAIM_PERMIT_TABLE);
    store.transaction(() => {
      for (const table of loadOrder) store.db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      if (claimPermit) store.db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=1 WHERE singleton=1`).run();
      for (const table of loadOrder) {
        const rows = byTable.get(table);
        if (table === "credentials") rows.sort((a, b) => Number(a.parent_hash != null) - Number(b.parent_hash != null));
        const columns = tableColumns(store.db, table);
        const known = new Set(columns);
        for (const row of rows) {
          const keys = Object.keys(row);
          if (keys.some(key => !known.has(key))) throw new Error("Export row does not match the store schema");
          if (!keys.length) continue;
          const cells = Object.fromEntries(keys.map(key => [key, tracker.resolve(table, key, cellOf(row[key]))]));
          checkStoredBytes(table, cells);
          store.db.prepare(`INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
            .run(...keys.map(key => cells[key]));
        }
      }
      if (claimPermit) store.db.prepare(`UPDATE ${CLAIM_PERMIT_TABLE} SET enabled=0 WHERE singleton=1`).run();
    });
    store.db.exec("PRAGMA foreign_keys=ON");
    if (store.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Restored store failed foreign key check");
    if (store.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Restored store failed quick_check");
    const events = store.db.prepare("SELECT count(*) AS n FROM events").get().n;
    if (events !== watermark.events) throw new Error("Export watermark does not match the restored event log");
    // #3325: the digest pin is verified after the load, not before it —
    // the load's own per-cell refusals (a non-BLOB object cell, a BLOB
    // whose bytes fail their stored sha256) are the more specific errors
    // and must fire first. A tampered row whose cells are all well-formed
    // (the #3325 probe) loads cleanly and is refused here, before the
    // audits and before verified is ever returned.
    const contentVerification = contentVerificationLevel(trailer, computedDigests);
    let recovery = null, invitations = {}, auditResult = { ok: true };
    try {
      recovery = auditRecovery(store);
      invitations = store.verifyInvitationAudit();
    } catch (error) {
      if (audit === "strict") throw error;
      auditResult = { ok: false, error: String(error?.message ?? error).split("\n")[0].slice(0, 200) };
    }
    chmodSync(filename, 0o600);
    return { verified: true, events, trailer: trailerState, contentVerification, ...invitations, recovery, audit: auditResult, skippedTables: skipped, sanitizedCells: tracker.report() };
  } finally { store.close(); }
}
