#!/usr/bin/env node
// gen-doc-index.mjs — generates docs/INDEX.md, the one-screen map, from a
// doc registry (DS-2, Docs Programme). Fleet-side first build; when the
// registry lands in W-D1 this generator's in-repo home is
// scripts/gen-doc-index.mjs (automation §2) — same file, same CLI.
//
// Conventions (automation §2.1, binding):
//   - header stamp carries SHAs, never a wall-clock date:
//     generated-by: gen-doc-index@1 · source: <base SHA> · inputs: <path>@<sha256-8>
//   - --check regenerates to memory and byte-compares; exit 1 on any diff,
//     printing the first differing line. Writing is never required to check.
//   - deterministic: rows sorted by path, no locale, no timestamps,
//     no absolute paths in the output.
//
// What the map is: the programme §2 canonical set (the doors), grouped by
// the §2 subsection each row's seed_rule cites — NOT the full inventory.
// The full listing is the generated registry view (render-view.mjs ->
// docs/doc-registry.md). Rows the programme did not name in §2 are counted
// in the footer, never silently dropped and never listed.
// Planned rows (existence "planned") file under their type's door section
// and are marked (planned); served rows are marked (served).
// spec/-style family-tagged file groups collapse to one line; the ARCHIVE
// pinned set collapses to one line (its members live in the registry view).
//
// Ladder wiring: --demotions <file> accepts the docs sweep's demotions
// export ({"paths": {"<path>": "DEMOTE"|"DELETE-CANDIDATE"}}). DEMOTE paths
// leave their trust section and are listed under "Demoted"; DELETE-CANDIDATE
// paths are omitted and counted in the footer.
//
// Usage:
//   node gen-doc-index.mjs --registry <registry.json> [--out <INDEX.md>]
//                          [--check] [--demotions <demotions.json>]
// Exit: 0 ok / 1 --check diff / 2 usage error.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const VERSION = 1;
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) args[k] = process.argv[++i];
    else args[k] = true;
  }
}
if (!args.registry) {
  console.error("usage: gen-doc-index.mjs --registry <registry.json> [--out <file>] [--check] [--demotions <file>]");
  process.exit(2);
}
const regPath = path.resolve(args.registry);
const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
const regSha8 = crypto.createHash("sha256").update(fs.readFileSync(regPath)).digest("hex").slice(0, 8);
const inputLabel = reg.registry_path_in_repo || path.basename(regPath);
const source = reg.reconciled_at_base || "(no base recorded)";

const demotions = args.demotions
  ? (JSON.parse(fs.readFileSync(path.resolve(args.demotions), "utf8")).paths || {})
  : {};

const SECTIONS = [
  { tag: "§2.1", title: "Start here — for humans", plannedTypes: ["CANONICAL"] },
  { tag: "§2.2", title: "For agents", plannedTypes: ["GENERATED"] },
  { tag: "§2.3", title: "Contracts and protocol", plannedTypes: ["CONTRACT"] },
  { tag: "§2.4", title: "Protected sets", plannedTypes: [] },
  { tag: "§2.5", title: "Runbooks", plannedTypes: ["RUNBOOK"] },
  { tag: "§2.6", title: "Reference shelf and families", plannedTypes: [] },
];
function sectionOf(row) {
  const sr = row.seed_rule || "";
  const m = sr.match(/§2\.\d/);
  if (m) return m[0];
  if (row.existence === "planned") {
    const s = SECTIONS.find((s) => s.plannedTypes.includes(row.type));
    if (s) return s.tag;
  }
  return null;
}

const rows = (reg.docs || []).filter((r) => r.path !== "docs/INDEX.md");
const bySection = new Map(SECTIONS.map((s) => [s.tag, []]));
let unlisted = 0;
const archivePresent = [];
for (const r of rows) {
  if (r.type === "ARCHIVE" && r.existence === "present") { archivePresent.push(r); continue; }
  const tag = sectionOf(r);
  if (!tag || !bySection.has(tag)) { unlisted++; continue; }
  bySection.get(tag).push(r);
}

// Collapse file rows sharing a directory + a "family" seed_rule marker
// (the spec/ shape) into one synthetic line.
function collapse(sectionRows) {
  const groups = new Map();
  const out = [];
  for (const r of sectionRows) {
    const sr = r.seed_rule || "";
    if (r.kind === "file" && /family/i.test(sr)) {
      const dir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/") + 1) : "";
      if (dir) {
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push(r);
        continue;
      }
    }
    out.push(r);
  }
  for (const [dir, members] of groups) {
    if (members.length >= 3) {
      out.push({ path: dir, kind: "group", count: members.length, existence: "present" });
    } else out.push(...members);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const demotedLines = [];
let deleteOmitted = 0;
let listedLines = 0;
function lineFor(r) {
  const rung = demotions[r.path];
  if (rung === "DELETE-CANDIDATE") { deleteOmitted++; return null; }
  // Family rows may carry a synthetic label in `path` ("(examples)");
  // the family_id is the display name there.
  let label = r.path.startsWith("(") && r.family_id ? `${r.family_id}/` : r.path;
  const suffix = [];
  if (r.kind === "family" && (r.members || []).length) suffix.push(`(family: ${r.members.length} files)`);
  if (r.kind === "group") suffix.push(`(${r.count} files)`);
  if (r.existence === "planned") suffix.push("(planned)");
  if (r.existence === "served") suffix.push("(served)");
  const line = `- \`${label}\`${suffix.length ? " " + suffix.join(" ") : ""}`;
  if (rung === "DEMOTE") { demotedLines.push(line); return null; }
  listedLines++;
  return line;
}

const out = [];
out.push(`<!-- generated-by: gen-doc-index@${VERSION} · source: ${source} · inputs: ${inputLabel}@${regSha8} -->`);
out.push("# Documentation index");
out.push("");
out.push("One-screen map of the documentation set, generated from the doc");
out.push("registry. The full listing is the registry view (`docs/doc-registry.md`).");
for (const s of SECTIONS) {
  const lines = collapse(bySection.get(s.tag)).map(lineFor).filter(Boolean);
  if (s.tag === "§2.6" && archivePresent.length) {
    const rung = demotions["archive/"];
    if (rung !== "DELETE-CANDIDATE") {
      const l = `- \`archive/\` pinned set (${archivePresent.length} files)`;
      if (rung === "DEMOTE") demotedLines.push(l); else { lines.push(l); listedLines++; }
    } else deleteOmitted++;
  }
  if (!lines.length) continue;
  out.push("", `## ${s.title}`, "", ...lines);
}
if (demotedLines.length) {
  out.push("", "## Demoted by the ladder — verify before trusting", "", ...demotedLines.sort());
}
out.push("");
out.push(`Registered: ${rows.length + 1} rows · listed here: ${listedLines} lines · ` +
  `archive pinned set: ${archivePresent.length} files · not listed (reference depth): ${unlisted} rows` +
  (deleteOmitted ? ` · omitted at DELETE rung: ${deleteOmitted}` : "") +
  ". Regenerate: `node scripts/gen-doc-index.mjs`; never hand-edit.");
const text = out.join("\n") + "\n";

if (args.check) {
  if (!args.out) { console.error("--check requires --out <existing file>"); process.exit(2); }
  const existing = fs.readFileSync(path.resolve(args.out), "utf8");
  if (existing === text) { console.log(`gen-doc-index: ${args.out} is current (${Buffer.byteLength(text)} B)`); process.exit(0); }
  const a = existing.split("\n"), b = text.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.log(`gen-doc-index: STALE — first differing line ${i + 1}:`);
      console.log(`  on disk:  ${a[i] ?? "(eof)"}`);
      console.log(`  expected: ${b[i] ?? "(eof)"}`);
      break;
    }
  }
  process.exit(1);
}
if (args.out) fs.writeFileSync(path.resolve(args.out), text);
else process.stdout.write(text);
console.log(`gen-doc-index: ${Buffer.byteLength(text)} B${args.out ? ` -> ${args.out}` : ""}`);
