// Offline source-reuse inventory. Never downloads or executes upstream code.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = ["id", "name", "status", "owner", "purpose", "target", "nextAction", "acceptance", "reviewTrigger"];
export function validateLibrary(data, base = root) {
  const errors = [], ids = new Set();
  if (data?.version !== 1 || !Array.isArray(data.entries)) return ["Expected version 1 and entries array"];
  for (const item of data.entries) {
    if (!item || typeof item !== "object") { errors.push("Invalid entry"); continue; }
    const fail = message => errors.push(`${item.id ?? "unknown"}: ${message}`);
    for (const key of required) if (typeof item[key] !== "string" || !item[key].trim()) fail(`missing ${key}`);
    if (ids.has(item.id)) fail("duplicate id"); ids.add(item.id);
    if (!/^[a-z0-9-]+$/.test(item.id ?? "")) fail("invalid id");
    if (!["candidate", "trial", "adopted", "rejected", "retired"].includes(item.status)) fail("invalid status");
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(item.upstream?.repository ?? "")) fail("expected public GitHub repository URL");
    if (!/^[a-f0-9]{40}$/.test(item.upstream?.revision ?? "")) fail("expected immutable upstream revision");
    if (!Array.isArray(item.upstream?.files) || !item.upstream.files.length) fail("missing upstream files");
    for (const file of Array.isArray(item.upstream?.files) ? item.upstream.files : []) {
      if (typeof file?.path !== "string" || !file.path || isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..") || !/^[a-f0-9]{40}$/.test(file.gitBlob ?? "")) fail("invalid upstream file pin");
    }
    if (!item.license?.expression || !item.license?.path || !item.license?.review) fail("missing license evidence");
    if (!Array.isArray(item.evidence) || !Array.isArray(item.localPaths)) fail("expected evidence and localPaths arrays");
    for (const path of Array.isArray(item.localPaths) ? item.localPaths : []) {
      if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) { fail("local path escapes repository"); continue; }
      const full = resolve(base, path);
      if (!existsSync(full)) { fail(`missing local path ${path}`); continue; }
      const rel = relative(realpathSync(base), realpathSync(full));
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) fail("local symlink escapes repository");
    }
    if (item.status === "adopted") {
      if (!item.localPaths?.length || !item.evidence?.length || typeof item.integration !== "string" || !item.integration.trim() || !Array.isArray(item.notices) || !item.notices.length) fail("adopted requires local paths, evidence, integration and notices");
    }
  }
  return errors;
}

export function selectEntries(data, action, value) {
  if (action === "show") {
    const entry = data.entries.find(item => item.id === value);
    if (!entry) throw new Error("Unknown source id");
    return entry;
  }
  if (action === "list") return data.entries.filter(item => !value || item.status === value);
  if (action === "next") return data.entries.filter(item => ["candidate", "trial"].includes(item.status))
    .map(({ id, owner, target, nextAction, acceptance }) => ({ id, owner, target, nextAction, acceptance }));
  throw new Error("Use check, list [status], show ID, or next");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const data = JSON.parse(readFileSync(resolve(root, "docs/source-library.json"), "utf8"));
    const errors = validateLibrary(data);
    if (errors.length) throw new Error(errors.join("; "));
    const [action = "list", value] = process.argv.slice(2);
    console.log(JSON.stringify(action === "check" ? { ok: true, entries: data.entries.length } : selectEntries(data, action, value), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1;
  }
}
