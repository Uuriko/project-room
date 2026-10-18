// Replay a whole-store NDJSON export into a NEW sqlite file and print the
// full verification result — the same fields the KV route
// (scripts/restore-room-backup.mjs) surfaces for the same bytes.
//
// The restore is reported as success only when it verifies at the
// strongest level: contentVerification "full" and, when the restored
// store carries bounty tables, conservation ok. Anything weaker exits
// non-zero with the reason named, unless the operator passes
// --allow-partial to accept a partial or legacy restore knowingly (the
// result is still printed and still names the weaker level). --audit
// report passes through to replayNdjson: recovery-audit drift and
// conservation failures are then named on the result instead of refusing
// the restore itself.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { replayNdjson } from "../server/room-export.mjs";

const { values } = parseArgs({ options: {
  from: { type: "string" }, to: { type: "string" },
  audit: { type: "string" }, "allow-partial": { type: "boolean", default: false }
} });
process.umask(0o077);
try {
  if (!values.from || !values.to) throw new Error("Missing replay paths");
  const result = replayNdjson(readFileSync(values.from, "utf8"), values.to, { audit: values.audit ?? "strict" });
  process.stdout.write(`${JSON.stringify({
    verified: result.verified, events: result.events, trailer: result.trailer,
    contentVerification: result.contentVerification,
    backedUpAt: result.backedUpAt ? new Date(result.backedUpAt).toISOString() : null,
    audit: result.audit, conservation: result.conservation,
    skippedTables: result.skippedTables, sanitizedCells: result.sanitizedCells
  }, null, 2)}\n`);
  const shortfalls = [];
  if (result.contentVerification !== "full") shortfalls.push(`contentVerification is "${result.contentVerification}", not "full"`);
  if (result.conservation && !result.conservation.ok) shortfalls.push(`conservation failed (${result.conservation.violations.length} violation(s))`);
  if (shortfalls.length && !values["allow-partial"]) {
    process.stderr.write(`Replay restored below full verification — ${shortfalls.join("; ")}. Refusing to report success; pass --allow-partial to accept this restore knowingly.\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`Replay failed verification: ${String(error?.message ?? error).split("\n")[0]}. The destination was not promoted. Inspect the private export before retrying.\n`);
  process.exitCode = 1;
}
