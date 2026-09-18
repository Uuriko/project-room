// Inbox snippet library (Superhuman-style snippets). In-memory,
// fixture-driven: create / list / get / update / remove, and expand a snippet
// body with {{variable}} substitution. Variables support a fallback with
// {{variable|fallback}}; an unknown variable without a fallback throws in
// strict mode. No network I/O, no secrets, frozen outputs.
class SnippetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SnippetError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new SnippetError(code, message);
};
const check = (condition, code, message) => {
  if (!condition) fail(code, message);
};

export const MAX_SNIPPETS = 500;
export const SHORTCUT_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

// Split a body into literal/variable segments so callers can preview which
// variables a snippet needs before expanding.
export function parseVariables(body) {
  check(typeof body === "string", "SNIP_INVALID_INPUT", "body must be a string");
  const variables = [];
  const seen = new Set();
  let match;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(body)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      variables.push(Object.freeze({ name, fallback: match[2] === undefined ? null : match[2] }));
    }
  }
  return Object.freeze(variables);
}

/**
 * Expand {{variable}} placeholders using vars. Unknown variables with no
 * fallback throw SNIP_UNKNOWN_VARIABLE in strict mode (default); in lenient
 * mode the placeholder is left in place.
 */
export function expandBody(body, vars = {}, { strict = true } = {}) {
  check(typeof body === "string", "SNIP_INVALID_INPUT", "body must be a string");
  check(vars !== null && typeof vars === "object" && !Array.isArray(vars), "SNIP_INVALID_INPUT", "vars must be an object");
  VARIABLE_PATTERN.lastIndex = 0;
  return body.replace(VARIABLE_PATTERN, (placeholder, name, fallback) => {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (value === undefined || value === null) {
      if (fallback !== undefined) return fallback;
      if (!strict) return placeholder;
      fail("SNIP_UNKNOWN_VARIABLE", `No value for variable '${name}' and no fallback`);
    }
    check(typeof value === "string" || typeof value === "number", "SNIP_INVALID_INPUT", `Variable '${name}' must be a string or number`);
    return String(value);
  });
}

const snapshot = snippet =>
  Object.freeze({
    shortcut: snippet.shortcut,
    name: snippet.name,
    body: snippet.body,
    variables: parseVariables(snippet.body),
    createdAt: snippet.createdAt,
    updatedAt: snippet.updatedAt,
    useCount: snippet.useCount,
  });

/** Create an in-memory snippet library. */
export function createSnippetLibrary(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const snippets = new Map();

  const getOrThrow = shortcut => {
    check(typeof shortcut === "string", "SNIP_INVALID_INPUT", "shortcut must be a string");
    const snippet = snippets.get(shortcut);
    if (!snippet) fail("SNIP_UNKNOWN_SNIPPET", `Unknown snippet '${shortcut}'`);
    return snippet;
  };

  const validateNew = ({ shortcut, name, body }) => {
    check(SHORTCUT_PATTERN.test(shortcut), "SNIP_INVALID_INPUT",
      "shortcut must be 2..32 chars: lowercase letters, digits, _ or -, starting alphanumeric");
    check(typeof name === "string" && name.length > 0 && name.length <= 120, "SNIP_INVALID_INPUT", "name must be 1..120 characters");
    check(typeof body === "string" && body.length > 0 && body.length <= 20000, "SNIP_INVALID_INPUT", "body must be 1..20000 characters");
  };

  const library = {
    create({ shortcut, name, body }) {
      validateNew({ shortcut, name, body });
      check(!snippets.has(shortcut), "SNIP_DUPLICATE", `Snippet '${shortcut}' already exists`);
      check(snippets.size < MAX_SNIPPETS, "SNIP_CAPACITY", "Snippet capacity reached");
      const now = clock();
      const snippet = { shortcut, name, body, createdAt: now, updatedAt: now, useCount: 0 };
      snippets.set(shortcut, snippet);
      return snapshot(snippet);
    },

    /** Expand a snippet; increments its use count. */
    expand(shortcut, vars = {}, options = {}) {
      const snippet = getOrThrow(shortcut);
      const expanded = expandBody(snippet.body, vars, options);
      snippet.useCount += 1;
      snippet.updatedAt = clock();
      return Object.freeze({ shortcut, expanded, useCount: snippet.useCount });
    },

    /** Update name/body (shortcut is immutable — create a new one to rename). */
    update(shortcut, { name, body }) {
      const snippet = getOrThrow(shortcut);
      if (name !== undefined) {
        check(typeof name === "string" && name.length > 0 && name.length <= 120, "SNIP_INVALID_INPUT", "name must be 1..120 characters");
        snippet.name = name;
      }
      if (body !== undefined) {
        check(typeof body === "string" && body.length > 0 && body.length <= 20000, "SNIP_INVALID_INPUT", "body must be 1..20000 characters");
        snippet.body = body;
      }
      snippet.updatedAt = clock();
      return snapshot(snippet);
    },

    remove(shortcut) {
      const existed = snippets.delete(shortcut);
      check(existed, "SNIP_UNKNOWN_SNIPPET", `Unknown snippet '${shortcut}'`);
      return Object.freeze({ shortcut, removed: true });
    },

    get(shortcut) {
      return snapshot(getOrThrow(shortcut));
    },

    /** List all snippets, most-used first, then by shortcut. */
    list() {
      return Object.freeze(
        [...snippets.values()]
          .sort((a, b) => b.useCount - a.useCount || (a.shortcut < b.shortcut ? -1 : 1))
          .map(snapshot)
      );
    },

    /** Prefix/substring search over shortcut + name (for the palette). */
    search(query) {
      check(typeof query === "string", "SNIP_INVALID_INPUT", "query must be a string");
      const q = query.trim().toLowerCase();
      if (!q) return Object.freeze([]);
      return Object.freeze(
        this.list().filter(snippet =>
          snippet.shortcut.toLowerCase().includes(q) || snippet.name.toLowerCase().includes(q))
      );
    },

    count() {
      return snippets.size;
    },
  };

  return Object.freeze(library);
}

export { SnippetError };
