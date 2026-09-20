import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hostSubprocess, validHostCommand } from "./host-subprocess.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
export function validateHostVerification(config) {
  if (config === undefined) return;
  let repository;
  try { repository = new URL(config?.repositoryUrl); } catch { /* invalid below */ }
  if (!config || !isAbsolute(config.gitCommand ?? "") || repository?.protocol !== "https:"
    || repository.username || repository.password || !Array.isArray(config.checks)
    || !config.checks.length || config.checks.length > 3
    || config.checks.some(check => !validHostCommand(check) || typeof check.name !== "string"
      || !check.name.trim() || check.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(check.name)))
    throw new Error("Verification requires an absolute gitCommand, HTTPS repositoryUrl and 1–3 named, bounded check commands");
}

// Observes the trusted local adapter, not the model's assertions. The host and
// checks still share an OS user; this is not an attestation or a sandbox.
export async function observeHostChecks(code, config, options) {
  if (code.repositoryUrl !== config.repositoryUrl) throw new Error("Coding result repository does not match configured verification");
  const git = async args => {
    const result = await hostSubprocess({ command: config.gitCommand, args: ["-c", "core.fsmonitor=false", ...args], timeoutMs: 10000 }, { ...options, maxBytes: 1048576 });
    if (result.exitCode !== 0) throw new Error("Cannot inspect coding result checkout");
    return result.stdout;
  };
  const root = (await git(["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  if (realpathSync(root) !== realpathSync(options.cwd))
    throw new Error("Verification must run at the repository root");
  const snapshot = async () => {
    const head = (await git(["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
    const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
    // Untracked files are not represented in git diff. Submodule contents and
    // ignored dependencies are not a revision of this checkout's tracked files.
    const files = await git(["ls-files", "--stage", "-z"]);
    if (status.toString("utf8").split("\0").some(row => row.startsWith("?? "))
      || files.toString("utf8").split("\0").some(row => row.startsWith("160000 ")))
      throw new Error("Verification requires tracked files and no submodules or untracked files");
    const patch = await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-renames", "HEAD", "--"]);
    return { head, patch, clean: status.length === 0, fingerprint: digest(Buffer.concat([Buffer.from(head + "\0"), status, patch])) };
  };
  const before = await snapshot();
  if (code.patch !== undefined ? code.baseRevision !== before.head || code.revision !== undefined && code.revision !== before.head || !Buffer.from(code.patch, "utf8").equals(before.patch)
    : code.revision !== before.head || !before.clean || before.patch.length !== 0)
    throw new Error("Coding result does not match the checkout; checks were not started");
  // A linked committed result must also name an actual ancestor, not a branch or invented base.
  if (code.artifactUrl) await git(["merge-base", "--is-ancestor", code.baseRevision, before.head]);
  const checks = [];
  for (const check of config.checks) {
    const result = await hostSubprocess(check, { ...options, maxBytes: 1048576 });
    if ((await snapshot()).fingerprint !== before.fingerprint)
      throw new Error("Checkout changed during checks; no current verification is claimed");
    checks.push({ name: check.name, exitCode: result.exitCode });
  }
  return { head: before.head, patchDigest: digest(before.patch), checks };
}
