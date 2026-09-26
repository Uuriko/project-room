// Synchronous pre-post validation for the #266 coordination board's
// ```room-claim fenced blocks (RC-2026-09-24-204).
//
// Pure module: no imports beyond the language, no store, no room state, no
// logging. validateClaimText is a pure function of the comment body the
// agent intends to post, mirroring the `validate_claim` jq def inside
// parse_events in scripts/room, so agents get the same verdict locally
// that the async rebuild would reach.
//
// BOUNDARY: duplicate task-id detection is deliberately NOT here. It needs
// the live board state (the set of already-registered task ids), which is
// unavailable synchronously; rebuild still refuses task-id reuse with
// "duplicate claim refused; task-id already used".
//
// Error strings are copied verbatim from scripts/room's validate_claim —
// they are what agents already see in rebuild logs, so the pre-post verdict
// and the rebuild verdict agree word for word.
//
// One intentional ordering deviation from the jq: in scripts/room the
// `elif $b.state == "failed"` branch is dead code — the preceding
// regex-not-match elif catches bare "failed" first, so the rebuild logs
// "unknown state word: failed". The room's stated rule (and RC-2026-09-24-204)
// is that bare failed means "failed requires a failure code", so the
// failed-without-code check runs before the unknown-state-word check here.
// Every other input produces the same verdict as the jq.

// Max comment-body length accepted by the POST /api/claims/validate route
// (422 beyond). The body reader is allowed a little JSON-envelope overhead
// above this.
export const CLAIM_TEXT_MAX_LENGTH = 65536;

// First ```room-claim fenced block, or null. Mirrors scripts/room's
// `def fence($t)`: the opening fence must be followed by a newline
// (trailing spaces/tabs allowed, nothing else), the body runs to a
// line-start closing fence; the match is the first such block.
const FENCE_RE = /```room-claim[ \t]*\n([\s\S]*?)\n```/;
export function extractClaimBlock(text) {
  const match = FENCE_RE.exec(text);
  return match ? match[1] : null;
}

// Fenced body -> {field: value}. Mirrors scripts/room's `def fields`:
// only lines matching ^[ \t]*[A-Za-z0-9_-]+[ \t]*: count, the key is
// before the first colon, the value is the rest of the line with leading
// and trailing spaces/tabs trimmed, and duplicate keys keep the LAST
// value (jq from_entries semantics; first-insertion key order).
const FIELD_LINE_RE = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*([\s\S]*)$/;
const TRIM_RE = /^[ \t]+|[ \t]+$/g;
export function parseClaimFields(block) {
  const fields = new Map();
  for (const line of block.split("\n")) {
    const match = FIELD_LINE_RE.exec(line);
    if (!match) continue;
    fields.set(match[1], match[2].replace(TRIM_RE, ""));
  }
  return Object.fromEntries(fields);
}

const TASK_ID_RE = /^RC-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]+$/;
const LEASE_RE = /^lease=([0-9]+)h$/;
const STATE_RE = /^(submitted|working|cancelled|suspended|completed|failed\([A-Za-z0-9_]+\))$/;

// Field rules, in the same order as scripts/room's validate_claim.
export function validateClaimFields(fields) {
  const errors = [];
  const taskId = fields["task-id"] ?? "";
  if (taskId === "") errors.push("missing task-id");
  else if (!TASK_ID_RE.test(taskId)) errors.push("task-id not RC-YYYY-MM-DD-NNN");
  if ((fields.lane ?? "") === "") errors.push("missing lane");
  const files = fields.files ?? "";
  if (files === "") errors.push("missing files");
  else if (files.includes("*")) errors.push("files: * forbidden");
  const lease = fields.lease ?? "";
  if (lease === "") {
    errors.push("missing lease");
  } else {
    const match = LEASE_RE.exec(lease);
    if (!match) errors.push(/^[0-9]+h$/.test(lease)
      ? `lease must be lease=<N>h (1-72h); did you mean lease=${lease}?`
      : "lease must be lease=<N>h");
    else {
      const hours = Number(match[1]);
      if (hours < 1 || hours > 72) errors.push("lease out of range 1-72h");
    }
  }
  const state = fields.state ?? "";
  if (state === "") errors.push("missing state");
  // See the ordering note above: bare "failed" reports the missing code,
  // never the unknown-state-word catch-all.
  else if (state === "failed") errors.push("failed requires a failure code");
  else if (!STATE_RE.test(state)) errors.push("unknown state word: " + state);
  if ((fields.reason ?? "") === "") errors.push("missing reason");
  return errors;
}

// Full synchronous verdict for a comment body: { valid, taskId, fields }
// on success, { valid: false, errors, fields, taskId } on failure. fields
// always carries the parsed block ({} when no block was found).
export function validateClaimText(text) {
  const block = extractClaimBlock(typeof text === "string" ? text : "");
  if (block === null) {
    return { valid: false, taskId: null, fields: {}, errors: ["no room-claim fenced block found"] };
  }
  const fields = parseClaimFields(block);
  const errors = validateClaimFields(fields);
  const taskId = fields["task-id"] || null;
  if (errors.length === 0) return { valid: true, taskId, fields };
  return { valid: false, taskId, fields, errors };
}
