import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { replayNdjson } from "../server/room-export.mjs";

const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
process.umask(0o077);
try {
  if (!values.from || !values.to) throw new Error("Missing replay paths");
  const result = replayNdjson(readFileSync(values.from, "utf8"), values.to);
  // Report the strength of verification, not just successful replay. Legacy
  // exports can verify without pinning all table contents. Keep this allowlist:
  // recovery diagnostics and arbitrary errors may contain private source data.
  process.stdout.write(`${JSON.stringify({
    verified: result.verified,
    events: result.events,
    trailer: result.trailer,
    contentVerification: result.contentVerification,
    writeProofs: result.writeProofs,
    audit: { ok: result.audit.ok },
    skippedTables: result.skippedTables,
    sanitizedCells: result.sanitizedCells
  })}\n`);
} catch {
  process.stderr.write("Replay failed verification. The destination was not promoted. Inspect the private export before retrying.\n");
  process.exitCode = 1;
}
