// CLI arg-parsing tests for scripts/backup-room.mjs and
// scripts/replay-room-export.mjs (guild-06 fuzz).
// Unknown options must fail with usage on stderr + exit 2, never an
// uncaught ERR_PARSE_ARGS_UNKNOWN_OPTION stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = {
  "backup-room": fileURLToPath(new URL("../scripts/backup-room.mjs", import.meta.url)),
  "replay-room-export": fileURLToPath(new URL("../scripts/replay-room-export.mjs", import.meta.url)),
};

for (const [name, script] of Object.entries(scripts)) {
  test(`${name}: unknown options exit 2 with usage, no stack trace`, () => {
    for (const args of [["--help"], ["--bogus-flag-xyz"]]) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 15000 });
      assert.equal(r.status, 2, `${name} [${args.join(" ")}]: expected exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
      assert.doesNotMatch(r.stderr, /^\s*at\s/m, "no stack trace on usage error");
    }
  });
}
