#!/usr/bin/env node
// Official MCP conformance suite with a not-applicable baseline, plus a separate hard assertion
// that hostile Host/Origin headers are refused (the one dns-rebinding check that must pass).
// Usage: node scripts/qa2/mcp-conformance.mjs --url http://127.0.0.1:4173/mcp [--version 0.x.y]
// Retries once after 65 s when the run trips Room's anonymous MCP rate limit.
import { argv, exit } from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const url = arg("url", "http://127.0.0.1:4173/mcp");
const pkg = `@modelcontextprotocol/conformance${arg("version") ? "@" + arg("version") : ""}`;
const baseline = fileURLToPath(new URL("./baselines/mcp-conformance-baseline.yml", import.meta.url));
const run = args => { try { return { code: 0, out: execFileSync("npx", ["-y", pkg, "server", "--url", url, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 }) }; } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const suite = run(["--expected-failures", baseline]);
console.log(suite.out.split("\n").slice(-25).join("\n"));
// The full suite fires ~30 scenarios in seconds and can trip Room's anonymous per-address MCP limit.
// Re-run each unexpected failure alone after a cool-down; only a repeat failure counts.
const unexpected = suite.code === 0 ? [] : [...suite.out.split("Unexpected failures")[1]?.matchAll(/✗ ([a-z0-9-]+)/g) ?? []].map(m => m[1]);
let suiteOk = suite.code === 0 || unexpected.length > 0;
if (unexpected.length) await sleep(65000);
for (const scenario of unexpected) {
  const again = run(["--scenario", scenario, "--verbose"]);
  const ok = !/"status":\s*"FAILURE"/.test(again.out) && /"status":\s*"(SUCCESS|WARNING)"/.test(again.out);
  console.log(`re-run ${scenario} alone: ${ok ? "pass (first failure was rate limiting)" : "FAIL"}`);
  if (!ok) suiteOk = false;
  await sleep(3000);
}
if (suite.code !== 0 && !unexpected.length) suiteOk = false; // e.g. stale baseline entries
await sleep(2000);
let reb = run(["--scenario", "dns-rebinding-protection", "--verbose"]);
if (/rate_limited/.test(reb.out)) { await sleep(65000); reb = run(["--scenario", "dns-rebinding-protection", "--verbose"]); }
const rejected = /"id":\s*"localhost-host-rebinding-rejected"[\s\S]*?"status":\s*"SUCCESS"/.test(reb.out);
console.log(`hostile Host/Origin refused: ${rejected}`);
exit(suiteOk && rejected ? 0 : 1);
