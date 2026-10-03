// skills/ is the only source for Project Room skills. This copies that tree
// onto plugins/project-room/skills/, including skills that exist only under
// skills/ and dropping plugin-only copies such as the shelved bounty worker.
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
