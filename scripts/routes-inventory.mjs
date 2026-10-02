// Legacy route inventory (batch RT).
//
// Walks the routes the server still serves outside the route table and writes
// scripts/routes-legacy-allowlist.json. The allowlist is the parity baseline:
// it only shrinks as extraction PRs move a group into server/routes/table.mjs.
// A route still implemented in the legacy chain and missing from the allowlist
// fails the check. A new legacy route cannot be added to the baseline.
//
// Path templates come from the same extractors as the open-route gate.
// Methods come from the handlers: explicit comparisons, 405 Allow values, and
// the route-name switches in the feature modules.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { routeCandidates } from "./open-routes.mjs";
import { nextActionsRouteTemplates, pluginRouteTemplates, workerRouteTemplates } from "./route-docs-check.mjs";
import { A2A_PATHS } from "../server/a2a-jsonrpc.mjs";
import { ROOM_MCP_PATHS } from "../src/room-mcp-join.js";
import { DISCOVERY_PATHS, HEALTH_ALIAS_PATHS } from "../deploy/agent-discovery.mjs";
import { PUBLIC_DOOR_PATHS } from "../deploy/room-entry.mjs";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const ALLOWLIST = "scripts/routes-legacy-allowlist.json";

export const templateKey = path => path.replace(/\{[^}]+\}/g, "{}");

const routeKey = (method, path) => `${method} ${templateKey(path)}`;

function readConstants(root) {
  const read = path => readFileSync(join(root, path), "utf8");
  const grab = (text, name) => {
    const match = new RegExp(`export const ${name} = ["']([^"']+)["']`).exec(text);
    if (!match) throw new Error(`missing ${name}`);
    return match[1];
  };
  const google = read("server/google-oauth.mjs");
  const github = read("server/github-oauth.mjs");
  const manifest = read("server/agent-plugin-manifest.mjs");
  return {
    GOOGLE_START_PATH: grab(google, "GOOGLE_START_PATH"),
    GOOGLE_CALLBACK_PATH: grab(google, "GOOGLE_CALLBACK_PATH"),
    GITHUB_START_PATH: grab(github, "GITHUB_START_PATH"),
    GITHUB_CALLBACK_PATH: grab(github, "GITHUB_CALLBACK_PATH"),
    WELL_KNOWN_PATH: grab(manifest, "WELL_KNOWN_PATH"),
  };
}

function substitute(source, constants) {
  let text = source;
  const block = text.match(/const connectionRoutes = Object\.freeze\(\{([\s\S]*?)\}\)/);
  if (block) {
    for (const match of block[1].matchAll(/(\w+):\s*["']([^"']+)["']/g)) {
      text = text.replaceAll(`connectionRoutes.${match[1]}`, JSON.stringify(match[2]));
    }
  }
  for (const [name, value] of Object.entries(constants)) text = text.replaceAll(name, JSON.stringify(value));
  return text;
}

function matchCloser(text, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") { i = text.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function eachIf(source, visit) {
  const re = /\bif\s*\(/g;
  let match;
  while ((match = re.exec(source))) {
    const open = match.index + match[0].length - 1;
    const close = matchCloser(source, open, "(", ")");
    if (close < 0) continue;
    const condition = source.slice(open + 1, close);
    let bodyStart = close + 1;
    while (bodyStart < source.length && /\s/.test(source[bodyStart])) bodyStart++;
    let body = "";
    if (source[bodyStart] === "{") {
      const end = matchCloser(source, bodyStart, "{", "}");
      body = end < 0 ? "" : source.slice(bodyStart + 1, end);
    } else {
      const end = source.indexOf("\n", bodyStart);
      body = source.slice(bodyStart, end < 0 ? source.length : end);
    }
    visit(condition, body);
    re.lastIndex = close + 1;
  }
}

function quotedList(text) {
  return [...text.matchAll(/["']([A-Z]+)["']/g)].map(match => match[1]).filter(method => METHODS.includes(method));
}

function methodsFrom(condition, body) {
  const found = new Set();
  const allow = /Allow:\s*["']([A-Z, ]+)["']/.exec(`${condition}\n${body}`);
  if (allow) for (const method of quotedList(allow[1])) found.add(method);
  for (const match of condition.matchAll(/(?:req\.method|method)\s*===\s*["']([A-Z]+)["']/g)) found.add(match[1]);
  const includes = /!?\[([^\]]*)\]\.includes\(\s*(?:req\.method|method)\s*\)/.exec(condition);
  if (includes) for (const method of quotedList(includes[1])) found.add(method);
  if (/!\s*readMethod\(\s*req\.method\s*\)/.test(condition) && /reject\(\s*405/.test(body)) {
    found.add("GET");
    found.add("HEAD");
  }
  if (/(?:req\.method|method)\s*!==/.test(condition) && /reject\(\s*405/.test(body) && found.size === 0) {
    for (const match of condition.matchAll(/(?:req\.method|method)\s*!==\s*["']([A-Z]+)["']/g)) found.add(match[1]);
  }
  for (const method of [...found]) if (!METHODS.includes(method)) found.delete(method);
  return found;
}

function topLevelMethods(body) {
  const found = new Set();
  if (/!\s*readMethod\(\s*req\.method\s*\)/.test(body) && /reject\(\s*405/.test(body)) {
    found.add("GET");
    found.add("HEAD");
  }
  eachIf(body, (condition, inner) => {
    if (/pathname|\.exec\(/.test(condition)) return;
    for (const method of methodsFrom(condition, inner)) found.add(method);
  });
  return found;
}

// A route if sometimes only calls a helper that owns the method check
// (/.well-known/security.txt). Methods come from that helper's body.
function withCalledHelpers(source, body) {
  let extra = body;
  for (const match of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const decl = new RegExp(`function ${match[1]}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
    if (!decl) continue;
    const open = source.indexOf("{", decl.index);
    const close = matchCloser(source, open, "{", "}");
    if (close > open) extra += "\n" + source.slice(open + 1, close);
  }
  return extra;
}

function literalPaths(condition) {
  return [...condition.matchAll(/(?:url\.)?pathname\s*===\s*["']([^"']+)["']/g)].map(match => match[1]);
}

function regexToTemplates(body) {
  const template = body.replaceAll("\\/", "/");
  const optional = /\(\?:\/\(([^()]+)\)\)\?/.exec(template);
  const variants = optional
    ? ["", ...optional[1].split("|").map(part => "/" + part)].map(part => template.replace(optional[0], part))
    : [template];
  const paths = [];
  for (const variant of variants) {
    let path = variant.replace(/\(\[[^\]]+\](?:\{[^}]+\})?\)/g, "{id}");
    path = path.replace(/\([^()]*\|[^()]*\)/g, "{id}");
    path = path.replace(/\([^()]+\)/g, "{id}");
    path = path.replace(/[\\^$]/g, "");
    if (path.startsWith("/") && !/[()[\]|?*+]/.test(path)) paths.push(path);
  }
  return paths;
}

function indexRegexConsts(source) {
  const consts = new Map();
  const text = unescapeRegexLiterals(source);
  for (const match of text.matchAll(/const ([A-Za-z0-9_]+) = \/\^([\s\S]*?)\$\/[;.]/g)) {
    const paths = regexToTemplates(match[2]);
    if (paths.length) consts.set(match[1], paths);
  }
  for (const match of source.matchAll(/const (\w+) = routePattern\("([^"]+)"\)\.exec/g)) {
    consts.set(match[1], [match[2]]);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const match of text.matchAll(/const (\w+) = ((?:\w+\s*(?:\?\?|\|\|)\s*)+\w+)\s*;/g)) {
      if (consts.has(match[1])) continue;
      const parts = match[2].split(/\s*(?:\?\?|\|\|)\s*/);
      const paths = parts.flatMap(part => consts.get(part) ?? []);
      if (paths.length) {
        consts.set(match[1], [...new Set(paths)]);
        grew = true;
      }
    }
  }
  return consts;
}

function unescapeRegexLiterals(source) {
  return source.replace(/\/\^[\s\S]*?\$\//g, literal => literal.replaceAll("\\/", "/"));
}

function routeNameMap(source) {
  const names = new Map();
  const text = unescapeRegexLiterals(source);
  const alternation = text.match(/\(commands\|events\|[a-z0-9|-]+\)/);
  if (alternation) {
    for (const name of alternation[0].slice(1, -1).split("|")) names.set(name, `/api/rooms/{id}/${name}`);
    names.set("", "/api/rooms/{id}");
  }
  for (const match of text.matchAll(/\/api\/rooms\/\(\[\^\/\]\{1,\d+\}\)\/\(([a-z0-9_|-]+)\)/g)) {
    for (const name of match[1].split("|")) if (!names.has(name)) names.set(name, `/api/rooms/{id}/${name}`);
  }
  return names;
}

// The last arm of a route ternary is a bare string, not `match ? "name"`.
// The path lives on the match const that arm stands in for.
const TERMINAL_ELSE = {
  route: { "ownership-transfer": "ownershipTransferMatch" },
  workClaimRoute: { reassign: "workClaimReassignMatch" },
  feedbackRoute: { read: "feedbackItemMatch" },
  escrowRoute: { "epoch-close": "creditsEpochMatch" },
  collabRoute: { "handoff-transition": "collabHandoffTransitionMatch" },
};

function matcherPaths(source) {
  const consts = indexRegexConsts(source);
  const byVar = new Map();
  const chains = source.matchAll(/const (workClaimRoute|feedbackRoute|escrowRoute|collabRoute|route) = ([\s\S]*?);/g);
  for (const chain of chains) {
    const variable = chain[1];
    for (const link of chain[2].matchAll(/(\w+)\s*\?\s*(?:\(\s*\[[^\]]+\]\.includes\(\s*req\.method\s*\)\s*\?\s*"([a-z0-9-]+)"\s*:\s*"([a-z0-9-]+)"\s*\)|\(\s*req\.method === "GET" \? "([a-z0-9-]+)" : "([a-z0-9-]+)"\s*\)|"([a-z0-9-]+)")/g)) {
      const paths = consts.get(link[1]);
      if (!paths) continue;
      const routeNames = [link[2], link[3], link[4], link[5], link[6]].filter(Boolean);
      for (const routeName of routeNames) byVar.set(`${variable}:${routeName}`, paths);
    }
    const tail = /:\s*"([a-z0-9-]+)"\s*$/.exec(chain[2].trim());
    const binding = tail ? TERMINAL_ELSE[variable]?.[tail[1]] : null;
    const tailPaths = binding ? consts.get(binding) : null;
    if (tailPaths) byVar.set(`${variable}:${tail[1]}`, tailPaths);
  }
  return { consts, byVar };
}

function codeIdentifiers(condition) {
  const stripped = condition
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'])*'/g, "''")
    .replace(/"(?:\\.|[^"])*"/g, '""')
    .replace(/`(?:\\.|[^`])*`/g, "``");
  return [...stripped.matchAll(/(?<![.\w!])([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(match => match[1]);
}

function boundPaths(condition, bindings) {
  const paths = [];
  const seen = new Set();
  for (const name of codeIdentifiers(condition)) {
    const found = bindings.get(name);
    if (!found) continue;
    for (const path of found) if (!seen.has(path)) { seen.add(path); paths.push(path); }
  }
  return paths;
}

function addRoute(bag, method, path) {
  if (!METHODS.includes(method) || typeof path !== "string" || !path.startsWith("/")) return;
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const key = routeKey(method, normalized);
  if (!bag.has(key)) bag.set(key, { method, path: normalized });
}

function scanSwitches(source, names, bag) {
  const re = /switch\s*\(\s*(collabRoute)\s*\)\s*\{/g;
  let match;
  while ((match = re.exec(source))) {
    const open = source.indexOf("{", match.index);
    const close = matchCloser(source, open, "{", "}");
    if (close < 0) continue;
    const body = source.slice(open + 1, close);
    const caseRe = /case\s+"([a-z0-9-]+)"\s*:\s*\{/g;
    let item;
    while ((item = caseRe.exec(body))) {
      const brace = body.indexOf("{", item.index);
      const end = matchCloser(body, brace, "{", "}");
      if (end < 0) continue;
      const paths = names.get(`collabRoute:${item[1]}`);
      if (!paths) continue;
      const methods = topLevelMethods(body.slice(brace + 1, end));
      for (const method of methods) for (const path of paths) addRoute(bag, method, path);
    }
    re.lastIndex = close + 1;
  }
}

function scanSource(source, bag, { names, matchers, bindings }) {
  const apply = (methods, paths) => {
    for (const method of methods) for (const path of paths) addRoute(bag, method, path);
  };
  eachIf(source, (condition, body) => {
    const direct = literalPaths(condition);
    const bound = boundPaths(condition, bindings);
    const visible = withCalledHelpers(source, body);
    let methods = methodsFrom(condition, visible);
    const targets = [...direct, ...bound];
    if (methods.size === 0 && targets.length) methods = topLevelMethods(visible);
    apply(methods, targets);
    // A pathname check nested under a method gate (Gmail's POST guard, for
    // example) does not repeat the method. It serves the enclosing methods.
    if (methods.size) {
      eachIf(body, (innerCondition, innerBody) => {
        const innerTargets = [...literalPaths(innerCondition), ...boundPaths(innerCondition, bindings)];
        if (!innerTargets.length) return;
        let innerMethods = methodsFrom(innerCondition, innerBody);
        if (innerMethods.size === 0) innerMethods = topLevelMethods(innerBody);
        if (innerMethods.size === 0) apply(methods, innerTargets);
      });
    }

    const routeNames = new Set();
    if (/(?:^|[^.\w])!route\b/.test(condition)) routeNames.add("");
    for (const match of condition.matchAll(/(?:^|[^.\w])route\s*===\s*["']([a-z0-9-]+)["']/g)) routeNames.add(match[1]);
    const included = /\[([^\]]+)\]\.includes\(\s*route\s*\)/.exec(condition);
    if (included) for (const match of included[1].matchAll(/["']([a-z0-9-]+)["']/g)) routeNames.add(match[1]);
    if (routeNames.size) {
      let routeMethods = methodsFrom(condition, body);
      if (routeMethods.size === 0) routeMethods = topLevelMethods(body);
      for (const name of routeNames) {
        const paths = new Set([
          ...(matchers.get(`route:${name}`) ?? []),
          ...(names.has(name) ? [names.get(name)] : []),
        ]);
        for (const method of routeMethods) for (const path of paths) addRoute(bag, method, path);
      }
    }

    for (const variable of ["workClaimRoute", "feedbackRoute", "escrowRoute", "collabRoute"]) {
      const named = [...condition.matchAll(new RegExp(`${variable}\\s*===\\s*["']([a-z0-9-]+)["']`, "g"))];
      if (!named.length) continue;
      let routeMethods = methodsFrom(condition, body);
      if (routeMethods.size === 0) routeMethods = topLevelMethods(body);
      for (const match of named) {
        const paths = matchers.get(`${variable}:${match[1]}`);
        if (!paths) continue;
        for (const method of routeMethods) for (const path of paths) addRoute(bag, method, path);
      }
    }
  });

  for (const match of source.matchAll(/const (\w+) = method === "([A-Z]+)" \? (\w+)\.exec\(pathname\)/g)) {
    const consts = indexRegexConsts(source);
    const paths = consts.get(match[3]) ?? [];
    for (const path of paths) addRoute(bag, match[2], path);
  }

  for (const match of source.matchAll(/const (\w+) = (?:routePattern\("([^"]+)"\)|\/\^([\s\S]*?)\$\/)\.exec\(url\.pathname\);\s*if \(\1 && ([^)]*)\)/g)) {
    const paths = match[2] ? [match[2]] : regexToTemplates(match[3]);
    const methods = methodsFrom(match[4], "");
    for (const method of methods) for (const path of paths) addRoute(bag, method, path);
  }
}

function catalogPaths(source, predicate, paths, methods, bag) {
  if (!predicate.test(source)) return;
  for (const path of paths) for (const method of methods) addRoute(bag, method, path);
}

export function loadRouteSources(root) {
  const read = path => readFileSync(join(root, path), "utf8");
  return {
    http: read("server/http.mjs"),
    plugin: read("server/agent-plugin-routes.mjs"),
    nextActions: read("server/next-actions-routes.mjs"),
    workClaims: read("server/work-claim-routes.mjs"),
    feedback: read("server/feedback-routes.mjs"),
    bounty: read("server/bounty-escrow-routes.mjs"),
    collab: read("server/inbox-collab-routes.mjs"),
    worker: read("cloudflare/room.mjs"),
    constants: readConstants(root),
  };
}

export function extractLegacyRoutes(sources) {
  const prepared = substitute(sources.http, sources.constants);
  const names = routeNameMap(prepared);
  for (const [name, path] of routeNameMap(sources.nextActions)) names.set(name, path);
  const { byVar } = matcherPaths(prepared);
  const bag = new Map();
  scanSource(prepared, bag, { names, matchers: byVar, bindings: indexRegexConsts(prepared) });
  for (const file of [sources.plugin, sources.nextActions, sources.workClaims, sources.feedback, sources.bounty, sources.collab]) {
    const text = substitute(file, sources.constants);
    scanSource(text, bag, { names, matchers: byVar, bindings: indexRegexConsts(text) });
  }
  scanSwitches(sources.collab, byVar, bag);

  catalogPaths(sources.http, /isRoomMcpPath\(/, ROOM_MCP_PATHS, ["GET", "HEAD", "POST", "OPTIONS"], bag);
  catalogPaths(sources.http, /isA2aPath\(/, A2A_PATHS, ["POST", "OPTIONS"], bag);
  catalogPaths(sources.http, /isHealthAliasPath\(/, HEALTH_ALIAS_PATHS, ["GET", "HEAD"], bag);
  catalogPaths(sources.http, /isPublicRoomDoorPath\(/, PUBLIC_DOOR_PATHS, ["GET", "HEAD"], bag);
  catalogPaths(sources.http, /discovery && \["GET", "HEAD"\]/, DISCOVERY_PATHS, ["GET", "HEAD"], bag);
  for (const path of workerRouteTemplates(sources.worker)) {
    addRoute(bag, "GET", path);
    addRoute(bag, "HEAD", path);
  }
  if (/if \(boardV2Match\)/.test(prepared)) {
    for (const [, paths] of indexRegexConsts(prepared)) {
      for (const path of paths) if (path.includes("/board/v2/")) {
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]) addRoute(bag, method, path);
      }
    }
  }
  return [...bag.values()].sort((a, b) => a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path));
}

export function servedPathKeys(sources) {
  const keys = new Set();
  for (const path of routeCandidates(sources.http)) keys.add(templateKey(path));
  for (const path of pluginRouteTemplates(sources.plugin)) keys.add(templateKey(path));
  for (const path of nextActionsRouteTemplates(sources.nextActions)) keys.add(templateKey(path));
  for (const path of workerRouteTemplates(sources.worker)) keys.add(templateKey(path));
  return keys;
}

export function allowlistDocument(routes, baseline = routes) {
  return {
    note: "Legacy routes still served outside server/routes/table.mjs. baseline is the RT-0 set plus routes main added after that cut. This batch does not add legacy routes. routes is the set still in the legacy chain and only shrinks as groups move into the table.",
    baseline,
    routes,
  };
}

export function allowlistProblems(extracted, document) {
  const problems = [];
  if (!document || !Array.isArray(document.baseline) || !Array.isArray(document.routes)) {
    return ["allowlist is missing baseline and routes"];
  }
  const keyOf = row => routeKey(row.method, row.path);
  const baseline = new Set(document.baseline.map(keyOf));
  const listed = new Set(document.routes.map(keyOf));
  const found = new Set(extracted.map(keyOf));
  for (const row of extracted) {
    const key = keyOf(row);
    if (!baseline.has(key)) problems.push(`legacy route is not in the RT-0 baseline (the allowlist only shrinks): ${key}`);
    if (!listed.has(key)) problems.push(`legacy route is not listed in routes: ${key}`);
  }
  for (const row of document.routes) {
    const key = keyOf(row);
    if (!found.has(key)) problems.push(`allowlist routes entry is no longer in the legacy chain: ${key}`);
    if (!baseline.has(key)) problems.push(`allowlist routes entry is outside the baseline: ${key}`);
  }
  return problems;
}

function repoRoot() {
  return fileURLToPath(new URL("..", import.meta.url));
}

function readAllowlist(root) {
  return JSON.parse(readFileSync(join(root, ALLOWLIST), "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = repoRoot();
  const extracted = extractLegacyRoutes(loadRouteSources(root));
  if (process.argv.includes("--write")) {
    const existing = process.argv.includes("--baseline") ? null : (() => {
      try { return readAllowlist(root); } catch { return null; }
    })();
    const baseline = existing?.baseline ?? extracted;
    const problems = existing ? allowlistProblems(extracted, { baseline, routes: extracted }) : [];
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    writeFileSync(join(root, ALLOWLIST), JSON.stringify(allowlistDocument(extracted, baseline), null, 2) + "\n");
    console.log(`Wrote ${extracted.length} legacy routes (${baseline.length} baseline).`);
  } else if (process.argv.includes("--check")) {
    const problems = allowlistProblems(extracted, readAllowlist(root));
    if (problems.length) {
      console.error("Legacy route allowlist drift:\n" + problems.map(line => `  ${line}`).join("\n"));
      process.exit(1);
    }
    console.log(`Legacy route allowlist: ${extracted.length} routes still outside the table.`);
  } else {
    for (const row of extracted) console.log(`${row.method.padEnd(7)} ${row.path}`);
    console.log(`# ${extracted.length}`);
  }
}
