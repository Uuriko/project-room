// W009: read-only wiki API for agents.
//
// Serves the three wiki planes as JSON for agent readers:
//   - docs/ROOM-WIKI.md            append-only experience log ("lessons")
//   - docs/history/ROOM-PROCEDURES.md  validated procedures
//   - docs/*RUNBOOK*.md            runbooks
//
// Pure parsers (parseWikiEntries / parseProcedures / parseRunbooks /
// searchWiki) plus a prefix-delegated HTTP handler in the growth-handler
// shape: createWikiReadApi({ root }) -> { handle(pathname, method,
// searchParams) }, which returns { status, body }, null for non-wiki paths,
// or throws ServiceError for 4xx/503. No store, no writes, no network; file
// reads are lazy (per request) so importing this module is side-effect-free,
// and any unreadable plane fails closed to 503 wiki_unavailable instead of a
// dropped connection.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { ServiceError } from "./service-error.mjs";

const WIKI_FILE = "docs/ROOM-WIKI.md";
const PROCEDURES_FILE = "docs/history/ROOM-PROCEDURES.md";
const DOCS_DIR = "docs";

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// --- Wiki entries (docs/ROOM-WIKI.md) -------------------------------------

const WIKI_HEADER = /^## (\d{4}-\d{2}-\d{2}) · (.+?) · (.+?)$/;
const WIKI_BULLET = /^-\s*(Tried|Outcome|Lesson|Rejected):\s*(.*)$/;

export function parseWikiEntries(text) {
  const entries = [];
  const seen = new Map();
  let current = null;
  let inFence = false;
  const flush = () => {
    if (!current) return;
    let id = `${current.date}-${slugify(current.slice)}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n + 1}`;
    entries.push({ id, ...current.fields });
    current = null;
  };
  for (const line of String(text).split("\n")) {
    if (line.trimStart().startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const header = WIKI_HEADER.exec(line);
    if (header) {
      flush();
      const [, date, slice, agent] = header;
      current = {
        date, slice: slice.trim(), agent: agent.trim(),
        fields: { date, slice: slice.trim(), agent: agent.trim(), tried: "", outcome: "", lesson: "", rejected: "" },
        bullet: null,
      };
      continue;
    }
    if (!current) continue;
    const bullet = WIKI_BULLET.exec(line);
    if (bullet) {
      current.bullet = bullet[1].toLowerCase();
      current.fields[current.bullet] = bullet[2].trim();
    } else if (current.bullet && /^\s+\S/.test(line)) {
      // Continuation line of the current bullet.
      current.fields[current.bullet] += " " + line.trim();
    } else if (line.trim() === "") {
      current.bullet = null;
    }
  }
  flush();
  return entries;
}

// --- Procedures (docs/history/ROOM-PROCEDURES.md) --------------------------

const PROCEDURE_HEADER = /^## (.+)$/;
const PROCEDURE_SOURCE = /^Source:\s*(.+)$/;

export function parseProcedures(text) {
  const procedures = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    const firstParagraph = body.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
    procedures.push({
      id: slugify(current.title),
      title: current.title,
      body,
      summary: firstParagraph.slice(0, 280),
      source: current.source,
    });
    current = null;
  };
  for (const line of String(text).split("\n")) {
    const header = PROCEDURE_HEADER.exec(line);
    if (header && !line.startsWith("###")) {
      flush();
      current = { title: header[1].trim(), lines: [], source: null };
      continue;
    }
    if (!current) continue;
    const source = PROCEDURE_SOURCE.exec(line.trim());
    if (source) current.source = source[1].trim();
    else current.lines.push(line);
  }
  flush();
  return procedures;
}

// --- Runbooks (docs/*RUNBOOK*.md) -----------------------------------------

export function parseRunbooks(files) {
  return files.map(({ path, text }) => {
    const body = String(text);
    const heading = body.split("\n").find(line => line.startsWith("# "));
    return {
      id: slugify(basename(path).replace(/\.md$/i, "")),
      title: heading ? heading.replace(/^#\s+/, "").trim() : basename(path),
      path,
      body,
    };
  });
}

// --- Search ----------------------------------------------------------------

function summarizeProcedure(p) { return { id: p.id, title: p.title, summary: p.summary }; }
function summarizeEntry(e) { return { id: e.id, date: e.date, slice: e.slice, agent: e.agent, outcome: e.outcome, lesson: e.lesson }; }
function summarizeRunbook(r) { return { id: r.id, title: r.title }; }

export function searchWiki(index, query, limit = 20) {
  const q = String(query ?? "").trim().toLowerCase();
  const empty = { procedures: [], entries: [], runbooks: [] };
  if (!q) return empty;
  const lim = Math.max(1, Math.min(100, Number.isFinite(+limit) ? Math.trunc(+limit) : 20));
  const hit = haystack => haystack.toLowerCase().includes(q);
  const procedures = (index.procedures ?? []).filter(p => hit(`${p.title}\n${p.body}\n${p.source ?? ""}`)).slice(0, lim).map(summarizeProcedure);
  const entries = (index.entries ?? []).filter(e => hit(`${e.slice}\n${e.tried}\n${e.outcome}\n${e.lesson}\n${e.rejected}`)).slice(0, lim).map(summarizeEntry);
  const runbooks = (index.runbooks ?? []).filter(r => hit(`${r.title}\n${r.body ?? ""}`)).slice(0, lim).map(summarizeRunbook);
  return { procedures, entries, runbooks };
}

// --- Index loading (fail-closed) --------------------------------------------

function readRequired(root, file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch (error) {
    throw new ServiceError(503, "wiki_unavailable", `Wiki plane unreadable: ${file}`, null);
  }
}

export function loadWikiIndex(root) {
  const procedures = parseProcedures(readRequired(root, PROCEDURES_FILE));
  const entries = parseWikiEntries(readRequired(root, WIKI_FILE));
  let names;
  try {
    names = readdirSync(join(root, DOCS_DIR)).filter(name => /RUNBOOK.*\.md$/i.test(name)).sort();
  } catch {
    throw new ServiceError(503, "wiki_unavailable", `Wiki plane unreadable: ${DOCS_DIR}/`, null);
  }
  const runbookFiles = [];
  for (const name of names) {
    try {
      runbookFiles.push({ path: `${DOCS_DIR}/${name}`, text: readFileSync(join(root, DOCS_DIR, name), "utf8") });
    } catch { /* a single unreadable runbook is skipped; the plane stays up */ }
  }
  const metas = parseRunbooks(runbookFiles);
  return { procedures, entries, runbooks: metas };
}

// --- HTTP handler ------------------------------------------------------------

const ID_PATTERN = /^[a-z0-9-]+$/;

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function createWikiReadApi({ root } = {}) {
  // The default root resolves lazily (not at import time): in the bundled
  // Cloudflare worker import.meta.url is undefined, and an eager
  // fileURLToPath would throw during module evaluation and take the whole
  // worker down. A null root fails closed to 503 wiki_unavailable.
  const defaultRoot = () => {
    try {
      if (!import.meta.url) return null;
      return join(dirname(fileURLToPath(import.meta.url)), "..");
    } catch {
      return null;
    }
  };
  const load = () => {
    const repoRoot = root ?? defaultRoot();
    if (!repoRoot) throw new ServiceError(503, "wiki_unavailable", "Wiki planes unreadable in this runtime", null);
    try {
      return loadWikiIndex(repoRoot);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(503, "wiki_unavailable", "Wiki planes unreadable", null);
    }
  };
  const byId = (rows, id) => {
    if (!ID_PATTERN.test(id)) throw new ServiceError(404, "not_found", "Not found", null);
    const row = rows.find(r => r.id === id);
    if (!row) throw new ServiceError(404, "not_found", "Not found", null);
    return row;
  };

  function handle(pathname, method, searchParams) {
    if (!pathname.startsWith("/api/wiki/")) return null;
    if (method !== "GET" && method !== "HEAD") {
      throw new ServiceError(405, "method_not_allowed", "The wiki API is read-only", { Allow: "GET" });
    }
    const rest = pathname.slice("/api/wiki/".length);
    const [head, tail] = [rest.split("/")[0], rest.split("/").slice(1).join("/")];
    const index = load();

    if (head === "procedures" && !tail) {
      const procedures = index.procedures.map(summarizeProcedure);
      return { status: 200, body: { procedures, count: procedures.length } };
    }
    if (head === "procedures" && tail && !tail.includes("/")) {
      const p = byId(index.procedures, tail);
      return { status: 200, body: { id: p.id, title: p.title, body: p.body, source: p.source } };
    }
    if (head === "entries" && !tail) {
      const limit = clampInt(searchParams.get("limit"), 20, 1, 100);
      const offset = clampInt(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      const page = index.entries.slice(offset, offset + limit).map(summarizeEntry);
      return { status: 200, body: { entries: page, count: page.length, total: index.entries.length, limit, offset } };
    }
    if (head === "entries" && tail && !tail.includes("/")) {
      const e = byId(index.entries, tail);
      return { status: 200, body: { id: e.id, date: e.date, slice: e.slice, agent: e.agent, tried: e.tried, outcome: e.outcome, lesson: e.lesson, rejected: e.rejected } };
    }
    if (head === "runbooks" && !tail) {
      const runbooks = index.runbooks.map(r => ({ id: r.id, title: r.title, path: r.path }));
      return { status: 200, body: { runbooks, count: runbooks.length } };
    }
    if (head === "runbooks" && tail && !tail.includes("/")) {
      const r = byId(index.runbooks, tail);
      return { status: 200, body: { id: r.id, title: r.title, path: r.path, body: r.body } };
    }
    if (head === "search" && !tail) {
      const q = searchParams.get("q");
      if (!q || !q.trim()) throw new ServiceError(400, "bad_request", "Query parameter q is required", null);
      if (q.trim().length > 200) throw new ServiceError(400, "bad_request", "Query parameter q is too long (max 200)", null);
      const limit = clampInt(searchParams.get("limit"), 20, 1, 100);
      const { procedures, entries, runbooks } = searchWiki(index, q, limit);
      const count = procedures.length + entries.length + runbooks.length;
      return { status: 200, body: { query: q.trim(), procedures, entries, runbooks, count } };
    }
    throw new ServiceError(404, "not_found", "Not found", null);
  }

  return { handle };
}
