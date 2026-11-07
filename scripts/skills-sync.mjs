// skills/ is the only source for Project Room skills. This copies that tree
// onto plugins/project-room/skills/, including skills that exist only under
// skills/ and dropping plugin-only copies such as the shelved bounty worker.
//
// Skill governance (W-39 ruling): there are exactly two skill homes.
//   1. skills/ — product skills for agents in rooms. Governed by the mirror
//      above: skills/ is the source, plugins/project-room/skills/ is a
//      byte-identical copy, and skillDrift() fails on any divergence.
//   2. .agents/skills/ — repo-development skills for agents working ON this
//      repository (referenced from the repo AGENTS.md). Deliberately NOT
//      mirrored: their audience is contributors, not room users, and one is
//      an upstream-licensed copy whose provenance lives in its SKILL.md.
//      They are hand-maintained, but not ungoverned: agentsSkillDrift()
//      below enumerates the tree and validates each skill's shape
//      (SKILL.md with a frontmatter name matching its directory, plus a
//      LICENSE), and skills-sync-check (the lint gate) fails on violations,
//      so a skill there can no longer silently exist, vanish, or rot.
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILLS_SOURCE = join(root, "skills");
export const SKILLS_COPY = join(root, "plugins", "project-room", "skills");

export function skillFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...skillFiles(path, base));
    else if (entry.isFile()) out.push(relative(base, path).split("\\").join("/"));
  }
  return out.sort();
}

export const AGENTS_SKILLS = join(root, ".agents", "skills");

// W-39: structural governance for the .agents/skills/ home (see header
// ruling). No mirror target exists for this tree, so the drift notion is
// shape, not bytes: every skill directory must carry a SKILL.md whose
// frontmatter `name:` equals the directory name, and a LICENSE file.
export function agentsSkillDrift() {
  const failures = [];
  let entries = [];
  try { entries = readdirSync(AGENTS_SKILLS, { withFileTypes: true }); }
  catch { return [".agents/skills/ is missing"]; }
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  if (dirs.length === 0) failures.push(".agents/skills/ contains no skills");
  for (const dir of dirs) {
    const base = join(AGENTS_SKILLS, dir);
    let skill = null;
    try { skill = readFileSync(join(base, "SKILL.md"), "utf8"); }
    catch { failures.push(`.agents/skills/${dir}: SKILL.md is missing`); continue; }
    const name = /^name:\s*(\S+)\s*$/m.exec(skill)?.[1];
    if (!name) failures.push(`.agents/skills/${dir}: SKILL.md has no frontmatter name`);
    else if (name !== dir) failures.push(`.agents/skills/${dir}: SKILL.md name '${name}' does not match its directory`);
    try { statSync(join(base, "LICENSE")); }
    catch { failures.push(`.agents/skills/${dir}: LICENSE is missing`); }
  }
  return failures;
}

export function skillDrift() {
  const failures = [];
  let copyFiles = [];
  try { copyFiles = skillFiles(SKILLS_COPY); }
  catch { failures.push("plugins/project-room/skills/ is missing"); }
  let sourceFiles = [];
  try { sourceFiles = skillFiles(SKILLS_SOURCE); }
  catch { failures.push("skills/ is missing"); return failures; }
  const copySet = new Set(copyFiles);
  const sourceSet = new Set(sourceFiles);
  for (const file of sourceFiles) {
    if (!copySet.has(file)) failures.push(`missing from plugin copy: ${file}`);
  }
  for (const file of copyFiles) {
    if (!sourceSet.has(file)) failures.push(`plugin copy has extra file: ${file}`);
  }
  for (const file of sourceFiles) {
    if (!copySet.has(file)) continue;
    const source = readFileSync(join(SKILLS_SOURCE, file));
    const copy = readFileSync(join(SKILLS_COPY, file));
    if (!source.equals(copy)) failures.push(`content differs: ${file}`);
  }
  return failures;
}

export function syncSkills() {
  // W3-F10: copy to a staging dir, then swap — a crash can no longer leave a
  // half-copied tree in place.
  const staging = `${SKILLS_COPY}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(SKILLS_SOURCE, staging, { recursive: true });
  rmSync(SKILLS_COPY, { recursive: true, force: true });
  renameSync(staging, SKILLS_COPY);
  return skillFiles(SKILLS_SOURCE).length;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const count = syncSkills();
  if (statSync(SKILLS_COPY).isDirectory() !== true) {
    console.error("skills sync did not create the plugin skills directory");
    process.exit(1);
  }
  console.log(`skills sync: copied ${count} files from skills/ to plugins/project-room/skills/`);
}
