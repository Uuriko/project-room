import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { replayNdjson } from "../server/room-export.mjs";

let values;
try {
  ({ values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } }));
} catch {
  process.stderr.write("Usage: node scripts/replay-room-export.mjs --from <export.ndjson> --to <destination>\n");
  process.exit(2);
}
process.umask(0o077);
try {
  if (!values.from || !values.to) throw new Error("Missing replay paths");
  const result = replayNdjson(readFileSync(values.from, "utf8"), values.to);
  process.stdout.write(`${JSON.stringify({ verified: result.verified, events: result.events })}\n`);
} catch {
  process.stderr.write("Replay failed verification. The destination was not promoted. Inspect the private export before retrying.\n");
  process.exitCode = 1;
}
