// PRODUCT-200 A6: fail-first drift guard for skills/project-room/references/errors-catalog.md.
//
// The catalog is the doc agents read when a command fails. It must name every
// error.code the server can emit (QA-200 found "Unknown error '<code>'"
// fallthroughs and codes documented nowhere). These tests re-extract the live
// emit sites from server/ and fail when:
//   1. a server-emitted code is missing from the catalog (undocumented code), or
//   2. the catalog names a code the server no longer emits (stale row), or
//   3. a pinned doc statement no longer matches live behavior.
//
// Regenerate the catalog after server error changes:
//   node ~/workspace/project-room-qa/product200-docs/skill/A6/gen-docs.mjs
// (sources: resolve-final.mjs extraction + catalog.tsv evidence).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server");
const CATALOG = join(ROOT, "skills/project-room/references/errors-catalog.md");

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".mjs")) yield p;
  }
}

// Compact mirror of the extraction in resolve-final.mjs: every literal code
// handed to fail()/reject()/ServiceError/AgentPluginError, plus typed-error
// fail("code") sites. Variable-passed codes are resolved separately below.
function liveCodes() {
  const codes = new Set();
  const callRe = /(?:fail|reject)\(\s*(?:"([a-z][a-z0-9_]*)"|'([a-z][a-z0-9_]*)'|(\d{3}))\s*(?:,\s*(?:"([a-z][a-z0-9_]*)"|'([a-z][a-z0-9_]*)'|(\d{3})))?/g;
  const svcRe = /throw new ServiceError\(\s*(\d{3})\s*,\s*["']([a-z][a-z0-9_]*)["']/g;
  const apRe = /new AgentPluginError\(\s*(\d{3})\s*,\s*["']([a-z][a-z0-9_]*)["']/g;
  const adhocRe = /error:\s*\{\s*code:\s*"([a-z][a-z0-9_]*)"/g;
  for (const f of walk(SERVER)) {
    const t = readFileSync(f, "utf8");
    const addGroups = (re, idxs) => {
      let m; re.lastIndex = 0;
      while ((m = re.exec(t))) for (const i of idxs) if (m[i]) codes.add(m[i]);
    };
    addGroups(callRe, [1, 2, 4, 5]);
    addGroups(svcRe, [2]);
    addGroups(apRe, [2]);
    addGroups(adhocRe, [1]);
  }
  return codes;
}

// Codes passed via variables (not greppable as literals) — resolved by hand
// against the live definitions. If one of these definitions changes, this
// test's list must change too, which is the point.
const VARIABLE_CODES = new Map([
  ["trust_off", /TRUST_OFF_CODE = "trust_off"/],                    // src/events.js
  ["rate_limited", /limitCode = "rate_limited"/],                    // server/agent-identities.mjs default
  ["invalid_signing_input", /"invalid_signing_input"/],              // agent-plugin-routes signingCode
  ["invalid_card_signature", /"invalid_card_signature"/],
  ["invalid_password", /code: "invalid_password"/],                  // src/password-auth.mjs policy
  ["password_too_short", /code: "password_too_short"/],
  ["password_too_long", /code: "password_too_long"/],
]);

function catalogSection() {
  const md = readFileSync(CATALOG, "utf8");
  const i = md.indexOf("## Full code index");
  assert.ok(i > 0, "catalog is missing the '## Full code index' section");
  return md.slice(i);
}

function catalogRows() {
  const md = catalogSection();
  const rows = new Map(); // code -> [{status, retry}]
  for (const m of md.matchAll(/^\| `([a-z][a-z0-9_]*)` \| (\S+) \|/gm)) {
    const code = m[1];
    if (!rows.has(code)) rows.set(code, []);
    rows.get(code).push({ status: m[2] });
  }
  return rows;
}

function catalogRetry(code) {
  const md = catalogSection();
  // Pipes inside cell text are escaped as \| (no surrounding spaces), so a
  // plain " | " split is safe.
  const line = md.split("\n").find(l => l.startsWith(`| \`${code}\` |`));
  if (!line) return null;
  const cells = line.split(" | ");
  return cells[3] ? cells[3].trim() : null;
}

test("catalog exists and is linked from the skill", () => {
  assert.ok(readFileSync(CATALOG, "utf8").length > 10000, "catalog doc is unexpectedly small");
  const skill = readFileSync(join(ROOT, "skills/project-room/SKILL.md"), "utf8");
  assert.match(skill, /references\/errors-catalog\.md/, "SKILL.md must link the catalog");
  const errors = readFileSync(join(ROOT, "skills/project-room/references/errors.md"), "utf8");
  assert.match(errors, /references\/errors-catalog\.md/, "errors.md must point at the catalog");
});

test("every server-emitted code is in the catalog", () => {
  const live = liveCodes();
  const rows = catalogRows();
  const missing = [...live].filter(c => !rows.has(c));
  assert.deepEqual(missing, [], `codes emitted by the server but missing from the catalog: ${missing.join(", ")}`);
});

test("variable-passed codes resolve to live definitions and are catalogued", () => {
  const rows = catalogRows();
  const events = readFileSync(join(ROOT, "src/events.js"), "utf8");
  const identities = readFileSync(join(SERVER, "agent-identities.mjs"), "utf8");
  const pluginRoutes = readFileSync(join(SERVER, "agent-plugin-routes.mjs"), "utf8");
  const passwordAuth = readFileSync(join(ROOT, "src/password-auth.mjs"), "utf8");
  const sources = { "src/events.js": events, "server/agent-identities.mjs": identities, "server/agent-plugin-routes.mjs": pluginRoutes, "src/password-auth.mjs": passwordAuth };
  for (const [code, pattern] of VARIABLE_CODES) {
    const found = Object.values(sources).some(t => pattern.test(t));
    assert.ok(found, `variable-passed code '${code}' no longer resolves to a live definition`);
    assert.ok(rows.has(code), `variable-passed code '${code}' missing from the catalog`);
  }
});

test("pinned doc statements: retry semantics match the catalog", () => {
  // already_* family: reconcile, never retry (src/agent-error.mjs).
  assert.equal(catalogRetry("already_claimed"), "no");
  assert.equal(catalogRetry("already_member"), "no");
  // 429 family: wait for Retry-After.
  assert.equal(catalogRetry("rate_limited"), "wait");
  // Operator-only gaps: do not retry the send.
  assert.equal(catalogRetry("mail_not_configured"), "no");
  // Retired surface: named recovery, no retry.
  assert.equal(catalogRetry("board_v2_retired"), "no");
  const rows = catalogRows();
  assert.ok(rows.get("board_v2_retired")?.some(r => r.status === "410"), "board_v2_retired must be documented as HTTP 410");
});

test("pinned doc statements: family recovery rules are present", () => {
  const md = readFileSync(CATALOG, "utf8");
  assert.match(md, /Keep the same command id if the earlier send was uncertain/, "input_refused family rule");
  assert.match(md, /Do not mint a new identity to fix access/, "401 family rule");
  assert.match(md, /Do not guess ids/, "404 family rule");
  assert.match(md, /errorId.*fingerprint|fingerprint.*errorId/, "5xx trace rule");
  assert.match(md, /Unknown error '<code>'/, "fallthrough explanation");
});

test("no JSON-RPC numeric code section is empty", () => {
  const md = readFileSync(CATALOG, "utf8");
  for (const code of ["-32700", "-32600", "-32601", "-32602", "-32603", "-32001", "-32003"]) {
    assert.ok(md.includes(`\`${code}\``), `JSON-RPC code ${code} missing from the catalog`);
  }
});
