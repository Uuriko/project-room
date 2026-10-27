// Shared export scrub: the ONE token/secret scrub every export shape uses
// (whole-store NDJSON, room JSONL/HTML, CSV/JSON journals). Before this
// module each shape carried its own copy of the rule — or none — and the
// shapes disagreed per cell (methods audit B7-4 F2/F3/F4, B2-5-F1).
//
// Design (audit conversion, export family):
// - Token shapes: every credential shape this product mints — pri_ / rak_
//   API keys, ga1. guest-agent tokens, GX- guest invite codes, and
//   standalone 43-char share tokens (the human share-token shape) — not
//   just the original three prefixes.
// - Value-shaped, not column-shaped: an export context can register the
//   store's actual secret-column values; any later copy of one of those
//   values inside ordinary content is scrubbed too (a secret pasted into
//   a message body gets the same protection as its column cell).
// - Placeholders are salted sha256 hex under a per-export random salt
//   that is never written to the export. A bare unsalted sha256 of a
//   low-entropy secret is dictionary-reversible (B7-4 F6: the sha256 of
//   "123456" is publicly known); a salted placeholder whose salt no
//   longer exists cannot be tested against guesses, while staying a
//   64-char hex string so shape-based consumers keep working. Within one
//   export the salt is fixed, so repeated copies of one value share one
//   placeholder and stay recognisably the same value.
// - Substitutions in non-secret cells are counted per table.column (or a
//   caller-named surface) so a restore can report the loss instead of
//   certifying a silently rewritten round trip as lossless (B2-5-F1).
import { createHash, randomBytes } from "node:crypto";

const sha256Hex = value => createHash("sha256").update(value).digest("hex");

// Alternation order matters: the prefixed shapes are tried before the
// standalone share-token shape, whose 43-char body also appears inside a
// ga1. token (after the dot) and must not be matched a second time.
const TOKEN_SOURCE = [
  "(?:pri_|rak_)[A-Za-z0-9_-]{8,}",
  "ga1\\.[A-Za-z0-9_-]{8,}",
  "GX-[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])",
  // A share token is an unpadded base64url string; the boundary excludes
  // base64 characters too, so a padded base64 value (a stored public key,
  // a MIME part) is not mistaken for one.
  "(?<![A-Za-z0-9_+\\/=-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_+\\/=-])"
].join("|");
export const EXPORT_TOKEN_PATTERN = new RegExp(TOKEN_SOURCE, "g");

// Secret values shorter than this are not registered for value-shaped
// scrubbing: a very short value (a flag, a common word) would scrub
// ordinary content that merely contains it. Column cells holding such
// values are still replaced whole by the secret-column rule.
export const MIN_VALUE_SCRUB_LENGTH = 8;

export function createExportScrubContext() {
  return {
    salt: randomBytes(16).toString("hex"),
    secretValues: [],
    counts: new Map(),
    record(table, column, n = 1) {
      const key = `${table}.${column}`;
      this.counts.set(key, (this.counts.get(key) ?? 0) + n);
    },
    report() {
      const out = {};
      for (const [key, count] of [...this.counts.entries()].sort()) {
        const dot = key.indexOf(".");
        (out[key.slice(0, dot)] ??= {})[key.slice(dot + 1)] = count;
      }
      return out;
    }
  };
}

// Standalone callers (the shard copy, the trailer's event-id tuples) share
// one process-lifetime context: placeholders stay consistent within the
// process and the salt still never reaches any export.
let sharedContext = null;
export function defaultExportScrubContext() {
  return sharedContext ??= createExportScrubContext();
}

export function placeholderFor(value, context = defaultExportScrubContext()) {
  return sha256Hex(`export-sanitized\0${context.salt}\0${value}`);
}

export function registerSecretValues(context, values) {
  const seen = new Set(context.secretValues);
  for (const value of values) {
    if (typeof value !== "string" || value.length < MIN_VALUE_SCRUB_LENGTH || seen.has(value)) continue;
    seen.add(value);
    context.secretValues.push(value);
  }
  // Longest first, so a value that contains another registered value is
  // replaced whole instead of leaving its tail behind.
  context.secretValues.sort((a, b) => b.length - a.length);
}

// Replace token-shaped substrings and registered secret values in one
// string cell. `table`/`column` name the counting surface; pass null to
// scrub without counting (read surfaces with no report channel).
export function scrubText(value, context = defaultExportScrubContext(), table = null, column = null) {
  if (typeof value !== "string" || !value) return value;
  let count = 0;
  let out = value.replace(EXPORT_TOKEN_PATTERN, match => { count += 1; return placeholderFor(match, context); });
  for (const secret of context.secretValues) {
    if (!out.includes(secret)) continue;
    const parts = out.split(secret);
    count += parts.length - 1;
    out = parts.join(placeholderFor(secret, context));
  }
  if (count && table !== null) context.record(table, column, count);
  return out;
}

// Recursively scrub every string in a plain JSON-shaped value (the room
// JSONL/HTML export's event objects). Keys are identifiers, not content,
// and are left alone.
export function scrubStringsDeep(value, context = defaultExportScrubContext(), table = null, column = null) {
  if (typeof value === "string") return scrubText(value, context, table, column);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const scrubbed = scrubStringsDeep(item, context, table, column);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const scrubbed = scrubStringsDeep(item, context, table, column);
      if (scrubbed !== item) changed = true;
      next[key] = scrubbed;
    }
    return changed ? next : value;
  }
  return value;
}

// Shape of the trailer's scrub-count block, shared by the exporter's
// trailer writer and both restore parsers.
export function isScrubCountsShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(columns => columns && typeof columns === "object" && !Array.isArray(columns)
    && Object.values(columns).every(count => Number.isSafeInteger(count) && count >= 0));
}
