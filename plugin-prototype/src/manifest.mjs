// manifest.mjs — plugin.json parsing + validation (manifestVersion 1).
// Throws ManifestError on any violation. Pure: no I/O here.

export class ManifestError extends Error {
  constructor(message, field) {
    super(field ? `${field}: ${message}` : message);
    this.name = 'ManifestError';
    this.field = field;
  }
}

export const MANIFEST_VERSION = 1;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// v1 allowlists — the spec's closed sets. Unknown entries reject the install.
export const HOOK_ALLOWLIST = Object.freeze([
  'room.message.posted',
  'room.member.joined',
  'room.member.left',
  'work.claim.created',
  'work.claim.completed',
  'plugin.enabled',
  'plugin.disabled',
]);

export const CAPABILITY_ALLOWLIST = Object.freeze([
  'log',
  'storage.kv',
  'timers',
]);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertString(obj, field, min, max) {
  const v = obj[field];
  if (typeof v !== 'string' || v.length < min || v.length > max) {
    throw new ManifestError(`must be a string of ${min}..${max} chars`, field);
  }
  return v;
}

function assertStringArray(obj, field, allowlist) {
  const v = obj[field];
  if (!Array.isArray(v)) throw new ManifestError('must be an array', field);
  const seen = new Set();
  for (const item of v) {
    if (typeof item !== 'string') throw new ManifestError('entries must be strings', field);
    if (!allowlist.includes(item)) {
      throw new ManifestError(`unknown ${field.slice(0, -1)} "${item}" (not in v1 allowlist)`, field);
    }
    if (seen.has(item)) throw new ManifestError(`duplicate entry "${item}"`, field);
    seen.add(item);
  }
  return [...v];
}

export function validateManifest(raw) {
  if (!isPlainObject(raw)) throw new ManifestError('manifest must be a JSON object');
  if (raw.manifestVersion !== MANIFEST_VERSION) {
    throw new ManifestError(`manifestVersion must be ${MANIFEST_VERSION}`, 'manifestVersion');
  }
  const name = assertString(raw, 'name', 1, 64);
  if (!NAME_RE.test(name)) {
    throw new ManifestError('must match /^[a-z0-9][a-z0-9-]{0,63}$/', 'name');
  }
  const version = assertString(raw, 'version', 5, 32);
  if (!SEMVER_RE.test(version)) {
    throw new ManifestError('must be strict semver MAJOR.MINOR.PATCH', 'version');
  }
  assertString(raw, 'description', 1, 280);
  assertString(raw, 'author', 1, 120);

  const entry = assertString(raw, 'entry', 1, 256);
  if (!entry.endsWith('.js')) throw new ManifestError('entry must end in .js', 'entry');
  if (entry.startsWith('/') || entry.includes('..') || entry.includes('\\')) {
    throw new ManifestError('entry must be a relative path inside the plugin dir (no .., no absolute)', 'entry');
  }

  const hooks = raw.hooks === undefined ? [] : assertStringArray(raw, 'hooks', HOOK_ALLOWLIST);
  const capabilities = raw.capabilities === undefined
    ? []
    : assertStringArray(raw, 'capabilities', CAPABILITY_ALLOWLIST);

  let config;
  if (raw.config !== undefined) {
    if (!isPlainObject(raw.config)) throw new ManifestError('config must be an object', 'config');
    config = structuredClone(raw.config);
  }

  // Reject unknown top-level fields — fail closed on future typos.
  const known = new Set(['manifestVersion', 'name', 'version', 'description', 'author', 'entry', 'hooks', 'capabilities', 'config']);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) throw new ManifestError(`unknown field "${k}"`, k);
  }

  return Object.freeze({
    manifestVersion: MANIFEST_VERSION,
    name,
    version,
    description: raw.description,
    author: raw.author,
    entry,
    hooks: Object.freeze(hooks),
    capabilities: Object.freeze(capabilities),
    config: config === undefined ? undefined : deepFreeze(config),
  });
}

export function parseManifest(jsonText) {
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new ManifestError(`invalid JSON: ${e.message}`);
  }
  return validateManifest(raw);
}

function deepFreeze(o) {
  for (const v of Object.values(o)) {
    if (isPlainObject(v) || Array.isArray(v)) deepFreeze(v);
  }
  return Object.freeze(o);
}
