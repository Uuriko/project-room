// F015 — full data export (GDPR-style, one click).
//
// Pure snapshot -> portable export document. The caller supplies the data
// either as a `collect()` function (wired to whatever store or database the
// room uses) or as a plain data map; this module never assumes a storage
// backend and touches no network, store, or timers. It covers the common
// domains (profile, settings, activity/audit entries) and produces a
// portable export: a JSON document plus a manifest (`exported_at`,
// `format_version`, the included sections, and per-section item counts).
//
// Safety posture, in one place:
//   - secrets never reach the export: every key whose name contains a
//     secret-like token (password, hash-carrying password fields, tokens,
//     credentials, private keys, session/auth material) is replaced with
//     "[redacted]" at any depth, and string values that look like PEM
//     private keys are redacted even under innocent key names;
//   - the input snapshot is never mutated: scrubbing builds fresh objects,
//     and cyclic inputs are handled by identity (a repeated reference
//     reuses its already-scrubbed clone) instead of recursing forever;
//   - nothing here throws: a throwing `collect()` degrades to a manifest
//     `errors` entry, and malformed sections degrade to documented
//     defaults instead of failing the export.
// Suggested wiring (follow-up slice): GET /api/export ->
// exportJson({ collect: () => store.exportUserData(userId) }) as an
// application/json download.

export const EXPORT_FORMAT_VERSION = "1.0.0";
export const REDACTED = "[redacted]";
export const KNOWN_SECTIONS = Object.freeze(["profile", "settings", "activity"]);

// Secret-like key tokens, matched against whole tokens of a key name so
// innocent keys are never redacted ("author" is not "auth", "monkey" is not
// a key). Keys are tokenized on camelCase boundaries and on - _ . / space
// separators before matching.
const SECRET_KEY_TOKENS = new Set([
  "password", "passwd", "pwd", "passphrase",
  "secret", "token", "key", "apikey", "credential", "credentials",
  "privatekey", "privkey", "session", "sessionid", "auth", "bearer",
  "accesstoken", "refreshtoken", "idtoken", "clientsecret", "jwt",
  "otp", "totp", "recoverycode", "pin", "salt", "cookie", "cookies",
  "setcookie", "signature", "hmac",
]);

const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const keyTokens = name =>
  String(name)
    .split(/(?<=[a-z])(?=[A-Z])|[-_./\s]+/)
    .map(part => part.toLowerCase())
    .filter(Boolean);

const isSecretKey = name => {
  const tokens = keyTokens(name);
  return tokens.some(token => SECRET_KEY_TOKENS.has(token)) || SECRET_KEY_TOKENS.has(tokens.join(""));
};

const isPemPrivateKey = value => typeof value === "string" && PEM_PRIVATE_KEY_RE.test(value);

// Deep-clone a value while redacting secrets. `seen` maps source object ->
// already-scrubbed clone so cyclic inputs terminate without mutating the
// original snapshot.
function scrub(value, seen) {
  if (typeof value === "string") {
    return isPemPrivateKey(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const clone = [];
    seen.set(value, clone);
    for (const item of value) clone.push(scrub(item, seen));
    return clone;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return seen.get(value);
    const clone = {};
    seen.set(value, clone);
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = isSecretKey(key) ? REDACTED : scrub(entry, seen);
    }
    return clone;
  }
  return value;
}

export function scrubSnapshot(snapshot) {
  const source = isPlainObject(snapshot) || Array.isArray(snapshot) ? snapshot : {};
  return scrub(source, new Map());
}

// Item count for the manifest: array length, number of object keys, 0 for
// missing values, 1 for any other scalar section payload.
export function sectionItemCount(section) {
  if (section == null) return 0;
  if (Array.isArray(section)) return section.length;
  if (isPlainObject(section)) return Object.keys(section).length;
  return 1;
}

// Resolve the raw snapshot from either a `collect()` function or a plain
// data map. Returns { snapshot, errors }; never throws.
function resolveSnapshot(options) {
  const { data, collect } = options ?? {};
  if (typeof collect === "function") {
    try {
      const snapshot = collect();
      if (isPlainObject(snapshot)) return { snapshot, errors: [] };
      return { snapshot: {}, errors: ["collect() must return a plain object"] };
    } catch (error) {
      return { snapshot: {}, errors: [error instanceof Error ? error.message : String(error)] };
    }
  }
  if (data === undefined) return { snapshot: {}, errors: [] };
  if (isPlainObject(data)) return { snapshot: data, errors: [] };
  return { snapshot: {}, errors: ["data must be a plain object"] };
}

// Build the full export document: { manifest, data }. Frozen, like the
// other payload builders in src/. Never throws.
export function exportData(options) {
  const { data, collect, sections, now } = options ?? {};
  const clock = typeof now === "function" ? now : () => Date.now();
  const { snapshot, errors } = resolveSnapshot({ data, collect });
  const wanted = Array.isArray(sections) && sections.length > 0
    ? sections.filter(name => typeof name === "string")
    : Object.keys(snapshot);
  const manifest = {
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: new Date(clock()).toISOString(),
    sections: [],
    counts: {},
    errors,
  };
  const payload = {};
  for (const name of wanted) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, name)) continue;
    const raw = snapshot[name];
    payload[name] = scrub(raw, new Map());
    manifest.sections.push(name);
    manifest.counts[name] = sectionItemCount(raw);
  }
  return Object.freeze({
    manifest: Object.freeze({
      ...manifest,
      sections: Object.freeze([...manifest.sections]),
      counts: Object.freeze({ ...manifest.counts }),
      errors: Object.freeze([...manifest.errors]),
    }),
    data: Object.freeze({ ...payload }),
  });
}

// Serialize an export document to JSON (pretty-printed: this is a file a
// person downloads). Accepts the same options as exportData, or a
// ready-built document via { document }.
export function exportJson(options) {
  const opts = options ?? {};
  const document = typeof opts === "object" && "document" in opts
    ? opts.document
    : exportData(opts);
  return JSON.stringify(document, null, 2);
}
