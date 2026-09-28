// Privacy contract for the /feedback endpoint: secret-shaped material is
// redacted at intake, before dedup and storage. These tests own the
// *pattern* coverage — which secret shapes get redacted. The store tests
// own the *ordering* contract (scrubbed before dedup/storage); the two
// layers have distinct risks, so the split follows the one-owner rule.
import test from "node:test";
import assert from "node:assert/strict";
import { scrubString, scrubValue, scrubAttempt } from "../server/feedback-scrub.mjs";

test("JWT-shaped values are redacted", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqbyJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const out = scrubString(`Authorization: Bearer ${jwt}`);
  assert.ok(!out.includes("eyJhbGci"), "raw jwt must not survive");
  assert.match(out, /\[REDACTED:jwt\]/);
});

test("PEM private key blocks are redacted", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
  const out = scrubString(`key: ${pem}`);
  assert.ok(!out.includes("MIIEvQIBADAN"), "raw key material must not survive");
  assert.match(out, /\[REDACTED:private-key\]/);
});

test("vendor token prefixes are redacted", () => {
  for (const token of ["sk-abcdefghijklmnop", "ghp_abcdefghijklmnop", "xoxb-abcdefghijklmnop", "AKIAIOSFODNN7EXAMPLE"]) {
    const out = scrubString(`token=${token}`);
    assert.ok(!out.includes(token), `raw token ${token.slice(0, 4)}… must not survive`);
    assert.match(out, /\[REDACTED:token\]/);
  }
});

test("secret key names redact any value", () => {
  assert.equal(scrubValue("hunter2", "password"), "[REDACTED:credential]");
  assert.equal(scrubValue("Bearer abc", "authorization"), "[REDACTED:credential]");
  assert.equal(scrubValue("plain-word", "api_key"), "[REDACTED:credential]");
});

test("bare high-entropy blobs are redacted, structured codes survive", () => {
  assert.equal(scrubValue("a".repeat(48)), "[REDACTED:blob]");
  assert.equal(scrubValue("invalid_claim_input"), "invalid_claim_input");
  assert.equal(scrubValue("fb-000123"), "fb-000123");
});

test("scrubValue is recursive and never mutates its input", () => {
  const input = { body: { token: "sk-abcdefghijklmnop", nested: [{ password: "x" }] }, ok: "fine" };
  const out = scrubValue(input);
  assert.equal(out.body.token, "[REDACTED:credential]");
  assert.equal(out.body.nested[0].password, "[REDACTED:credential]");
  assert.equal(out.ok, "fine");
  assert.equal(input.body.token, "sk-abcdefghijklmnop", "input must not be mutated");
});

test("non-strings pass through unchanged", () => {
  assert.equal(scrubString(42), 42);
  assert.equal(scrubString(null), null);
  assert.deepEqual(scrubValue({ n: 7, b: true }), { n: 7, b: true });
});

test("scrubAttempt redacts request/response bodies and query-param tokens", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqbyJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const attempt = {
    goal: "call the thing",
    request: { method: "POST", path: "/api/widgets?api_key=sk-abcdefghijklmnop", body: { token: "sk-abcdefghijklmnop" } },
    response: { status: 401, body: { error: "bad", token: jwt } },
  };
  const out = scrubAttempt(attempt);
  assert.ok(!out.request.path.includes("sk-"), "query-param token must not survive");
  assert.equal(out.request.body.token, "[REDACTED:credential]");
  assert.ok(!out.response.body.token.includes("eyJhbGci"), "jwt in response bodies must not survive");
  assert.equal(out.response.status, 401, "structure survives scrubbing");
  assert.equal(out.goal, "call the thing");
});
