// Regression tests for the generic-secret key-name gap (F1-Q4 adjunct):
// the detector missed credential assignments whose key names carry a
// prefix or suffix around the password-family keyword — an assignment to
// a snake_case key like my_password_value, or a camelCase key like
// passwordHash, passed undetected while the bare key was caught.
// Key names and values are assembled at runtime so this file never
// contains a literal secret-shaped string (same convention as
// tests/secret-scan.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { scanText } from "../server/secret-scan.mjs";

const value = () => randomBytes(10).toString("hex"); // 20 chars, over the 12-char floor
const join = (parts, sep = "") => parts.join(sep);

const AFFIXED_KEYS = [
  join(["my", "password", "value"], "_"),
  join(["password", "Hash"]),
  join(["password", "hash"], "_"),
  join(["db", "password"], "_"),
  join(["user", "Password"]),
  join(["client", "secret"], "_"),
  join(["secret", "Key"]),
  join(["token", "value"], "_"),
  join(["my", "password", "value"], "-"),
  join(["reset", "pwd", "value"], "_"),
  join(["db", "Password", "Hash"]),
  join(["password", "1"]),
  join(["user", "Account", "Password"]),
  join(["app", "Db", "Password"]),
];
const FORMS = [
  (k, v) => `${k} = "${v}"`,
  (k, v) => `${k}=${v}`,
  (k, v) => `${k}: ${v}`,
  (k, v) => `{"${k}": "${v}"}`,
  (k, v) => `'${k}': '${v}'`,
];

test("affixed password-family key names are detected in assignment and JSON forms", () => {
  for (const key of AFFIXED_KEYS) {
    for (const form of FORMS) {
      const v = value();
      const findings = scanText(form(key, v));
      assert.ok(
        findings.some((f) => f.rule === "generic-secret"),
        `${key} must be flagged generic-secret in every form`
      );
      const hit = findings.find((f) => f.rule === "generic-secret");
      assert.ok(!hit.preview.includes(v), "preview must be redacted");
    }
  }
});

test("bare key names are still detected in JSON form", () => {
  for (const key of ["password", "PASSWORD", "PassWord", "token", "secret"]) {
    const findings = scanText(`{"${key}": "${value()}"}`);
    assert.ok(findings.some((f) => f.rule === "generic-secret"), `${key} JSON form must be flagged`);
  }
});

test("fused non-component words and prose mentions stay clean", () => {
  const v = value();
  const clean = [
    `${join(["token", "izer"])}: "${v}"`, // tokenizer is one component, not token + affix
    `${join(["password", "less"])} = "${v}"`, // passwordless likewise
    `${join(["secret", "ive"])} = "${v}"`,
    "The password policy requires rotation every ninety days for all accounts.",
    "Set the passwordHash algorithm to bcrypt with a cost factor of twelve.",
    "passwordless: true",
    "passwords are hashed with bcrypt before storage in the database",
  ];
  for (const line of clean) {
    assert.deepEqual(scanText(line), [], `must stay clean: ${line.slice(0, 40)}`);
  }
});

test("the value-length floor still applies to affixed keys", () => {
  const key = join(["my", "password", "value"], "_");
  assert.deepEqual(scanText(`${key}: "short"`), []);
  assert.deepEqual(scanText(`{"${key}": "short"}`), []);
});

// Review repros from seq4444 (Dot/Codex, 2026-11-10): the widened rule must not
// weaken detection versus main.
import { ALLOWLIST as REVIEW_ALLOWLIST, SAFE_ENTROPY_TOKENS as REVIEW_SAFE } from "../scripts/secret-scan-check.mjs";
test("a QUOTED credential that begins with '/' is still detected, an unquoted path/regex is not", () => {
  const a = "a".repeat(16);
  const quoted = scanText(`password = "/${a}";`, { allowlist: REVIEW_ALLOWLIST, safeEntropyTokens: REVIEW_SAFE });
  assert.ok(quoted.some(f => f.rule === "generic-secret"), "quoted /-led credential flags");
  const unquoted = scanText(`const tokenPattern = /${a}${a}/g;`, { allowlist: REVIEW_ALLOWLIST, safeEntropyTokens: REVIEW_SAFE, codeContext: true });
  assert.equal(unquoted.filter(f => f.rule === "generic-secret").length, 0, "unquoted regex literal is not a credential");
});
test("a credential-bearing https URL assigned to a token/secret key is still detected", () => {
  const a = "a".repeat(16);
  const found = scanText(`token = "https://user:${a}@test.invalid/";`, { allowlist: REVIEW_ALLOWLIST, safeEntropyTokens: REVIEW_SAFE });
  assert.ok(found.length > 0, "URL carrying a credential flags");
});

// Review repro from seq4457 (Codex, 2026-11-10): an UNQUOTED slash-leading value is a valid
// dotenv password. Only a regex-literal shape (/…/flags) is exempt, not every '/'-led value.
import { scanAddedUnits as REVIEW_SCAN_ADDED } from "../scripts/secret-scan-diff.mjs";
test("an unquoted slash-leading dotenv password is detected; regex-literal shapes are not", () => {
  const a = "a".repeat(16);
  const opts = { allowlist: REVIEW_ALLOWLIST, safeEntropyTokens: REVIEW_SAFE };
  assert.ok(scanText(`password=/${a}`, opts).some(f => f.rule === "generic-secret"), "tree scan flags password=/...");
  assert.ok(scanText(`PASSWORD=/${a}/${a}`, opts).some(f => f.rule === "generic-secret"), "multi-segment value flags");
  assert.ok(REVIEW_SCAN_ADDED([{ path: ".env", line: 1, text: `password=/${a}` }], []).length > 0, "PR-diff gate flags it too");
  // seq4471 (Codex): regex-SHAPED dotenv values are still credentials; only proven code context is exempt.
  for (const dotenv of [`password=/${a}/`, `PASSWORD=/${a}/g`, `password=/${a}/;`, `password: /${a}/`]) {
    assert.ok(scanText(dotenv, opts).some(f => f.rule === "generic-secret"), `dotenv-shaped value flags: ${dotenv}`);
    assert.ok(REVIEW_SCAN_ADDED([{ path: ".env", line: 1, text: dotenv }], []).length > 0, `PR-diff gate flags: ${dotenv}`);
  }
  // Declaration keyword proves code in any file; spacing + terminator proves code ONLY when the caller
  // asserts a JS/TS source file (seq4511: `password: /x{16}/;` is a valid YAML value).
  for (const literal of [`const tokenPattern = /${a}${a}/g;`, `export const SECRET_RE = /${a}/u`]) {
    assert.equal(scanText(literal, { ...opts, codeContext: true }).filter(f => f.rule === "generic-secret").length, 0, `declaration form exempt in JS/TS: ${literal}`);
    assert.equal(REVIEW_SCAN_ADDED([{ path: "src/x.mjs", line: 1, text: literal }], []).length, 0, `PR-diff gate exempts in .mjs: ${literal}`);
    assert.ok(scanText(literal, opts).some(f => f.rule === "generic-secret"), `no language context: flags ${literal}`);
  }
  // Codex seq4551: `export PASSWORD=/x{16}/` is valid dotenv/shell config; a declaration keyword is not proof of code either.
  for (const exported of [`export PASSWORD=/${a}/`, `export PASSWORD=/${a}/;`, `export password = /${a}/;`, `export const password = /${a}/;`, `let password = /${a}/;`]) {
    assert.ok(scanText(exported, opts).some(f => f.rule === "generic-secret"), `scanText flags without context: ${exported}`);
    for (const path of [".env", "deploy.sh", "config.yaml", "settings.toml"]) {
      assert.ok(REVIEW_SCAN_ADDED([{ path, line: 1, text: exported }], []).length > 0, `scanAddedUnits flags in ${path}: ${exported}`);
    }
  }
  for (const literal of [`token = /${a}\\d+/gi,`, `secretRe = /^${a}$/;`, `  tokenPattern: /${a}x/g,`]) {
    assert.equal(scanText(literal, { ...opts, codeContext: true }).filter(f => f.rule === "generic-secret").length, 0, `JS/TS context exempts: ${literal}`);
    assert.equal(REVIEW_SCAN_ADDED([{ path: "src/x.js", line: 1, text: literal }], []).length, 0, `PR-diff gate exempts in .js: ${literal}`);
    assert.ok(scanText(literal, opts).some(f => f.rule === "generic-secret"), `no language context: flags ${literal}`);
  }
  // Codex seq4511 repro: spacing + terminator is valid YAML/dotenv, so config files and context-free scans flag it.
  for (const yaml of [`password: /${a}/;`, `password = /${a}/;`, `password: /${a}/,`, `password: /${a}/)`, `password = /${a}/,`, `password: /${a}/]`]) {
    assert.ok(scanText(yaml, opts).some(f => f.rule === "generic-secret"), `scanText flags: ${yaml}`);
    for (const path of ["config.yaml", "config.yml", ".env", "settings.toml"]) {
      assert.ok(REVIEW_SCAN_ADDED([{ path, line: 1, text: yaml }], []).length > 0, `scanAddedUnits flags in ${path}: ${yaml}`);
    }
  }
});
