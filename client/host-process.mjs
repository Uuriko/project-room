import { hostReplyBody, recordObservedChecks } from "./host-result.mjs";
import { hostSubprocess, validHostCommand } from "./host-subprocess.mjs";
import { observeHostChecks, validateHostVerification } from "./host-verification.mjs";
import { isAbsolute, join } from "node:path";
import { mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export function configuredHost(config) {
  if (!validHostCommand(config) || !isAbsolute(config.cwd ?? "")
    || config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env)
      || Object.entries(config.env).some(([key, value]) => typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))))
    throw new Error("Host configuration requires absolute command/cwd, argument array and timeoutMs (100–3600000)");
  validateHostVerification(config.verification);
  if (config.env && Object.keys(config.env).length) throw new Error("Automatic host cannot receive configured environment variables");
  const settings = structuredClone(config);
  return async ({ signal, ...input }) => {
    if (signal?.aborted) throw new Error("Host cancelled");
    let payload;
    try { payload = JSON.stringify(input); }
    catch { throw new Error("Host input must be JSON serializable"); }
    let lock;
    try {
      const directory = join(homedir(), ".project-room", "host-locks");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      lock = join(directory, createHash("sha256").update(realpathSync(settings.cwd)).digest("hex"));
      mkdirSync(lock, { mode: 0o700 });
    } catch { throw new Error("Checkout has an active or unresolved host, or its lock is unavailable; reconcile before running"); }
    try {
      // The lock uses the operator home; the host sees only an isolated /tmp HOME.
      const env = Object.fromEntries(["PATH", "TMPDIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
      // No operator credentials are forwarded into the isolated process.
      const options = { cwd: settings.cwd, env, signal, isolate: true };
      const output = await hostSubprocess(settings, { ...options, input: payload });
      if (output.exitCode !== 0) throw new Error("Host exited unsuccessfully; reconcile the original attempt");
      let result;
      try {
        result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output.stdout));
        hostReplyBody(result);
      } catch { throw new Error("Host must return one JSON object with body and optional valid codeResult, totaling at most 4096 reply characters"); }
      if (settings.verification && result.codeResult) {
        recordObservedChecks(result, await observeHostChecks(result.codeResult, settings.verification, { ...options, isolate: false }));
        hostReplyBody(result); // Include observations in the existing reply size limit.
      }
      return result;
    } finally {
      try { rmdirSync(lock); } catch { /* leave an unresolved lock intact */ }
    }
  };
}
