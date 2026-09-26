// Open-route inventory (security review 2026-09-14, L3 / B48).
//
// docs/openapi.yaml is the single source for which HTTP routes are served
// without a credential: an operation is open exactly when it declares
// `security: []`. This module reads that list with a minimal, line-based
// extraction (the repo has no YAML reader and the spec is hand-written with
// two-space indentation), tests/invite-only-boundary.test.js compares it with
// what the server actually serves anonymously, and `--check` verifies that
// docs/ROUTE-AUTH-TABLE.md and docs/INVITE-ONLY-CHECKLIST.md §1 name every
// open route, so a new open route cannot land undocumented.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const METHODS = ["get", "post", "put", "delete", "patch", "head", "options"];

// Every operation under `paths:` as { method, path, security, parameterLines }
// where security is null (inherits the document default), [] (open) or the
// scheme names, and parameterLines is the raw `parameters:` block (see
// pathParameterSamples).
export function openapiOperations(text) {
  const operations = [];
  let section = null, path = null, operation = null, securityList = null, parameters = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) { section = line.split(":")[0]; path = operation = securityList = parameters = null; continue; }
    if (section !== "paths") continue;
    const pathKey = /^  (\/\S+):\s*$/.exec(line);
    if (pathKey) { path = pathKey[1]; operation = securityList = parameters = null; continue; }
    const methodKey = /^    ([a-z]+):\s*$/.exec(line);
    if (methodKey && path) {
      operation = securityList = parameters = null;
      if (METHODS.includes(methodKey[1])) { operation = { method: methodKey[1].toUpperCase(), path, security: null, parameterLines: [], workerOnly: false }; operations.push(operation); }
      continue;
    }
    if (!operation) continue;
    if (/^      x-worker-only:\s*true\s*$/.test(line)) { operation.workerOnly = true; continue; }
    if (/^      parameters:\s*$/.test(line)) { parameters = operation.parameterLines; continue; }
    if (parameters) {
      if (/^ {8,}\S/.test(line)) { parameters.push(line); continue; }
      if (/\S/.test(line)) parameters = null;
    }
    const security = /^      security:\s*(.*?)\s*$/.exec(line);
    if (security) {
      if (security[1] === "[]") { operation.security = []; securityList = null; }
      else if (security[1] === "") { operation.security = []; securityList = operation.security; }
      else throw new Error(`${operation.method} ${path}: unsupported inline security value "${security[1]}"`);
      continue;
    }
    if (securityList) {
      const scheme = /^        - ([A-Za-z0-9_-]+):/.exec(line);
      if (scheme) { securityList.push(scheme[1]); continue; }
    }
    if (/^      \S/.test(line)) securityList = null;
  }
  return operations;
}

// Sample values for path parameters that declare a vocabulary, read out of an
// operation's `parameters:` block. A prober cannot invent a value for a
// segment the server constrains - /api/agent-keys/{keyId}/{action} only
// matches when action is rotate|revoke and keyId carries the rak_ prefix - so
// it reads the one the spec already publishes: the first `enum` entry, or an
// `example`. Everything else is shape-only and any dummy will do.
//
// Both spellings in the document are handled: the flow form
// `- { name: x, in: path, schema: { enum: [a, b] } }` and the block form with
// `in:`/`schema:` on following lines.
export function pathParameterSamples(lines = []) {
  const samples = {};
  let current = null;
  const flush = () => {
    if (current) {
      const text = current.join("\n");
      const name = /\bname:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1];
      const declared = /\benum:\s*\[\s*([^,\]]+)/.exec(text)?.[1] ?? /\bexample:\s*([^,}\n]+)/.exec(text)?.[1];
      if (name && declared && /\bin:\s*path\b/.test(text)) samples[name] = declared.trim().replace(/^["']|["']$/g, "");
    }
    current = null;
  };
  for (const line of lines) {
    if (/^\s*- /.test(line)) { flush(); current = [line]; }
    else if (current) current.push(line);
  }
  flush();
  return samples;
}

export function openRoutes(text) {
  return openapiOperations(text).filter(op => Array.isArray(op.security) && op.security.length === 0).map(({ method, path }) => ({ method, path }));
}

// Every /api route template server/http.mjs can match, from its string
// literals ("/api/health", connection templates with {id}) and its anchored
// path regexes (/^\/api\/rooms\/([^/]{1,384})(?:\/(a|b))?$/ expands to one
// template per alternative). Parameters are normalised to {id}.
export function routeCandidates(source) {
  const routes = new Set();
  for (const match of source.matchAll(/"(\/api\/[^"\s]*[^"\s/])"/g)) routes.add(match[1]);
  for (const match of source.matchAll(/\/\^(\\\/api\\\/[^\n]*?)\$\//g)) {
    const template = match[1].replaceAll("\\/", "/").replace(/\(\[\^\/\]\{1,\d+\}\)/g, "{id}");
    const optional = /\(\?:\/\(([^()]+)\)\)\?/.exec(template);
    const variants = optional ? ["", ...optional[1].split("|").map(part => "/" + part)].map(part => template.replace(optional[0], part)) : [template];
    for (const variant of variants) {
      if (/[\\()[\]|?*+^$]/.test(variant)) throw new Error(`route regex not expanded: ${variant}`);
      routes.add(variant);
    }
  }
  return [...routes].sort();
}

// "METHOD /path" with every {param} reduced to {} so openapi names and the
// server's {id} placeholders compare equal.
export const routeKey = (method, path) => `${method} ${path.replace(/\{[^}]+\}/g, "{}")}`;

const escape = value => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
export function documents(text, path) {
  // The docs write parameters as :name (or :id); the path must end at a
  // non-path character so /api/x does not stand in for /api/x/preview.
  const forms = new Set([path, path.replace(/\{([^}]+)\}/g, ":$1"), path.replace(/\{[^}]+\}/g, ":id")]);
  return [...forms].some(form => new RegExp(escape(form) + "(?![\\w\\-/{])").test(text));
}

export function checklistSection1(text) {
  const start = text.indexOf("\n## 1."), end = text.indexOf("\n## 2.", start + 1);
  if (start < 0 || end < 0) throw new Error("docs/INVITE-ONLY-CHECKLIST.md: sections 1 and 2 not found");
  return text.slice(start, end);
}

export function docsDrift({ routes, routeAuthTable, checklist }) {
  const failures = [];
  const section = checklistSection1(checklist);
  for (const { method, path } of routes) {
    if (!documents(routeAuthTable, path)) failures.push(`docs/ROUTE-AUTH-TABLE.md does not list open route ${method} ${path}`);
    if (!documents(section, path)) failures.push(`docs/INVITE-ONLY-CHECKLIST.md section 1 does not list open route ${method} ${path}`);
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const read = path => readFileSync(join(root, path), "utf8");
  const routes = openRoutes(read("docs/openapi.yaml"));
  if (routes.length === 0) { console.error("docs/openapi.yaml declares no `security: []` operation; the open-route inventory would be empty."); process.exit(1); }
  if (process.argv.includes("--check")) {
    const failures = docsDrift({ routes, routeAuthTable: read("docs/ROUTE-AUTH-TABLE.md"), checklist: read("docs/INVITE-ONLY-CHECKLIST.md") });
    if (failures.length) { console.error("Open-route inventory drift:\n" + failures.map(f => `  ${f}`).join("\n")); process.exit(1); }
    console.log(`Open-route inventory: ${routes.length} routes declared security: [] in docs/openapi.yaml are listed in both documents.`);
  } else {
    for (const { method, path } of routes) console.log(`${method.padEnd(6)} ${path}`);
  }
}
