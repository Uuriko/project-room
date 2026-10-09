// FIX-27: credential hygiene gate. Fails CI if a credential-shaped file
// (identity.json, *.pem, *.key, token data files, ...) sits in the tree,
// or if a Bearer-token literal is committed in checked-in code.
//
// Fail-first design: the fixture below (a fake identity.json with a fake
// Bearer token) MUST be flagged. Delete the fixture and the live tree must
// scan clean. Fixture secrets are generated at runtime so this file never
// contains a literal secret-shaped string.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanCredentialHygiene,
  listHygieneFiles,
  matchFilenameRule,
  sniffBearerLiterals,
  HYGIENE_ALLOWLIST,
  LINE_ALLOWLIST,
  GITIGNORE_CREDENTIAL_PATTERNS,
} from "../scripts/credential-hygiene.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(ROOT, ".tmp", "credential-hygiene-fixture");
const FIXTURE_PATH = path.join(FIXTURE_DIR, "identity.json");

// Runtime-generated fake secret: no literal secret-shaped string in this file.
const fakeBearerToken = () =>
  Buffer.from("FIXTURE-NOT-A-REAL-TOKEN-wave300-fix27").toString("base64");

function writeFixture(content = null) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(
    FIXTURE_PATH,
    content ?? JSON.stringify({ identityId: "ai_fixture", bearer: fakeBearerToken() }, null, 2),
  );
}
function removeFixture() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

test("FIX-27: a fixture identity.json with a Bearer token is flagged", () => {
  writeFixture();
  try {
    const findings = scanCredentialHygiene([FIXTURE_PATH], { root: ROOT });
    const rules = findings.map((f) => f.rule);
    assert.ok(rules.includes("identity-json"), `filename rule missed it: ${JSON.stringify(rules)}`);
    assert.ok(rules.includes("bearer-token-literal"), `content sniff missed it: ${JSON.stringify(rules)}`);
    assert.ok(
      findings.every((f) => !f.preview.includes(fakeBearerToken())),
      "previews must be redacted",
    );
  } finally {
    removeFixture();
  }
});

test("FIX-27: clean content in a credential-shaped name is still flagged by name", () => {
  writeFixture(JSON.stringify({ note: "totally innocent json" }));
  try {
    const findings = scanCredentialHygiene([FIXTURE_PATH], { root: ROOT });
    assert.ok(findings.some((f) => f.rule === "identity-json"), "filename rule must fire regardless of content");
    assert.ok(!findings.some((f) => f.rule === "bearer-token-literal"), "clean content must not flag the sniff");
  } finally {
    removeFixture();
  }
});

test("FIX-27: legit code files never match the filename rules", () => {
  const legit = [
    "server/token-bucket.mjs",
    "cli/commands/token.mjs",
    "scripts/design-tokens-baseline.json",
    "scripts/lint-design-tokens.mjs",
    "tests/guest-token-expiry.test.js",
    "tests/token-bucket.test.js",
    "tests/secret-scan.test.js",
    "machine/lib/secrets.mjs",
    "server/identity-secret-hash.mjs",
    "tests/agent-identities-recoverable-credential.test.js",
    ".env.example",
    "docs/SECRET-SCAN.md",
  ];
  for (const f of legit) {
    assert.equal(matchFilenameRule(f), null, `legit file must not match: ${f}`);
  }
});

test("FIX-27: credential-shaped names are matched", () => {
  const cases = [
    ["work/identity.json", "identity-json"],
    ["work/identity-backup.json", "identity-json"],
    ["work/my-identity.json", "identity-json"],
    ["work/deploy-credentials.json", "credential-json"],
    ["work/id_rsa.key", "private-key-file"],
    ["work/cert.pem", "private-key-file"],
    ["work/keystore.p12", "private-key-file"],
    ["work/token.txt", "token-file"],
    ["work/access-token.json", "token-file"],
    ["work/id_token", "token-file"],
    ["work/github.token", "token-file"],
  ];
  for (const [f, rule] of cases) {
    assert.equal(matchFilenameRule(f), rule, `expected ${rule} for ${f}`);
  }
});

test("FIX-27: allowlisted paths are exempt", () => {
  writeFixture();
  try {
    const rel = path.relative(ROOT, path.resolve(ROOT, FIXTURE_PATH));
    HYGIENE_ALLOWLIST.add(rel);
    const findings = scanCredentialHygiene([FIXTURE_PATH], { root: ROOT });
    assert.equal(findings.length, 0, `allowlisted path must be exempt: ${JSON.stringify(findings)}`);
    HYGIENE_ALLOWLIST.delete(rel);
  } finally {
    removeFixture();
  }
});

test("FIX-27: line-allowlist entries are live, reasoned, and still needed", () => {
  assert.ok(LINE_ALLOWLIST.length > 0, "the exemption mechanism must be exercised by at least one entry");
  for (const entry of LINE_ALLOWLIST) {
    assert.ok(entry.file && entry.match && entry.reason, `entry needs file+match+reason: ${JSON.stringify(entry)}`);
    const abs = path.join(ROOT, entry.file);
    const lines = readFileSync(abs, "utf8").split("\n");
    const hits = lines.filter((l) => l.includes(entry.match));
    assert.ok(hits.length > 0, `stale allowlist entry (match not found): ${entry.file} :: ${entry.match}`);
    // The exemption must still be doing work: without it, the line flags.
    const raw = sniffBearerLiterals(hits);
    assert.ok(raw.length > 0, `allowlist entry no longer needed (nothing to exempt): ${entry.file} :: ${entry.match}`);
    // ...and with it, the file scans clean.
    const findings = scanCredentialHygiene([entry.file], { root: ROOT });
    assert.deepEqual(findings, [], `unexpected findings in allowlisted file: ${JSON.stringify(findings)}`);
  }
});

test("FIX-27: the live tree scans clean with the fixture removed", () => {
  removeFixture();
  const files = listHygieneFiles(ROOT);
  assert.ok(files.length > 100, "sanity: the tree should have many files");
  const findings = scanCredentialHygiene(files, { root: ROOT });
  assert.deepEqual(
    findings,
    [],
    `credential hygiene gate failed:\n${findings.map((f) => `  ${f.file}:${f.line ?? "-"} [${f.rule}]`).join("\n")}`,
  );
});

test("FIX-27: .gitignore pins the credential patterns from commit zero", () => {
  const gitignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  for (const pattern of GITIGNORE_CREDENTIAL_PATTERNS) {
    const lineRe = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
    assert.ok(lineRe.test(gitignore), `.gitignore must contain: ${pattern}`);
  }
});

test("FIX-27: bearer sniff flags both 'bearer <token>' and JSON forms, ignores placeholders", () => {
  const token = fakeBearerToken();
  const lines = [
    `Authorization: Bearer ${token}`,
    `"bearer": "${token}",`,
    `const x = "Bearer <redacted>";`,
    `// bearer example-not-a-token`,
    `token = "placeholder"`,
  ];
  const findings = sniffBearerLiterals(lines);
  assert.deepEqual(findings.map((f) => f.line), [1, 2]);
  assert.ok(!findings[0].preview.includes(token), "previews must be redacted");
});
