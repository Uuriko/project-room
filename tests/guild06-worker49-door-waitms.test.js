// WAVE-2000 guild-06 worker-49: scripts/prod-deploy-smoke.mjs —
// checkAgentCardDoor must fail closed on a non-finite waitMs (NaN) instead
// of looping forever. A NaN deadline makes `now() >= deadline` always false,
// so the door-convergence loop could never time out and the deploy smoke
// hung the deploy pipeline on a bad flag value.
//
// The hang is reproduced in a child process: before the fix the child never
// exits, the execFile timeout kills it, and this test fails. After the fix
// the child fails closed on the default 90s window and exits 0.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/prod-deploy-smoke.mjs", import.meta.url));

test("checkAgentCardDoor: non-finite waitMs fails closed instead of looping forever", async () => {
  const child = [
    `const { pathToFileURL } = await import("node:url");`,
    `const { checkAgentCardDoor } = await import(pathToFileURL(${JSON.stringify(script)}).href);`,
    `let clock = 0;`,
    `const failures = await checkAgentCardDoor({`,
    `  url: "http://127.0.0.1:9/.well-known/agent-card.json",`,
    `  expectedRevision: "a".repeat(40),`,
    `  fetches: 3,`,
    `  waitMs: NaN,`,
    `  get: async () => ({ status: 0, json: null, ms: 1, error: "refused" }),`,
    `  sleep: async (ms) => { clock += ms; },`,
    `  now: () => clock,`,
    `});`,
    `if (!failures.length) process.exit(3);`,
    `console.log(failures.at(-1));`,
  ].join("\n");
  const { code, stdout } = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", child], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error); // timeout/signal = hang => fail
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
  assert.equal(code, 0, "child must exit 0 (failed closed), not time out");
  assert.match(stdout, /not converged/);
});
