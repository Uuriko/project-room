// W009: pure wiki-plane parsers (no I/O, no imports).
//
// Shared by server/wiki-read-api.mjs (HTTP handler over the embedded data)
// and scripts/wiki-build.mjs (build-time embed). Keeping the parsers in this
// leaf module breaks the build cycle: the build script must import the
// parsers without pulling in server/wiki-data.mjs, which does not exist yet
// on a first build.

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const basename = path => String(path).split("/").pop();

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

export function summarizeProcedure(p) { return { id: p.id, title: p.title, summary: p.summary }; }
export function summarizeEntry(e) { return { id: e.id, date: e.date, slice: e.slice, agent: e.agent, outcome: e.outcome, lesson: e.lesson }; }
export function summarizeRunbook(r) { return { id: r.id, title: r.title }; }

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
