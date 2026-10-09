// skills/ is the only source for Project Room skills. This copies that tree
// onto plugins/project-room/skills/, including skills that exist only under
// skills/ and dropping plugin-only copies such as the shelved bounty worker.
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILLS_SOURCE = join(root, "skills");
export const SKILLS_COPY = join(root, "plugins", "project-room", "skills");

// Injectable filesystem surface: defaults are node:fs; tests inject faults to
// prove the swap below survives a crash mid-way.
const DEFAULT_FS = { cpSync, mkdirSync, renameSync, rmSync, existsSync };

export function skillFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...skillFiles(path, base));
    else if (entry.isFile()) out.push(relative(base, path).split("\\").join("/"));
  }
  return out.sort();
}

export function skillDrift({ sourceDir = SKILLS_SOURCE, copyDir = SKILLS_COPY } = {}) {
  const failures = [];
  let copyFiles = [];
  try { copyFiles = skillFiles(copyDir); }
  catch { failures.push(`${copyDir} is missing`); }
  let sourceFiles = [];
  try { sourceFiles = skillFiles(sourceDir); }
  catch { failures.push(`${sourceDir} is missing`); return failures; }
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
    const source = readFileSync(join(sourceDir, file));
    const copy = readFileSync(join(copyDir, file));
    if (!source.equals(copy)) failures.push(`content differs: ${file}`);
  }
  return failures;
}

export function syncSkills({ sourceDir = SKILLS_SOURCE, copyDir = SKILLS_COPY, fs: fileOps = DEFAULT_FS } = {}) {
  // W3-F10: build in a staging dir, then swap through a backup — rename(2) is
  // atomic, so the old tree is moved aside (never deleted) before the swap
  // lands. A crash or failed swap can no longer destroy the only good copy:
  // the previous tree is either still in place or left under .previous for
  // the next run to restore before syncing again.
  const { cpSync: cp, mkdirSync: mkdir, renameSync: rename, rmSync: rm, existsSync: exists } = fileOps;
  const staging = `${copyDir}.staging`;
  const backup = `${copyDir}.previous`;
  // Recover a run that crashed mid-swap: restore the surviving previous tree
  // first, then sync normally on top of it.
  if (!exists(copyDir) && exists(backup)) rename(backup, copyDir);
  rm(backup, { recursive: true, force: true });
  rm(staging, { recursive: true, force: true });
  mkdir(staging, { recursive: true });
  cp(sourceDir, staging, { recursive: true });
  let movedAside = false;
  try { rename(copyDir, backup); movedAside = true; }
  catch { /* first sync: there is no previous copy to preserve */ }
  try {
    rename(staging, copyDir);
  } catch (error) {
    // Swap failed: roll the previous tree back into place, never leave the
    // copy missing, and let the caller see the original error.
    if (movedAside) rename(backup, copyDir);
    throw error;
  }
  rm(backup, { recursive: true, force: true });
  return skillFiles(sourceDir).length;
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
