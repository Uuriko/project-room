// Route-table dispatcher (batch RT).
//
// Compiles ROUTES into a segment trie. A known path with the wrong method
// answers 405 and sets Allow. A mount matches its path and every path under
// it for any method, and the handler decides. An unknown path returns false
// so the legacy chain in server/http.mjs can still serve it.
//
// F-3 contract: the row's `auth` column is ENFORCED ONLY when ctx.pipeline
// is set. When pipeline is unset, `auth` is documentation — the handler
// MUST enforce its own authorization. Never add a row that relies on the
// column alone without also setting ctx.pipeline at the call site.

import { ROUTES, assertRouteTable } from "./table.mjs";

assertRouteTable(ROUTES);

const PARAM = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const compiled = new WeakMap();

function node() {
  return { static: new Map(), param: null, methods: new Map() };
}

export function compileRoutes(routes) {
  const root = node();
  const mounts = [];
  for (const row of routes) {
    // A mount matches its path and every deeper path, for any method. The
    // handler owns session and method checks, so mounts skip the method
    // trie (which would answer 405 before the session check).
    if (row.mount) {
      mounts.push(row);
      continue;
    }
    const segments = row.path.split("/").filter(Boolean);
    let cursor = root;
    for (const segment of segments) {
      const param = PARAM.exec(segment);
      if (param) {
        if (!cursor.param) cursor.param = { name: param[1], next: node() };
        else if (cursor.param.name !== param[1]) throw new Error(`route param conflict at ${row.method} ${row.path}`);
        cursor = cursor.param.next;
      } else {
        if (!cursor.static.has(segment)) cursor.static.set(segment, node());
        cursor = cursor.static.get(segment);
      }
    }
    if (cursor.methods.has(row.method)) throw new Error(`duplicate route ${row.method} ${row.path}`);
    cursor.methods.set(row.method, row);
  }
  return { root, mounts };
}

function compiledFor(routes) {
  if (!compiled.has(routes)) compiled.set(routes, compileRoutes(routes));
  return compiled.get(routes);
}

function walk(cursor, segments, index, params) {
  if (index === segments.length) return cursor.methods.size ? { node: cursor, params } : null;
  const segment = segments[index];
  const exact = cursor.static.get(segment);
  if (exact) {
    const found = walk(exact, segments, index + 1, params);
    if (found) return found;
  }
  if (!cursor.param) return null;
  let decoded;
  try { decoded = decodeURIComponent(segment); }
  catch { return null; }
  return walk(cursor.param.next, segments, index + 1, { ...params, [cursor.param.name]: decoded });
}

function matchMount(mounts, pathname) {
  let best = null;
  for (const row of mounts) {
    if (row.path.includes("{")) continue;
    if (pathname !== row.path && !pathname.startsWith(`${row.path}/`)) continue;
    if (!best || row.path.length > best.path.length) best = row;
  }
  return best;
}

export function matchRoute(routes, method, pathname) {
  const { root, mounts } = compiledFor(routes);
  const segments = pathname.split("/").filter(Boolean);
  const found = walk(root, segments, 0, {});
  if (found) {
    const upper = String(method || "").toUpperCase();
    const methodNames = [...found.node.methods.keys()];
    return { row: found.node.methods.get(upper) ?? null, allow: methodNames.sort(),
      params: found.params, authRow: found.node.methods.get(methodNames[0]) };
  }
  const mount = matchMount(mounts, pathname);
  return mount ? { row: mount, allow: [], params: {} } : null;
}

const ENTITY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// "integer" is a first-class JSON-Schema type that the old typeOf never
// produced, so any schema declaring it rejected every value with a 422
// (2026-10-04 bughunt: sessionRevision on five auth routes, step on
// inbox.setup.write, expiresAt on the spend-grant issue route). A schema may
// also name a list of acceptable types, e.g. { type: ["array", "null"] }.
function typeMatches(schemaType, value) {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  return types.some(t =>
    t === "integer"
      ? typeof value === "number" && Number.isInteger(value)
      : typeOf(value) === t);
}

// The subset the handlers actually enforce: type, enum, required,
// additionalProperties, properties, minProperties, maxProperties.
export function schemaErrors(schema, value, path = "") {
  if (!schema || typeof schema !== "object") return [];
  const errors = [];
  const here = path || "(root)";
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${here} should be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
    return errors;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${here} is not an allowed value`);
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (Number.isInteger(schema.minProperties) && keys.length < schema.minProperties) errors.push(`${here} has too few properties`);
    if (Number.isInteger(schema.maxProperties) && keys.length > schema.maxProperties) errors.push(`${here} has too many properties`);
    if (Array.isArray(schema.required))
      for (const key of schema.required) if (!Object.hasOwn(value, key)) errors.push(`${here}.${key} is required`);
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : null;
    for (const key of keys) {
      if (properties && Object.hasOwn(properties, key)) errors.push(...schemaErrors(properties[key], value[key], `${here}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${here}.${key} is not allowed`);
    }
  }
  return errors;
}

function requireStep(ctx, name, message) {
  if (typeof ctx[name] !== "function") ctx.reject(500, "internal_error", message);
}

async function runPipeline(ctx, row) {
  if (row.auth !== "none") {
    requireStep(ctx, "authorize", "Route auth is not available");
    await ctx.authorize(row, ctx);
  }
  if (row.schema.body && ENTITY.has(row.method)) {
    requireStep(ctx, "readJson", "Route body reader is not available");
    const value = await ctx.readJson(row.bodyLimit ?? 16 * 1024);
    const problems = schemaErrors(row.schema.body, value);
    if (problems.length) ctx.reject(422, "invalid_body", problems[0]);
    ctx.body = value;
  }
  ctx.params = ctx.params ?? {};
  await row.handler(ctx);
}

// Authenticate protected paths before exposing their method surface.
async function denyMethod(ctx, found) {
  if (typeof found.authRow?.authenticate === "function") await found.authRow.authenticate(ctx);
  if (found.authRow?.auth === "room" && typeof ctx.roomCredentials === "function") {
    const selected = ctx.roomCredentials(ctx.req, ctx.url);
    const fence = selected.mode === "account" ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
    ctx.roomAuth(selected, found.params.roomId, fence);
  }
  ctx.res.setHeader("Allow", found.allow.join(", "));
  ctx.reject(405, "method_not_allowed", "Method not allowed");
}

export async function dispatchRoute(ctx, routes = ROUTES) {
  if (!routes || routes.length === 0) return false;
  const found = matchRoute(routes, ctx.req.method, ctx.url.pathname);
  if (!found) return false;
  if (!found.row) return denyMethod(ctx, found);
  ctx.params = found.params;
  ctx.route = found.row;
  if (ctx.pipeline) await runPipeline(ctx, found.row);
  else await found.row.handler(ctx);
  return true;
}
