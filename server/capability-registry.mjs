// Typed capability registry (integration slice #11).
//
// Mined from Firecrawl's Alexandria: a registry where every capability is
// addressed as `provider/capability`, declares typed inputs, typed outputs,
// and credits-only pricing, and is validated FAIL-CLOSED — unknown addresses
// error locally with suggestions and never silently fall back to something
// else; mixing tool addresses and freeform references in one call is
// rejected. Search returns matches WITH next actions (invoke, inspect,
// watch), not bare listings.
//
// Ported from the standalone workspace prototype at
// ~/workspace/alexandria-capability-registry/ (56/56 tests). Fail-closed
// semantics are preserved verbatim — this port adapts, it does not
// reinvent. See docs/CAPABILITY-REGISTRY.md for the Alexandria mapping
// and the wiring points into the bounty/task marketplace.
//
// Plugs into: the bounty/task marketplace. A bounty take IS a capability:
// pinned acceptance rubric (acceptance.rubric is the "done" definition,
// versioned like slice #6's pinned rubrics) + typed inputs (submission
// schema) + typed outputs (deliverable shape) + credit pricing (quoting,
// credits-only). This module is the discovery layer that marketplace
// currently lacks. It also formalizes the agent-plugin manifest shape
// (server/agent-plugin-manifest.mjs) into something machine-checkable.
//
// Credits-only boundary (non-negotiable): pricing is integer MILLI-CREDITS
// (1000 mc = 1 credit) so sub-credit prices stay exact. No money, no
// wallets, no checkout, no payment rail, no chain/tx/address references
// anywhere in manifests, quotes, or errors. `invoke` is a DECLARED next
// action on search hits, not an implemented one — execution stays in the
// room's existing worker/job machinery.
//
// Pure: stdlib only, no imports of its own, no I/O, no network, no clock.
// No database tables, no schema changes, no journal — so NO writer-fence
// impact: an older writer has no code path to this module and there is no
// stored state to fence. A per-room registry instance is created by the
// caller (new CapabilityRegistry()); persistence, if ever needed, is a
// later slice and must go through the room's normal migration process.
// No HTTP routes are wired in this slice — the module is a library.

export const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const MAX_INT = 1_000_000;
const MAX_TITLE = 140;
const MAX_TEXT = 4000;

const TOP_LEVEL_FIELDS = new Set([
  'provider', 'name', 'version', 'title', 'description',
  'inputs', 'outputs', 'pricing', 'examples', 'acceptance', 'category',
]);
const REQUIRED_FIELDS = [
  'provider', 'name', 'version', 'title', 'description',
  'inputs', 'outputs', 'pricing', 'acceptance',
];
const PRICING_FIELDS = new Set(['milliCreditsPerCall', 'freeCallsPerDay']);
const ACCEPTANCE_FIELDS = new Set(['rubric', 'criteria']);
const EXAMPLE_FIELDS = new Set(['input', 'output', 'note']);
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
// Conservative allowlist of the JSON Schema keywords we understand.
const SCHEMA_FIELDS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'description',
  'additionalProperties', 'format', 'minimum', 'maximum',
  'minLength', 'maxLength', 'pattern', 'default', 'examples', 'title',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function checkSchemaNode(node, path, errors, depth) {
  if (depth > 8) {
    errors.push(`${path}: schema nesting too deep (max 8)`);
    return;
  }
  if (!isPlainObject(node)) {
    errors.push(`${path}: schema node must be an object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!SCHEMA_FIELDS.has(key)) errors.push(`${path}: unknown schema keyword "${key}"`);
  }
  if (node.type !== undefined && (typeof node.type !== 'string' || !JSON_TYPES.has(node.type))) {
    errors.push(`${path}.type: must be one of ${[...JSON_TYPES].join(', ')}`);
  }
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      errors.push(`${path}.properties: must be an object`);
    } else {
      for (const [propName, propNode] of Object.entries(node.properties)) {
        checkSchemaNode(propNode, `${path}.properties.${propName}`, errors, depth + 1);
      }
    }
  }
  if (node.items !== undefined) {
    checkSchemaNode(node.items, `${path}.items`, errors, depth + 1);
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== 'string')) {
      errors.push(`${path}.required: must be an array of strings`);
    }
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) {
    errors.push(`${path}.enum: must be an array`);
  }
}

function checkIntField(obj, key, path, errors, min = 0, max = MAX_INT) {
  const v = obj[key];
  if (!Number.isInteger(v) || v < min || v > max) {
    errors.push(`${path}.${key}: must be an integer between ${min} and ${max}`);
  }
}

/**
 * Validate a capability manifest, fail-closed.
 * @returns {{ok:true, manifest:Object} | {ok:false, errors:string[]}}
 * On success the manifest is a deep clone with defaults applied
 * (examples: [], category: provider).
 */
export function validateManifest(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(key)) errors.push(`unknown field "${key}"`);
  }
  for (const key of REQUIRED_FIELDS) {
    if (input[key] === undefined) errors.push(`missing required field "${key}"`);
  }

  if (input.provider !== undefined && !SEGMENT_RE.test(input.provider)) {
    errors.push('provider: must be lowercase alphanumeric with hyphens (e.g. "acme")');
  }
  if (input.name !== undefined && !SEGMENT_RE.test(input.name)) {
    errors.push('name: must be lowercase alphanumeric with hyphens (e.g. "ocr")');
  }
  if (input.version !== undefined && (typeof input.version !== 'string' || !SEMVER_RE.test(input.version))) {
    errors.push('version: must be strict semver "x.y.z" (e.g. "1.2.0")');
  }
  if (input.title !== undefined && !checkNonEmptyString(input.title, MAX_TITLE)) {
    errors.push(`title: must be a non-empty string up to ${MAX_TITLE} chars`);
  }
  if (input.description !== undefined && !checkNonEmptyString(input.description, MAX_TEXT)) {
    errors.push(`description: must be a non-empty string up to ${MAX_TEXT} chars`);
  }
  if (input.category !== undefined && !SEGMENT_RE.test(input.category)) {
    errors.push('category: must be lowercase alphanumeric with hyphens');
  }

  if (input.inputs !== undefined) checkSchemaNode(input.inputs, 'inputs', errors, 0);
  if (input.outputs !== undefined) checkSchemaNode(input.outputs, 'outputs', errors, 0);

  if (input.pricing !== undefined) {
    if (!isPlainObject(input.pricing)) {
      errors.push('pricing: must be an object');
    } else {
      for (const key of Object.keys(input.pricing)) {
        if (!PRICING_FIELDS.has(key)) errors.push(`pricing: unknown field "${key}"`);
      }
      if (input.pricing.milliCreditsPerCall === undefined) {
        errors.push('pricing: missing required field "milliCreditsPerCall"');
      } else {
        checkIntField(input.pricing, 'milliCreditsPerCall', 'pricing', errors);
      }
      if (input.pricing.freeCallsPerDay === undefined) {
        errors.push('pricing: missing required field "freeCallsPerDay"');
      } else {
        checkIntField(input.pricing, 'freeCallsPerDay', 'pricing', errors);
      }
    }
  }

  if (input.examples !== undefined) {
    if (!Array.isArray(input.examples)) {
      errors.push('examples: must be an array');
    } else {
      input.examples.forEach((ex, i) => {
        if (!isPlainObject(ex)) {
          errors.push(`examples[${i}]: must be an object`);
          return;
        }
        for (const key of Object.keys(ex)) {
          if (!EXAMPLE_FIELDS.has(key)) errors.push(`examples[${i}]: unknown field "${key}"`);
        }
        if (ex.input === undefined) errors.push(`examples[${i}]: missing required field "input"`);
        if (ex.note !== undefined && typeof ex.note !== 'string') {
          errors.push(`examples[${i}].note: must be a string`);
        }
      });
    }
  }

  if (input.acceptance !== undefined) {
    if (!isPlainObject(input.acceptance)) {
      errors.push('acceptance: must be an object');
    } else {
      for (const key of Object.keys(input.acceptance)) {
        if (!ACCEPTANCE_FIELDS.has(key)) errors.push(`acceptance: unknown field "${key}"`);
      }
      if (input.acceptance.rubric === undefined) {
        errors.push('acceptance: missing required field "rubric"');
      } else if (!checkNonEmptyString(input.acceptance.rubric, MAX_TEXT)) {
        errors.push(`acceptance.rubric: must be a non-empty string up to ${MAX_TEXT} chars`);
      }
      if (input.acceptance.criteria !== undefined) {
        const c = input.acceptance.criteria;
        if (!Array.isArray(c) || c.some((s) => !checkNonEmptyString(s, 500))) {
          errors.push('acceptance.criteria: must be an array of non-empty strings');
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Normalize: deep-clone so the registry owns its copy, apply defaults.
  const manifest = JSON.parse(JSON.stringify(input));
  if (manifest.examples === undefined) manifest.examples = [];
  if (manifest.category === undefined) manifest.category = manifest.provider;
  return { ok: true, manifest };
}

/** Validate or throw a coded Error. */
export function assertValidManifest(input) {
  const v = validateManifest(input);
  if (!v.ok) {
    const err = new Error(`invalid capability manifest: ${v.errors.join('; ')}`);
    err.code = 'invalid_manifest';
    err.errors = v.errors;
    throw err;
  }
  return v.manifest;
}

// ---------------------------------------------------------------------------
// Addressing: "provider/capability[@version]"
//   - "acme/ocr"            -> latest registered version
//   - "acme/ocr@1.0.0"     -> pinned version
//   - "acme/ocr@latest"    -> latest registered version
//
// Fail-closed rules (Alexandria-style):
//   - Unknown provider/capability is a structured error with suggestions.
//     It NEVER silently falls back to something else.
//   - URLs are rejected as addresses, and a batch containing ANY URL
//     rejects the WHOLE batch with 'mixed_batch'.
//   - A batch mixing valid tool addresses and freeform (non-address) text
//     rejects the WHOLE batch with 'mixed_batch' — freeform is never
//     coerced into an address.
//   - Bare names ("amazon"), wrong segment counts, bad versions are
//     'bad_address' — never guessed at.
// ---------------------------------------------------------------------------

const URL_LIKE_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export class AddressError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AddressError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export class RegistryError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Numeric semver comparison for strict x.y.z versions. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function looksLikeUrl(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return URL_LIKE_RE.test(t) || t.toLowerCase().startsWith('www.');
}

/**
 * Parse "provider/capability[@version]".
 * @throws {AddressError} code 'bad_address' — never guesses, never falls back.
 */
export function parseAddress(raw) {
  if (typeof raw !== 'string') {
    throw new AddressError('bad_address', 'tool address must be a string');
  }
  const s = raw.trim();
  if (s.length === 0) {
    throw new AddressError('bad_address', 'tool address is empty');
  }
  if (/\s/.test(s)) {
    throw new AddressError('bad_address', `tool address contains whitespace: ${JSON.stringify(raw)}`);
  }
  if (looksLikeUrl(s)) {
    throw new AddressError(
      'bad_address',
      `looks like a URL, not a tool address: ${JSON.stringify(raw)}`,
      { looksLikeUrl: true },
    );
  }
  const atParts = s.split('@');
  if (atParts.length > 2) {
    throw new AddressError('bad_address', `too many "@" in ${JSON.stringify(raw)}`);
  }
  const body = atParts[0];
  let version = 'latest';
  if (atParts.length === 2) {
    version = atParts[1];
    if (version !== 'latest' && !SEMVER_RE.test(version)) {
      throw new AddressError(
        'bad_address',
        `bad version ${JSON.stringify(version)} in ${JSON.stringify(raw)}: expected "x.y.z" or "latest"`,
      );
    }
  }
  const segs = body.split('/');
  if (segs.length !== 2) {
    throw new AddressError('bad_address', `expected "provider/capability", got ${JSON.stringify(raw)}`);
  }
  const [provider, name] = segs;
  if (!SEGMENT_RE.test(provider)) {
    throw new AddressError('bad_address', `bad provider segment ${JSON.stringify(provider)} in ${JSON.stringify(raw)}`);
  }
  if (!SEGMENT_RE.test(name)) {
    throw new AddressError('bad_address', `bad capability segment ${JSON.stringify(name)} in ${JSON.stringify(raw)}`);
  }
  return { provider, name, version };
}

/**
 * Parse a batch of addresses. Rejected wholesale (never partially, never
 * coerced) when:
 *   - ANY entry looks like a URL ('mixed_batch'), or
 *   - some entries are valid tool addresses while others are freeform
 *     text ('mixed_batch') — addresses and freeform references are never
 *     mixed in one call.
 * A batch where NO entry parses as an address re-throws the first
 * 'bad_address' error unchanged.
 */
export function parseBatch(rawList) {
  if (!Array.isArray(rawList)) {
    throw new AddressError('bad_address', 'batch must be an array of tool addresses');
  }
  if (rawList.length === 0) {
    throw new AddressError('bad_address', 'batch is empty');
  }
  const urls = rawList.filter((e) => looksLikeUrl(e));
  if (urls.length > 0) {
    throw new AddressError(
      'mixed_batch',
      `batch mixes tool addresses and URLs (${urls.length} URL-like) — rejected, never silently coerced`,
      { urls },
    );
  }
  const parsed = [];
  const freeform = [];
  let firstError = null;
  for (const entry of rawList) {
    try {
      parsed.push(parseAddress(entry));
    } catch (e) {
      freeform.push(entry);
      if (!firstError) firstError = e;
    }
  }
  if (freeform.length > 0 && parsed.length > 0) {
    throw new AddressError(
      'mixed_batch',
      'batch mixes tool addresses and freeform references — rejected, freeform is never coerced into an address',
      { addresses: rawList.filter((_, i) => !freeform.includes(rawList[i])), freeform },
    );
  }
  if (parsed.length === 0) {
    throw firstError; // no valid address at all: plain bad_address
  }
  return parsed;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

function suggest(needle, candidates, limit = 3) {
  return candidates
    .map((c) => ({ c, d: levenshtein(needle, c) }))
    .filter(({ d }) => d > 0 && d <= 3)
    .sort((x, y) => x.d - y.d || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0))
    .slice(0, limit)
    .map(({ c }) => c);
}

export class CapabilityRegistry {
  #store = new Map(); // "provider/name@version" -> validated manifest

  /**
   * Register a manifest. Rejects invalid manifests and duplicates
   * (same provider/name/version triple). Different versions of the
   * same provider/name may coexist.
   */
  register(input) {
    const v = validateManifest(input);
    if (!v.ok) {
      throw new RegistryError('invalid_manifest', `manifest rejected: ${v.errors.join('; ')}`, { errors: v.errors });
    }
    const m = v.manifest;
    const key = `${m.provider}/${m.name}@${m.version}`;
    if (this.#store.has(key)) {
      throw new RegistryError('duplicate', `capability already registered: ${key}`);
    }
    this.#store.set(key, m);
    return m;
  }

  /**
   * Resolve "provider/capability[@version]".
   * @returns {{ok:true, manifest} | {ok:false, code, message, suggestions}}
   * Codes: 'bad_address' | 'unknown_provider' | 'unknown_capability'.
   * Never falls back to a different capability.
   */
  resolve(raw) {
    let addr;
    try {
      addr = parseAddress(raw);
    } catch (e) {
      return { ok: false, code: 'bad_address', message: e.message, suggestions: [] };
    }
    const providers = this.#providerNames();
    if (!providers.includes(addr.provider)) {
      return {
        ok: false,
        code: 'unknown_provider',
        message: `unknown provider "${addr.provider}"`,
        suggestions: suggest(addr.provider, providers),
      };
    }
    const versions = this.#versions(addr.provider, addr.name);
    if (versions.length === 0) {
      return {
        ok: false,
        code: 'unknown_capability',
        message: `unknown capability "${addr.provider}/${addr.name}"`,
        suggestions: suggest(addr.name, this.#capabilityNames(addr.provider))
          .map((n) => `${addr.provider}/${n}`),
      };
    }
    if (addr.version === 'latest') {
      const best = [...versions].sort(compareVersions).at(-1);
      return { ok: true, manifest: this.#store.get(`${addr.provider}/${addr.name}@${best}`) };
    }
    if (!versions.includes(addr.version)) {
      return {
        ok: false,
        code: 'unknown_capability',
        message: `version ${addr.version} of ${addr.provider}/${addr.name} is not registered`,
        suggestions: versions.map((ver) => `${addr.provider}/${addr.name}@${ver}`),
      };
    }
    return { ok: true, manifest: this.#store.get(`${addr.provider}/${addr.name}@${addr.version}`) };
  }

  /** True when resolve(raw).ok. */
  has(raw) {
    return this.resolve(raw).ok === true;
  }

  /** All manifests, sorted by provider, name, then version ascending. */
  list({ category } = {}) {
    const all = [...this.#store.values()];
    const filtered = category === undefined ? all : all.filter((m) => m.category === category);
    return filtered.sort((a, b) => {
      if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return compareVersions(a.version, b.version);
    });
  }

  count() {
    return this.#store.size;
  }

  #providerNames() {
    return [...new Set([...this.#store.values()].map((m) => m.provider))];
  }

  #capabilityNames(provider) {
    return [...new Set(
      [...this.#store.values()].filter((m) => m.provider === provider).map((m) => m.name),
    )];
  }

  #versions(provider, name) {
    return [...this.#store.values()]
      .filter((m) => m.provider === provider && m.name === name)
      .map((m) => m.version);
  }
}

// ---------------------------------------------------------------------------
// Quoting (credits-only)
//
// A quote prices nCalls against a capability's pricing:
//   { milliCreditsPerCall, freeCallsPerDay }
//
// The daily free tier is consumed first (minus whatever the caller
// reports as already used today), then remaining calls are paid at
// milliCreditsPerCall. Everything is integer milli-credits. No money,
// no wallets, no floats, no external state — the caller supplies
// freeCallsUsedToday.
// ---------------------------------------------------------------------------

/**
 * @param {Object} manifest - validated capability manifest (needs .pricing)
 * @param {number} nCalls - non-negative integer
 * @param {Object} [opts]
 * @param {number} [opts.freeCallsUsedToday=0] - free calls already consumed today
 * @returns quote object with totalMilliCredits and a line-item breakdown
 */
export function quote(manifest, nCalls, { freeCallsUsedToday = 0 } = {}) {
  if (!manifest || typeof manifest !== 'object' || !manifest.pricing) {
    throw new TypeError('quote: manifest with pricing is required');
  }
  if (!Number.isInteger(nCalls) || nCalls < 0) {
    throw new TypeError(`quote: nCalls must be a non-negative integer, got ${nCalls}`);
  }
  if (!Number.isInteger(freeCallsUsedToday) || freeCallsUsedToday < 0) {
    throw new TypeError(
      `quote: freeCallsUsedToday must be a non-negative integer, got ${freeCallsUsedToday}`,
    );
  }
  const { milliCreditsPerCall, freeCallsPerDay } = manifest.pricing;
  if (!Number.isInteger(milliCreditsPerCall) || milliCreditsPerCall < 0) {
    throw new TypeError('quote: manifest.pricing.milliCreditsPerCall must be a non-negative integer');
  }
  if (!Number.isInteger(freeCallsPerDay) || freeCallsPerDay < 0) {
    throw new TypeError('quote: manifest.pricing.freeCallsPerDay must be a non-negative integer');
  }

  const freeRemaining = Math.max(0, freeCallsPerDay - freeCallsUsedToday);
  const freeCallsApplied = Math.min(nCalls, freeRemaining);
  const paidCalls = nCalls - freeCallsApplied;
  const totalMilliCredits = paidCalls * milliCreditsPerCall;

  return {
    capability: `${manifest.provider}/${manifest.name}`,
    version: manifest.version,
    calls: nCalls,
    milliCreditsPerCall,
    freeCallsPerDay,
    freeCallsUsedToday,
    freeCallsRemaining: freeRemaining,
    freeCallsApplied,
    paidCalls,
    totalMilliCredits,
    breakdown: [
      { kind: 'free', calls: freeCallsApplied, milliCreditsPerCall: 0, subtotalMilliCredits: 0 },
      { kind: 'paid', calls: paidCalls, milliCreditsPerCall, subtotalMilliCredits: totalMilliCredits },
    ],
  };
}

// ---------------------------------------------------------------------------
// Search (Alexandria-style)
//
// Each result carries next actions, not just a description:
//   { manifest, score, actions: ['invoke', 'inspect', 'watch'] }
// "Search returns both content AND tools to go further" — the actions
// are the search-time promise of what the caller can do next with a
// match: invoke it, inspect its manifest/rubric, or watch it for
// version/pricing changes.
//
// Scoring is deterministic: weighted keyword hits (title > name >
// provider/category > description), ties broken alphabetically with
// the newest version first.
// ---------------------------------------------------------------------------

const ACTIONS = ['invoke', 'inspect', 'watch'];

function tokenize(query) {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreManifest(m, tokens) {
  const title = m.title.toLowerCase();
  const name = m.name.toLowerCase();
  const provider = m.provider.toLowerCase();
  const category = String(m.category || '').toLowerCase();
  const description = m.description.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (title.includes(t)) score += 3;
    if (name.includes(t)) score += 2;
    if (provider.includes(t)) score += 1.5;
    if (category.includes(t)) score += 1.5;
    if (description.includes(t)) score += 1;
  }
  return score;
}

function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

function tieBreak(a, b) {
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return compareVersionsDesc(a.version, b.version);
}

/**
 * @param {CapabilityRegistry} registry
 * @param {string} query - keyword query
 * @param {Object} [opts]
 * @param {string} [opts.category] - restrict to one category
 * @param {number} [opts.limit=10]
 * @returns {Array<{manifest, score, actions}>} sorted by score desc, deterministic
 */
export function search(registry, query, { category, limit = 10 } = {}) {
  if (!registry || typeof registry.list !== 'function') {
    throw new TypeError('search: a CapabilityRegistry is required');
  }
  if (typeof query !== 'string') {
    throw new TypeError('search: query must be a string');
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError('search: limit must be a positive integer');
  }
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results = [];
  for (const m of registry.list({ category })) {
    const score = scoreManifest(m, tokens);
    if (score > 0) {
      results.push({ manifest: m, score, actions: [...ACTIONS] });
    }
  }
  results.sort((a, b) => b.score - a.score || tieBreak(a.manifest, b.manifest));
  return results.slice(0, limit);
}

export const NEXT_ACTIONS = [...ACTIONS];
