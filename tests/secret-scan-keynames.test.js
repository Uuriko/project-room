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
