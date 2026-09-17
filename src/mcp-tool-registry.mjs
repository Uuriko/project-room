/**
 * mcp-tool-registry.mjs — Central MCP tool catalog (pure registry).
 *
 * Holds validated, frozen tool definitions that the MCP server surface
 * (scripts/agent-mcp.mjs, server routes) can enumerate without re-scanning
 * code. Pure registry: NO network, NO DOM, NO secrets, NO filesystem.
 *
 * Tool definition:
 *   {
 *     name:           string   — ^[a-z][a-z0-9.-]*$ (e.g. "room.post_draft")
 *     version:        string   — semver-ish MAJOR.MINOR.PATCH (+ pre/build)
 *     inputSchema:    object   — JSON-schema-ish { properties: {...}, required: [...] }
 *     description:    string   — human-readable, non-empty
 *     scopesRequired: string[] — capability scopes needed to invoke
 *     deprecated?:    boolean
 *   }
 *
 * Dependency injection (all via the `deps` parameter of createMcpToolRegistry):
 *   - clock: () => number  (ms epoch; default: Date.now) — stamps
 *     registeredAt / deprecatedAt.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   TR_INVALID_NAME    — name missing or fails ^[a-z][a-z0-9.-]*$
 *   TR_INVALID_VERSION — version missing or not semver-ish
 *   TR_INVALID_SCHEMA  — def not an object, inputSchema not an object,
 *                        description empty, scopesRequired not a string[]
 *   TR_TOOL_EXISTS     — register() duplicate name+version
 *   TR_NOT_FOUND       — get/unregister/deprecate/validateArgs for an
 *                        unknown name+version (or no live version for get(name))
 * Failures are never silent. All stored definitions are deep-frozen.
 */

const NAME_RE = /^[a-z][a-z0-9.-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;

const CHECKED_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

/** Throw a coded registry error (never silent failures). */
function toolError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Deep-freeze an object graph (defs are immutable once registered). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Compare two semver-ish strings: -1 / 0 / 1. Pre-release sorts below release. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+[a-zA-Z0-9.-]+)?$/.exec(v);
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null];
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === null) return 1; // release > pre-release
  if (pb[3] === null) return -1;
  return pa[3] < pb[3] ? -1 : 1;
}

/** Validate a tool definition; returns a normalized plain object. */
function validateDef(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw toolError('TR_INVALID_SCHEMA', 'Tool definition must be an object');
  }
  const { name, version, inputSchema, description, scopesRequired, deprecated } = def;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw toolError(
      'TR_INVALID_NAME',
      `Tool name must match ${NAME_RE}, got ${JSON.stringify(name)}`,
    );
  }
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw toolError(
      'TR_INVALID_VERSION',
      `Version must be semver-ish (MAJOR.MINOR.PATCH), got ${JSON.stringify(version)}`,
    );
  }
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw toolError('TR_INVALID_SCHEMA', 'inputSchema must be a plain object');
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw toolError('TR_INVALID_SCHEMA', 'description must be a non-empty string');
  }
  if (!Array.isArray(scopesRequired) || scopesRequired.some((s) => typeof s !== 'string')) {
    throw toolError('TR_INVALID_SCHEMA', 'scopesRequired must be an array of strings');
  }
  if (deprecated !== undefined && typeof deprecated !== 'boolean') {
    throw toolError('TR_INVALID_SCHEMA', 'deprecated must be a boolean when present');
  }
  return {
    name,
    version,
    inputSchema: JSON.parse(JSON.stringify(inputSchema)),
    description,
    scopesRequired: [...scopesRequired],
    deprecated: deprecated === true,
  };
}

/** Check one value against a schema property; push error objects into errors. */
function checkProperty(field, schemaProp, value, errors) {
  const prop = schemaProp && typeof schemaProp === 'object' ? schemaProp : {};
  if (prop.type !== undefined) {
    if (!CHECKED_TYPES.has(prop.type)) {
      // Unknown declared type: flag schema misuse as a validation error.
      errors.push({ field, message: `unsupported declared type ${JSON.stringify(prop.type)}` });
      return;
    }
    const actual =
      value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : typeof value;
    if (actual !== prop.type) {
      errors.push({ field, message: `expected ${prop.type}, got ${actual}` });
      return; // skip enum/min-max checks on wrong-typed values
    }
  }
  if (prop.enum !== undefined && !prop.enum.some((v) => v === value)) {
    errors.push({ field, message: `value ${JSON.stringify(value)} not in enum` });
  }
  const min = prop.minimum !== undefined ? prop.minimum : prop.min;
  const max = prop.maximum !== undefined ? prop.maximum : prop.max;
  if (typeof value === 'number') {
    if (min !== undefined && value < min) errors.push({ field, message: `below minimum ${min}` });
    if (max !== undefined && value > max) errors.push({ field, message: `above maximum ${max}` });
  }
  if (typeof value === 'string') {
    if (prop.minLength !== undefined && value.length < prop.minLength) {
      errors.push({ field, message: `shorter than minLength ${prop.minLength}` });
    }
    if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      errors.push({ field, message: `longer than maxLength ${prop.maxLength}` });
    }
  }
  if (Array.isArray(value)) {
    if (prop.minItems !== undefined && value.length < prop.minItems) {
      errors.push({ field, message: `fewer items than minItems ${prop.minItems}` });
    }
    if (prop.maxItems !== undefined && value.length > prop.maxItems) {
      errors.push({ field, message: `more items than maxItems ${prop.maxItems}` });
    }
  }
}

/**
 * Create a new MCP tool registry.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 */
export function createMcpToolRegistry(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  /** Map<name, Map<version, frozenDef>> */
  const tools = new Map();

  const keyOf = (name, version) => `${name}@${version}`;

  /** Resolve a definition; throws TR_NOT_FOUND when absent. */
  function resolve(name, version) {
    const versions = tools.get(name);
    if (!versions) {
      throw toolError('TR_NOT_FOUND', `No tool registered under name ${JSON.stringify(name)}`);
    }
    if (version !== undefined) {
      const def = versions.get(version);
      if (!def) {
        throw toolError(
          'TR_NOT_FOUND',
          `Tool ${keyOf(name, version)} is not registered`,
        );
      }
      return def;
    }
    const live = [...versions.values()].filter((d) => !d.deprecated);
    if (live.length === 0) {
      throw toolError(
        'TR_NOT_FOUND',
        `Tool ${JSON.stringify(name)} has no non-deprecated version registered`,
      );
    }
    live.sort((a, b) => compareVersions(a.version, b.version));
    return live[live.length - 1]; // latest non-deprecated
  }

  return {
    /**
     * Register a tool definition. Duplicate name+version → TR_TOOL_EXISTS.
     * Returns the stored (frozen) definition.
     */
    register(def) {
      const normalized = validateDef(def);
      let versions = tools.get(normalized.name);
      if (!versions) {
        versions = new Map();
        tools.set(normalized.name, versions);
      }
      if (versions.has(normalized.version)) {
        throw toolError(
          'TR_TOOL_EXISTS',
          `Tool ${keyOf(normalized.name, normalized.version)} is already registered`,
        );
      }
      const stored = deepFreeze({
        ...normalized,
        registeredAt: clock(),
        deprecatedAt: normalized.deprecated ? clock() : null,
      });
      versions.set(normalized.version, stored);
      return stored;
    },

    /** Get a definition by name, optionally pinned to a version. */
    get(name, version) {
      return resolve(name, version);
    },

    /**
     * List all definitions, sorted by name then version.
     * @param {object} [opts]
     * @param {boolean} [opts.includeDeprecated=false]
     */
    list(opts = {}) {
      const includeDeprecated = opts.includeDeprecated === true;
      const all = [];
      for (const versions of tools.values()) {
        for (const def of versions.values()) {
          if (!includeDeprecated && def.deprecated) continue;
          all.push(def);
        }
      }
      all.sort((a, b) =>
        a.name === b.name ? compareVersions(a.version, b.version) : a.name < b.name ? -1 : 1,
      );
      return all;
    },

    /**
     * Remove a registered tool version. Throws TR_NOT_FOUND when absent.
     * Returns the removed (frozen) definition.
     */
    unregister(name, version) {
      const versions = tools.get(name);
      if (!versions || !versions.has(version)) {
        throw toolError(
          'TR_NOT_FOUND',
          `Tool ${keyOf(name, version)} is not registered`,
        );
      }
      const def = versions.get(version);
      versions.delete(version);
      if (versions.size === 0) tools.delete(name);
      return def;
    },

    /**
     * Mark a version deprecated (idempotent; clock-stamps deprecatedAt on
     * first call). Throws TR_NOT_FOUND when absent.
     */
    deprecate(name, version) {
      const def = resolve(name, version);
      if (def.deprecated) return def;
      const versions = tools.get(name);
      const marked = deepFreeze({
        ...def,
        deprecated: true,
        deprecatedAt: clock(),
      });
      versions.set(version, marked);
      return marked;
    },

    /**
     * Validate invocation args against the tool's inputSchema.
     * Checks required fields, types, enum, minimum/maximum, min/max aliases,
     * minLength/maxLength, minItems/maxItems.
     * @returns {{ ok: boolean, errors: Array<{ field: string, message: string }> }}
     */
    validateArgs(name, version, args) {
      const def = resolve(name, version);
      const errors = [];
      const schema = def.inputSchema;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return {
          ok: false,
          errors: [{ field: '', message: 'args must be an object' }],
        };
      }
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const field of required) {
        if (args[field] === undefined) {
          errors.push({ field, message: 'missing required field' });
        }
      }
      const properties =
        schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
      for (const [field, prop] of Object.entries(properties)) {
        if (args[field] !== undefined) checkProperty(field, prop, args[field], errors);
      }
      return { ok: errors.length === 0, errors };
    },

    /**
     * Case-insensitive substring search over name and description.
     * @param {object} [opts]
     * @param {boolean} [opts.includeDeprecated=false]
     */
    search(query, opts = {}) {
      if (typeof query !== 'string' || query.trim() === '') {
        throw toolError('TR_INVALID_SCHEMA', 'search query must be a non-empty string');
      }
      const needle = query.toLowerCase();
      return this.list(opts).filter(
        (d) => d.name.toLowerCase().includes(needle) || d.description.toLowerCase().includes(needle),
      );
    },
  };
}

export const NAME_PATTERN = NAME_RE.source;
export const VERSION_PATTERN = SEMVER_RE.source;
