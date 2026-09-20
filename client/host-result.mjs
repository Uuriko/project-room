import { createHash } from "node:crypto";

// Process stdout cannot populate this side channel. It is deliberately absent
// from JSON and only formatted after the local adapter has run configured checks.
const observations = new WeakMap();
export const recordObservedChecks = (result, receipt) => observations.set(result, receipt);
const fail = () => { throw new Error("Invalid host result; return { body } with optional codeResult and keep the complete reply within 4096 characters"); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.trim() && value.length <= max && value.isWellFormed();
const line = (value, max) => text(value, max) && !/[\u0000-\u001f\u007f]/u.test(value);
const revision = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function url(value) {
  if (!line(value, 1024) || /[\s<>]/u.test(value)) return false;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && !parsed.username && !parsed.password; }
  catch { return false; }
}

// One immutable message, not a second work/completion system. External URLs and
// all metadata are host reports: this adapter neither fetches nor verifies them.
// The digest identifies exact inline patch bytes, not correctness or test success.
export function hostReplyBody(result) {
  if (!object(result) || Object.keys(result).some(key => !["body", "codeResult"].includes(key)) || !text(result.body, 4096)) fail();
  if (!Object.hasOwn(result, "codeResult")) return result.body;
  const code = result.codeResult;
  if (!object(code) || Object.keys(code).some(key => !["repositoryUrl", "baseRevision", "revision", "artifactUrl", "patch", "files", "checks"].includes(key))
    || !url(code.repositoryUrl) || !revision(code.baseRevision)
    || (code.revision !== undefined && !revision(code.revision))
    || (Object.hasOwn(code, "patch") === Object.hasOwn(code, "artifactUrl"))
    || (Object.hasOwn(code, "patch") && !text(code.patch, 3000))
    || (Object.hasOwn(code, "artifactUrl") && (!url(code.artifactUrl) || !revision(code.revision)))
    || !Array.isArray(code.files) || code.files.length < 1 || code.files.length > 30 || code.files.some(file => !line(file, 256))
    || !Array.isArray(code.checks) || code.checks.length > 10
    || code.checks.some(check => !object(check) || Object.keys(check).length !== 2
      || !line(check.command, 256) || !["passed", "failed", "not_run"].includes(check.outcome))) fail();
  const lines = [result.body, "", "Code result · host-reported", `Repository: ${code.repositoryUrl}`, `Base: ${code.baseRevision}`];
  if (code.revision) lines.push(`Revision: ${code.revision}`);
  if (code.artifactUrl) lines.push(`Patch / PR: ${code.artifactUrl}`, "Review the exact revision above; the linked page may change.");
  lines.push(`Files: ${code.files.join(", ")}`, "Checks · host-reported, not independently verified:",
    ...(code.checks.length ? code.checks.map(check => `• ${check.command}: ${check.outcome.replace("_", " ")}`) : ["• No checks reported."]));
  const observed = observations.get(result);
  if (observed) lines.push("Observed by local adapter · exit status, not a code review:",
    `Checked HEAD: ${observed.head}`, `Checked patch SHA-256: ${observed.patchDigest}`,
    ...observed.checks.map(check => `• ${check.name}: exit ${check.exitCode} (${check.exitCode === 0 ? "passed" : "failed"})`));
  if (code.patch !== undefined) lines.push(`Patch SHA-256: ${createHash("sha256").update(code.patch, "utf8").digest("hex")}`,
    "Patch (exact bytes after this line):", code.patch);
  const body = lines.join("\n");
  if (!text(body, 4096)) fail(); // Never truncate evidence or silently omit a result.
  return body;
}
