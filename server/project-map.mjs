// Per-room code map. Local, deterministic, no model and no network.
// A push of sources parses symbols, imports and calls. Graphify JSON, when
// an operator supplies it, replaces that parse. Queries and overlap rules
// are pure so the store, the MCP tool and the tests share one result.

import { createHash } from "node:crypto";

export const UBIQUITOUS_FILES = Object.freeze([
  "scripts/CANDIDATE-MANIFEST.json",
  "docs/openapi.yaml",
  "scripts/runtime-package.mjs",
  "server/store.mjs",
  "server/http.mjs",
  "plugins/project-room/skills/project-room/references/errors-catalog.md",
  "skills/project-room/references/errors-catalog.md"
]);

const UBIQUITOUS = new Set(UBIQUITOUS_FILES);
const OFF = new Set(["0", "false", "off", "no"]);
const ON = new Set(["1", "true", "on", "yes"]);
const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);
const CALL_KEYWORDS = new Set("if for while switch catch function class return typeof instanceof new await yield throw case do else try finally with debugger import export from as of in const let var async static get set delete void super this".split(" "));
export const PROJECT_MAP_LIMITS = Object.freeze({ files: 4000, nodes: 20000, edges: 40000, sourceBytes: 65536, results: 200 });
const MAX_FILES = PROJECT_MAP_LIMITS.files;
const MAX_PUSH = 200;
const MAX_SOURCE = 64 * 1024;
const HOTSPOTS = 15;
const PATH_DEPTH = 12;
const PATH_VISITS = 2000;

export function projectMapEnabled(env) {
  const raw = typeof env?.ROOM_PROJECT_MAP === "string" ? env.ROOM_PROJECT_MAP.trim().toLowerCase() : "";
  if (!raw) return true;
  return !OFF.has(raw);
}

export function graphifyPreferred(env) {
  const raw = typeof env?.ROOM_PROJECT_MAP_GRAPHIFY === "string" ? env.ROOM_PROJECT_MAP_GRAPHIFY.trim().toLowerCase() : "";
  return ON.has(raw);
}

export function normalizeRepo(value) {
  if (typeof value !== "string") return null;
  const repo = value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return repo.toLowerCase();
}

export function normalizePath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!path || path.length > 300 || path.includes("\0") || path.split("/").some(part => part === ".." || part === "")) return null;
  return path;
}

function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

function stripComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === "/" && n === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < source.length) { out += "  "; i += 2; }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") { out += "  "; i += 2; continue; }
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") break;
        out += source[i] === "\n" && quote !== "`" ? "\n" : source[i];
        if (source[i] === quote || (source[i] === "\n" && quote !== "`")) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function blankStrings(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      out += " ";
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") { out += "  "; i += 2; continue; }
        if (quote === "`" && source[i] === "$" && source[i + 1] === "{") break;
        if (source[i] === quote || (source[i] === "\n" && quote !== "`")) { out += " "; i += 1; break; }
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

function bindingsFrom(clause) {
  const text = clause.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const bindings = [];
  const named = text.match(/\{([^}]*)\}/);
  if (named) {
    for (const part of named[1].split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const imported = bits[0]?.trim();
      const local = (bits[1] ?? bits[0])?.trim();
      if (imported && local && imported !== "type") bindings.push({ local, imported });
    }
  }
  const withoutNamed = text.replace(/\{[^}]*\}/, " ").trim();
  const star = withoutNamed.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (star) bindings.push({ local: star[1], imported: "*" });
  else {
    const def = withoutNamed.match(/^([A-Za-z_$][\w$]*)/);
    if (def && def[1] !== "type") bindings.push({ local: def[1], imported: "default" });
  }
  return bindings;
}

export function parseModule(path, source) {
  const empty = { symbols: [], specs: [], calls: [], truncated: false };
  if (!SOURCE_EXT.has(extensionOf(path))) return empty;
  const raw = String(source ?? "");
  const text = Buffer.from(raw).subarray(0, MAX_SOURCE).toString("utf8");
  let truncated = Buffer.byteLength(raw) > MAX_SOURCE;
  const readable = stripComments(text);
  const specs = [];
  const importRe = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  const sideRe = /\bimport\s+['"]([^'"]+)['"]/g;
  const exportRe = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of readable.matchAll(importRe)) {
    if (match[2]) specs.push({ spec: match[2], bindings: bindingsFrom(match[1] ?? "") });
  }
  for (const match of readable.matchAll(sideRe)) specs.push({ spec: match[1], bindings: [] });
  for (const match of readable.matchAll(exportRe)) specs.push({ spec: match[1], bindings: [] });
  for (const match of readable.matchAll(requireRe)) specs.push({ spec: match[1], bindings: [] });
  for (const match of readable.matchAll(dynamicRe)) specs.push({ spec: match[1], bindings: [] });
  const code = blankStrings(readable);
  const symbols = [];
  const seen = new Set();
  const add = (name, kind, index) => {
    if (!name || seen.has(name)) return;
    if (symbols.length >= 200) { truncated = true; return; }
    seen.add(name);
    symbols.push({ name, kind, line: lineOf(code, index) });
  };
  for (const match of code.matchAll(/(?:^|[^\w$])(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) add(match[1], "function", match.index);
  for (const match of code.matchAll(/(?:^|[^\w$])(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g)) add(match[1], "class", match.index);
  for (const match of code.matchAll(/(?:^|[^\w$])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) add(match[1], "const", match.index);
  const calls = [];
  const callSeen = new Set();
  for (const match of code.matchAll(/(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (CALL_KEYWORDS.has(name) || callSeen.has(name)) continue;
    if (calls.length >= 200) { truncated = true; continue; }
    const before = code.slice(Math.max(0, match.index - 16), match.index + 1);
    if (/\b(?:function|class|catch|new)\s*$/.test(before)) continue;
    callSeen.add(name);
    calls.push(name);
  }
  const specSeen = new Set();
  const uniqueSpecs = [];
  for (const entry of specs) {
    if (!entry.spec || specSeen.has(entry.spec)) continue;
    if (uniqueSpecs.length >= 50) { truncated = true; continue; }
    specSeen.add(entry.spec);
    uniqueSpecs.push(entry);
  }
  return { symbols, specs: uniqueSpecs, calls, truncated };
}

function resolveSpec(fromFile, spec, known) {
  if (typeof spec !== "string" || !spec.startsWith(".")) return null;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const parts = [];
  for (const part of `${dir}/${spec}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const base = parts.join("/");
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.ts`];
  return candidates.find(candidate => known.has(candidate)) ?? null;
}

function recomputeImports(files) {
  const known = new Set(Object.keys(files));
  for (const [path, file] of Object.entries(files)) {
    // Graphify edges have no source specs. Leave those imports in place.
    if ((file.specs ?? []).length === 0) continue;
    const resolved = [];
    const external = [];
    for (const entry of file.specs ?? []) {
      const hit = resolveSpec(path, entry.spec, known);
      if (hit) resolved.push(hit);
      else if (typeof entry.spec === "string" && !entry.spec.startsWith(".")) external.push(entry.spec);
    }
    file.imports = [...new Set(resolved)];
    file.external = [...new Set(external)];
  }
}

export function emptyGraph(repo, revision = null) {
  return { version: 1, repo, revision, builtAt: 0, engine: "parser", files: Object.create(null), truncated: false };
}

function hashSource(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function applyFiles(graph, change, now = Date.now()) {
  const next = {
    version: 1,
    repo: graph?.repo ?? normalizeRepo(change.repo) ?? null,
    revision: typeof change.revision === "string" ? change.revision.slice(0, 120) : (graph?.revision ?? null),
    builtAt: now,
    engine: change.engine === "graphify" ? "graphify" : "parser",
    files: Object.assign(Object.create(null), graph?.files ?? {})
  };
  let truncated = graph?.truncated === true || change.truncated === true;
  for (const path of change.removed ?? []) {
    const key = normalizePath(path);
    if (key) delete next.files[key];
  }
  const incoming = Array.isArray(change.files) ? change.files : [];
  if (incoming.length > MAX_PUSH) truncated = true;
  for (const file of incoming.slice(0, MAX_PUSH)) {
    const path = normalizePath(file?.path);
    const source = typeof file?.source === "string" ? file.source : null;
    if (!path || source === null) continue;
    if (Buffer.byteLength(source) > MAX_SOURCE) { truncated = true; delete next.files[path]; continue; }
    if (!next.files[path] && Object.keys(next.files).length >= MAX_FILES) { truncated = true; continue; }
    const hash = hashSource(source);
    const prev = next.files[path];
    if (prev && prev.hash === hash) continue;
    const parsed = parseModule(path, source);
    truncated ||= parsed.truncated;
    next.files[path] = {
      bytes: Buffer.byteLength(source),
      hash,
      symbols: parsed.symbols,
      specs: parsed.specs,
      calls: parsed.calls,
      imports: [],
      external: []
    };
  }
  recomputeImports(next.files);
  next.truncated = truncated;
  return next;
}

function nodeFile(node) {
  const file = node?.file || node?.source_file || node?.path || node?.location?.file || node?.data?.file;
  return normalizePath(typeof file === "string" ? file : "");
}

function nodeName(node) {
  const name = node?.label || node?.name || node?.data?.label || node?.data?.name;
  if (typeof name !== "string" || !name.trim()) return null;
  const normalized = node?._callable === true ? name.trim().replace(/\(\)$/, "") : name.trim();
  return normalized.slice(0, 160);
}

function nodeLine(node) {
  if (Number.isInteger(node?.line)) return node.line;
  const loc = node?.source_location;
  if (Number.isInteger(loc?.line)) return loc.line;
  if (typeof loc === "string") {
    const match = /^L?(\d+)/.exec(loc);
    if (match) return Number(match[1]);
  }
  return null;
}

export function graphFromGraphify(doc, { repo, revision = null, now = Date.now() } = {}) {
  const root = doc && typeof doc === "object" && !Array.isArray(doc.nodes) && doc.graph && typeof doc.graph === "object" ? doc.graph : doc;
  const nodes = Array.isArray(root?.nodes) ? root.nodes : [];
  const edges = Array.isArray(root?.edges) ? root.edges : (Array.isArray(root?.links) ? root.links : []);
  const files = Object.create(null);
  let truncated = nodes.length > PROJECT_MAP_LIMITS.nodes || edges.length > PROJECT_MAP_LIMITS.edges || root?.truncated === true;
  const byId = new Map();
  const symbolNames = new Map();
  let fileCount = 0;
  const ensure = path => {
    if (!files[path] && fileCount >= MAX_FILES) { truncated = true; return null; }
    if (!files[path]) fileCount += 1;
    files[path] ??= { bytes: 0, hash: "", symbols: [], specs: [], calls: [], callTargets: [], imports: [], external: [] };
    return files[path];
  };
  for (const node of nodes.slice(0, PROJECT_MAP_LIMITS.nodes)) {
    const path = nodeFile(node);
    const name = nodeName(node);
    if (!path || !name) continue;
    const inferred = node._callable === true ? "function" : (name === path || name === path.split("/").at(-1) ? "file" : "symbol");
    const kind = String(node.kind || node.type || inferred).slice(0, 40);
    const id = node.id !== undefined ? String(node.id) : null;
    // File nodes are edge endpoints. They have to stay addressable or an
    // imports edge between two files never becomes a neighbor.
    if (kind === "file" || kind === "module") {
      if (!ensure(path)) continue;
      if (id) byId.set(id, { path, name: path });
      continue;
    }
    const file = ensure(path);
    if (!file) continue;
    // Persist all definitions in the globally bounded input. The 200-result
    // packet limit must not make later exact symbol lookups impossible.
    let names = symbolNames.get(path);
    if (!names) { names = new Set(); symbolNames.set(path, names); }
    if (!names.has(name)) {
      names.add(name);
      file.symbols.push({ name, kind, line: nodeLine(node) });
    }
    if (id) byId.set(id, { path, name });
  }
  for (const edge of edges.slice(0, PROJECT_MAP_LIMITS.edges)) {
    if (!edge || typeof edge !== "object") continue;
    const from = byId.get(String(edge.from ?? edge.source ?? ""));
    const to = byId.get(String(edge.to ?? edge.target ?? ""));
    if (!from || !to) continue;
    const rel = String(edge.kind || edge.relation || edge.type || edge.label || "").toLowerCase();
    const file = ensure(from.path);
    if (rel.includes("import") || rel.includes("depend")) {
      if (!file.imports.includes(to.path)) {
        if (file.imports.length >= 200) truncated = true;
        else file.imports.push(to.path);
      }
    } else if (rel.includes("call") || rel.includes("invoke")) {
      if (!file.callTargets.some(target => target.file === to.path && target.name === to.name)) {
        if (file.callTargets.length >= 200) truncated = true;
        else { file.callTargets.push({ file: to.path, name: to.name }); if (!file.calls.includes(to.name)) file.calls.push(to.name); }
      }
    }
  }
  return { version: 1, repo: normalizeRepo(repo) ?? repo ?? null, revision, builtAt: now, engine: "graphify", files, truncated,
    sourceScope: boundedSourceScope(root?.graph?.source_scope),
    projection: "files-symbols-imports-calls",
    semanticCompleteness: "partial",
    graphifyVersion: typeof root?.graph?.graphify_version === "string" ? root.graph.graphify_version.slice(0, 80) : null,
    schemaVersion: Number.isInteger(root?.graph?.schema_version) ? root.graph.schema_version : null
  };
}

function indexGraph(graph) {
  const files = graph?.files ?? {};
  const defined = new Map();
  const dependents = new Map();
  for (const [path, file] of Object.entries(files)) {
    for (const symbol of file.symbols ?? []) {
      const list = defined.get(symbol.name) ?? [];
      list.push({ file: path, kind: symbol.kind, line: symbol.line ?? null });
      defined.set(symbol.name, list);
    }
    for (const spec of file.imports ?? []) {
      if (!files[spec]) continue;
      const set = dependents.get(spec) ?? new Set();
      set.add(path);
      dependents.set(spec, set);
    }
  }
  return { files, defined, dependents };
}

function localBinding(file, name) {
  for (const entry of file.specs ?? []) {
    for (const binding of entry.bindings ?? []) {
      if (binding.local === name) return { spec: entry.spec, imported: binding.imported };
    }
  }
  return null;
}

function resolvedCalls(path, file, files, defined) {
  if (Array.isArray(file.callTargets)) return file.callTargets.filter(target => files[target.file]);
  const known = new Set(Object.keys(files));
  const out = [];
  for (const name of file.calls ?? []) {
    const binding = localBinding(file, name);
    const importedFile = binding ? resolveSpec(path, binding.spec, known) : null;
    const targets = defined.get(binding?.imported && binding.imported !== "default" && binding.imported !== "*" ? binding.imported : name) ?? [];
    for (const target of targets) {
      if (target.file === path || target.file === importedFile || (file.imports ?? []).includes(target.file)) {
        out.push({ name: target.file === importedFile && binding?.imported && binding.imported !== "default" ? binding.imported : name, file: target.file });
      }
    }
    if (importedFile && !out.some(call => call.file === importedFile && call.name === (binding.imported === "default" ? name : binding.imported))) {
      const importedName = binding.imported === "default" || binding.imported === "*" ? name : binding.imported;
      if ((defined.get(importedName) ?? []).some(target => target.file === importedFile) || binding.imported === "default") {
        out.push({ name: importedName, file: importedFile });
      }
    }
  }
  return out;
}

function boundedSourceScope(value) {
  return typeof value === "string" && value.trim() ? value.trim().replace(/[\u0000-\u001f]/g, " ").slice(0, 300) : null;
}

function graphMetadata(graph) {
  return { engine: graph?.engine ?? "unknown", revision: graph?.revision ?? null, builtAt: graph?.builtAt ?? null, truncated: graph?.truncated === true,
    sourceScope: boundedSourceScope(graph?.sourceScope),
    projection: graph?.projection ?? "files-symbols-imports-calls",
    semanticCompleteness: graph?.semanticCompleteness ?? "heuristic",
    graphifyVersion: graph?.graphifyVersion ?? null, schemaVersion: graph?.schemaVersion ?? null
  };
}

// Upstream extraction labels some methods `.name()`. The importer keeps the
// canonical `.name` and infers function kind. Alias only these callables, after
// exact lookup, without adding an index or changing persisted graph content.
function resolveSymbol(defined, query, file = null) {
  const scoped = name => (defined.get(name) ?? []).filter(def => !file || def.file === file);
  const exact = scoped(query);
  if (exact.length) return { name: query, definitions: exact, alias: false };
  const name = `.${query}`;
  const definitions = /^[A-Za-z_$][\w$]*$/.test(query)
    ? scoped(name).filter(def => def.kind === "function") : [];
  return { name, definitions, alias: definitions.length > 0 };
}

function missingCoverage(graph, result) {
  return !result.found && graph?.truncated === true ? {
    coverageIncomplete: true,
    coverageNote: "This bounded map omitted data; not found does not establish absence. Query a map built from a narrower source scope at the same revision, or inspect that revision's source."
  } : {};
}

export function mapQuery(graph, q) {
  const result = queryGraph(graph, q);
  let truncated = graph?.truncated === true;
  if (result.kind === "file") result.symbolCount = result.symbols.length;
  for (const key of ["symbols", "neighbors", "external", "dependents", "callers", "definitions"]) {
    if (result[key]?.length > PROJECT_MAP_LIMITS.results) { result[key] = result[key].slice(0, PROJECT_MAP_LIMITS.results); truncated = true; }
  }
  if (result.kind === "file") result.symbolsReturned = result.symbols.length;
  return { ...result, ...graphMetadata(graph), truncated, ...missingCoverage(graph, result) };
}

function queryGraph(graph, q) {
  const query = typeof q === "string" ? q.trim() : "";
  const { files, defined, dependents } = indexGraph(graph);
  const path = normalizePath(query);
  if (path && files[path]) {
    const file = files[path];
    const callers = [];
    for (const [otherPath, other] of Object.entries(files)) {
      if (otherPath === path) continue;
      for (const call of resolvedCalls(otherPath, other, files, defined)) {
        if (call.file === path) callers.push({ file: otherPath, symbol: call.name });
      }
    }
    return {
      found: true, kind: "file", file: path, label: path,
      symbols: file.symbols ?? [],
      neighbors: [...(file.imports ?? [])],
      external: [...(file.external ?? [])],
      dependents: [...(dependents.get(path) ?? [])].sort(),
      callers
    };
  }
  const resolved = resolveSymbol(defined, query);
  const definitions = resolved.definitions;
  if (!query || definitions.length === 0) return { found: false, kind: null, query };
  const defFiles = new Set(definitions.map(entry => entry.file));
  const callers = [];
  const neighbors = new Set();
  for (const [otherPath, other] of Object.entries(files)) {
    if (defFiles.has(otherPath)) for (const spec of other.imports ?? []) neighbors.add(spec);
    for (const call of resolvedCalls(otherPath, other, files, defined)) {
      if (call.name === resolved.name && defFiles.has(call.file)) callers.push({ file: otherPath, symbol: resolved.name });
    }
  }
  const dependentFiles = new Set(callers.map(call => call.file));
  for (const file of defFiles) for (const importer of dependents.get(file) ?? []) dependentFiles.add(importer);
  return {
    found: true, kind: "symbol", symbol: resolved.name, label: resolved.name,
    ...(resolved.alias ? { query, matchedBy: "callable-alias", ambiguous: definitions.length > 1 } : {}),
    definitions, neighbors: [...neighbors].sort(), dependents: [...dependentFiles].sort(), callers
  };
}

function nodeIdFor(graph, query) {
  const { files, defined } = indexGraph(graph);
  const path = normalizePath(query);
  if (path && files[path]) return `file:${path}`;
  const hashed = typeof query === "string" && query.includes("#") ? query.split("#") : null;
  if (hashed) {
    const file = normalizePath(hashed[0]);
    const name = hashed.slice(1).join("#");
    if (file && files[file]) {
      const resolved = resolveSymbol(defined, name, file);
      if (resolved.definitions.length) return `sym:${file}#${resolved.name}`;
    }
  }
  const resolved = resolveSymbol(defined, String(query ?? "").trim());
  if (resolved.alias && resolved.definitions.length > 1) return { ambiguous: true };
  if (resolved.definitions.length) return `sym:${resolved.definitions[0].file}#${resolved.name}`;
  return null;
}

function presentNode(id) {
  if (id.startsWith("file:")) return { kind: "file", file: id.slice(5) };
  const body = id.slice(4);
  const hash = body.indexOf("#");
  return { kind: "symbol", file: body.slice(0, hash), symbol: body.slice(hash + 1) };
}

export function mapPath(graph, from, to) {
  const result = pathGraph(graph, from, to);
  return { ...result, ...graphMetadata(graph), truncated: graph?.truncated === true || result.truncated === true, ...missingCoverage(graph, result) };
}

function pathGraph(graph, from, to) {
  const start = nodeIdFor(graph, from);
  const goal = nodeIdFor(graph, to);
  if (start?.ambiguous || goal?.ambiguous) return { found: false, from, to, nodes: [], ambiguous: true,
    reason: "ambiguous_symbol", guidance: "Use file#symbol to select a definition for each ambiguous callable alias." };
  if (!start || !goal) return { found: false, from, to, nodes: [] };
  if (start === goal) return { found: true, from, to, nodes: [presentNode(start)] };
  const { files, defined } = indexGraph(graph);
  const adjacent = new Map();
  const link = (a, b) => {
    if (!a || !b || a === b) return;
    for (const [left, right] of [[a, b], [b, a]]) {
      const set = adjacent.get(left) ?? new Set();
      set.add(right);
      adjacent.set(left, set);
    }
  };
  for (const [path, file] of Object.entries(files)) {
    const fileNode = `file:${path}`;
    for (const symbol of file.symbols ?? []) link(fileNode, `sym:${path}#${symbol.name}`);
    for (const spec of file.imports ?? []) link(fileNode, `file:${spec}`);
    for (const call of resolvedCalls(path, file, files, defined)) link(fileNode, `sym:${call.file}#${call.name}`);
  }
  const queue = [start];
  const prev = new Map([[start, null]]);
  let visits = 0;
  let found = null;
  let truncated = false;
  while (queue.length && visits < PATH_VISITS) {
    const current = queue.shift();
    visits += 1;
    const depth = (() => {
      let n = 0;
      let cursor = current;
      while (prev.get(cursor)) { cursor = prev.get(cursor); n += 1; }
      return n;
    })();
    if (depth >= PATH_DEPTH) { truncated = true; continue; }
    for (const next of adjacent.get(current) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, current);
      if (next === goal) { found = next; break; }
      queue.push(next);
    }
    if (found) break;
  }
  if (!found) return { found: false, from, to, nodes: [], truncated: truncated || queue.length > 0 };
  const nodes = [];
  let cursor = found;
  while (cursor) { nodes.push(presentNode(cursor)); cursor = prev.get(cursor); }
  nodes.reverse();
  return { found: true, from, to, nodes };
}

export function mapHotspots(graph) {
  const { files, defined, dependents } = indexGraph(graph);
  const callers = new Map();
  for (const [path, file] of Object.entries(files)) {
    for (const call of resolvedCalls(path, file, files, defined)) {
      if (call.file === path) continue;
      callers.set(call.file, (callers.get(call.file) ?? 0) + 1);
    }
  }
  const rows = Object.entries(files).map(([path, file]) => ({
    path,
    coupling: (file.imports ?? []).length + (dependents.get(path)?.size ?? 0) + (callers.get(path) ?? 0),
    bytes: file.bytes ?? 0,
    symbols: (file.symbols ?? []).length
  }));
  rows.sort((a, b) => b.coupling - a.coupling || b.bytes - a.bytes || (a.path < b.path ? -1 : 1));
  return rows.slice(0, HOTSPOTS);
}

export function mapExplain(graph, q) {
  const hit = mapQuery(graph, q);
  const spots = mapHotspots(graph);
  const file = hit.file ?? hit.definitions?.[0]?.file ?? null;
  const rank = file ? spots.findIndex(row => row.path === file) + 1 : 0;
  const neighbors = hit.neighbors?.length ?? 0;
  const dependents = hit.dependents?.length ?? 0;
  const summary = hit.found
    ? `${hit.label} has ${neighbors} neighbors and ${dependents} dependents${rank ? `, hotspot rank ${rank}` : ""}.`
    : `No map entry for ${String(q ?? "").slice(0, 120)}.`;
  return { ...hit, summary, hotspotRank: rank || null };
}

export function fileSetSimilarity(left, right) {
  const clean = list => new Set((Array.isArray(list) ? list : []).map(normalizePath).filter(path => path && !UBIQUITOUS.has(path)));
  const a = clean(left);
  const b = clean(right);
  const shared = [...a].filter(path => b.has(path)).sort();
  const union = a.size + b.size - shared.length;
  const subset = a.size >= 2 && b.size >= 2 && (shared.length === a.size || shared.length === b.size);
  const duplicate = (union > 0 && shared.length * 10 >= union * 7) || subset;
  return { jaccard: union === 0 ? 0 : shared.length / union, subset, duplicate, shared };
}

function plain(value) {
  return String(value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function itemFiles(item) {
  const files = [];
  for (const path of item?.files ?? []) {
    const key = normalizePath(path);
    if (key) files.push(key);
  }
  const pulls = Array.isArray(item?.pullRequests) && item.pullRequests.length ? item.pullRequests : (item?.pullRequest ? [item.pullRequest] : []);
  for (const pull of pulls) {
    for (const path of [...(pull?.files ?? []), ...(pull?.changedFiles ?? [])]) {
      const key = normalizePath(path);
      if (key) files.push(key);
    }
  }
  return [...new Set(files)];
}

export function createOverlapContext(graph) {
  return { graph, index: indexGraph(graph), calls: new Map() };
}

function coupledSymbols(context, left, right) {
  if (!context?.graph?.files || left.length === 0 || right.length === 0) return [];
  const { files, defined } = context.index;
  const setA = new Set(left);
  const setB = new Set(right);
  const names = new Set();
  const take = (from, into) => {
    for (const path of from) {
      const file = files[path];
      if (!file) continue;
      if (!context.calls.has(path)) context.calls.set(path, resolvedCalls(path, file, files, defined));
      for (const call of context.calls.get(path)) {
        if (into.has(call.file)) names.add(call.name);
      }
    }
  };
  take(setA, setB);
  take(setB, setA);
  for (const path of setA) {
    if (!setB.has(path) || UBIQUITOUS.has(path)) continue;
    for (const symbol of files[path]?.symbols ?? []) names.add(symbol.name);
  }
  return [...names].sort();
}

function labelOf(item) {
  if (item?.kind === "pull" || Number.isInteger(item?.number)) {
    const number = Number.isInteger(item.number) ? `PR #${item.number}` : "PR";
    const title = plain(item.title);
    return title ? `${number} ${title}`.slice(0, 80) : number;
  }
  const title = plain(item?.title);
  if (title && title !== item?.id) return title;
  return plain(item?.id) || "an open item";
}

function joinLabels(labels) {
  if (labels.length <= 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

export function assessOverlap({ subject, others, graph, overlapContext }) {
  if (!subject) return null;
  const files = itemFiles(subject);
  if (files.length === 0) return null;
  let context = overlapContext?.graph === graph ? overlapContext : null;
  const subjectRepo = subject.repo ? normalizeRepo(subject.repo) : null;
  const hits = [];
  for (const other of others ?? []) {
    if (!other || other.id === subject.id) continue;
    const otherRepo = other.repo ? normalizeRepo(other.repo) : null;
    if (!subjectRepo || !otherRepo || subjectRepo !== otherRepo) continue;
    const otherFiles = itemFiles(other);
    if (otherFiles.length === 0) continue;
    const sim = fileSetSimilarity(files, otherFiles);
    if (!context && graph?.files) context = createOverlapContext(graph);
    const symbols = coupledSymbols(context, files, otherFiles).slice(0, 40);
    if (sim.shared.length === 0 && symbols.length === 0) continue;
    hits.push({ other, sim, symbols });
  }
  if (hits.length === 0) return null;
  const sharedFiles = [...new Set(hits.flatMap(hit => hit.sim.shared))].sort();
  const symbols = [...new Set(hits.flatMap(hit => hit.symbols))].sort();
  const duplicate = hits.some(hit => hit.sim.duplicate);
  const shown = [...sharedFiles, ...symbols.map(name => `${name}()`)];
  const head = shown.slice(0, 8).join(", ");
  const more = shown.length > 8 ? ` and ${shown.length - 8} more` : "";
  const names = joinLabels([labelOf(subject), ...hits.map(hit => labelOf(hit.other))]);
  const summary = duplicate
    ? `Duplicate: ${names} may overlap (${head}${more}); review the changes to confirm whether they duplicate work.`
    : `Overlap: ${names} share ${head}${more}.`;
  return {
    duplicate,
    with: hits.map(hit => ({ id: String(hit.other.id), label: labelOf(hit.other) })),
    files: sharedFiles,
    symbols,
    shared: shown,
    summary
  };
}
