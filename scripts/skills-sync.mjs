// skills/ is the only source for Project Room skills. This copies that tree
// onto plugins/project-room/skills/, including skills that exist only under
// skills/ and dropping plugin-only copies such as the shelved bounty worker.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILLS_SOURCE = join(root, "skills");
export const SKILLS_COPY = join(root, "plugins", "project-room", "skills");
// Byte copies generated from skills/. A stale plugin copy does not fail CI;
// main rewrites it after merge. Other skill files stay exact copies.
export const GENERATED_SKILL_COPIES = new Set(["project-room/references/errors-catalog.md"]);
const ERRORS_CATALOG = "project-room/references/errors-catalog.md";

export function skillFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...skillFiles(path, base));
    else if (entry.isFile()) out.push(relative(base, path).split("\\").join("/"));
  }
  return out.sort();
}

export function errorsCatalogDrift(repo = root) {
  const sourcePath = join(repo, "skills", ERRORS_CATALOG);
  let source;
  try { source = readFileSync(sourcePath, "utf8"); }
  catch { return ["skills/project-room/references/errors-catalog.md is missing"]; }
  if (!source.includes("## Full code index")) return ["skills errors catalog is missing the Full code index"];
  return [];
}

// The plugin catalog is the skills catalog. Callers that install the plugin
// from main get the copy this writes; pull-request checks do not read it.
export function writeGeneratedErrorsCatalog(repo = root) {
  const source = readFileSync(join(repo, "skills", ERRORS_CATALOG));
  const dest = join(repo, "plugins", "project-room", "skills", ERRORS_CATALOG);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && readFileSync(dest).equals(source)) return false;
  writeFileSync(dest, source);
  return true;
}

export function skillDrift(sourceDir = SKILLS_SOURCE, copyDir = SKILLS_COPY) {
  const failures = [];
  let copyFiles = [];
  try { copyFiles = skillFiles(copyDir); }
  catch { failures.push("plugins/project-room/skills/ is missing"); }
  let sourceFiles = [];
  try { sourceFiles = skillFiles(sourceDir); }
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
    if (!copySet.has(file) || GENERATED_SKILL_COPIES.has(file)) continue;
    const source = readFileSync(join(sourceDir, file));
    const copy = readFileSync(join(copyDir, file));
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
if (isMain && process.argv.includes("--errors-catalog")) {
  const catalogErrors = errorsCatalogDrift();
  if (catalogErrors.length) {
    for (const failure of catalogErrors) console.error(`errors catalog: ${failure}`);
    process.exit(1);
  }
  const wrote = writeGeneratedErrorsCatalog();
  console.log(wrote ? "errors catalog: wrote plugin copy from skills/" : "errors catalog: plugin copy already matches skills/");
} else if (isMain) {
  const count = syncSkills();
  if (statSync(SKILLS_COPY).isDirectory() !== true) {
    console.error("skills sync did not create the plugin skills directory");
    process.exit(1);
  }
  console.log(`skills sync: copied ${count} files from skills/ to plugins/project-room/skills/`);
}
