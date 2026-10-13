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

test("every secret in a string is redacted, not just the first", () => {
  // Regression: the scrub regexes were non-global, so replace() stopped
  // after the first match and later secrets reached storage verbatim.
  const jwtA = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const jwtB = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJiIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const outJwt = scrubString(`one ${jwtA} two ${jwtB}`);
  assert.ok(!outJwt.includes(jwtA) && !outJwt.includes(jwtB), "both JWTs must be redacted");
  assert.equal(outJwt.match(/\[REDACTED:jwt\]/g).length, 2);

  const outTok = scrubString("first ghp_abcdefghijklmnop second sk-abcdefghijklmnop");
  assert.ok(!outTok.includes("ghp_abcdefghijklmnop"), "first token must not survive");
  assert.ok(!outTok.includes("sk-abcdefghijklmnop"), "second token must not survive");
  assert.equal(outTok.match(/\[REDACTED:token\]/g).length, 2);

  const pemA = "-----BEGIN PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABAQ\n-----END PRIVATE KEY-----"; // secrets-allowlist (fixture value, not a credential)
  const pemB = "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END RSA PRIVATE KEY-----"; // secrets-allowlist (fixture value, not a credential)
  const outPem = scrubString(`a ${pemA} b ${pemB}`);
  assert.ok(!outPem.includes("AAAAB3NzaC1yc2E"), "first PEM block must not survive");
  assert.ok(!outPem.includes("MIIEvQIBADAN"), "second PEM block must not survive");
  assert.equal(outPem.match(/\[REDACTED:private-key\]/g).length, 2);
});

test("#3011: tokens and JWTs whose final segment is exactly 8 chars ending in '-' are redacted", () => {
  // The pre-fix defect: TOKEN_PREFIX_RE and JWT_RE ended with
  // [A-Za-z0-9_-]{8,}\b. The class includes '-' (a non-word char), so when
  // the final segment is exactly the 8-char minimum and ends in '-', the
  // trailing \b cannot be satisfied and backtracking cannot go below
  // {8,} — the pattern missed entirely and the secret survived verbatim.
  for (const token of ["ghp_aaaaaaa-", "sk-aaaaaaa-", "AKIAaaaaaaa-"]) {
    const out = scrubString(`x ${token} y`);
    assert.ok(!out.includes(token), `raw token ${token} must not survive`);
    assert.equal(out, "x [REDACTED:token] y");
  }
  const jwt = "eyJaaaaaaaa.bbbbbbbb.ccccccc-";
  const jwtOut = scrubString(`x ${jwt} y`);
  assert.ok(!jwtOut.includes(jwt), "raw jwt must not survive");
  assert.equal(jwtOut, "x [REDACTED:jwt] y");

  // Controls: the same shapes without the trailing '-' already redacted
  // before the fix and must keep redacting.
  assert.equal(scrubString("x ghp_aaaaaaaa y"), "x [REDACTED:token] y");
  assert.equal(scrubString("x sk-aaaaaaaa y"), "x [REDACTED:token] y");
  assert.equal(scrubString("x AKIAaaaaaaaa y"), "x [REDACTED:token] y");
  assert.equal(
    scrubString("x eyJaaaaaaaa.bbbbbbbb.cccccccc y"),
    "x [REDACTED:jwt] y");
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

test("H-3: bare query-string secrets are redacted; ordinary params survive", () => {
  // The pre-fix defect: only vendor-prefixed tokens (sk-, ghp-, ...) were
  // redacted, so ?api_key=deadbeef1 passed through to storage verbatim.
  assert.equal(
    scrubString("https://x.example/path?api_key=deadbeef1"),
    "https://x.example/path?api_key=[REDACTED:credential]");
  assert.equal(
    scrubString("https://x.example/path?token=deadbeef1"),
    "https://x.example/path?token=[REDACTED:credential]");
  assert.equal(
    scrubString("/api/things?page=2&sort=asc"),
    "/api/things?page=2&sort=asc",
    "non-secret params must survive");
  assert.equal(
    scrubString("/api/things?API_KEY=deadbeef1"),
    "/api/things?API_KEY=[REDACTED:credential]",
    "secret param names match case-insensitively");
  assert.equal(
    scrubString("/x?api_key=deadbeef1#frag"),
    "/x?api_key=[REDACTED:credential]#frag",
    "fragments survive scrubbing");
  assert.equal(
    scrubString("/x?api_key=deadbeef1&api_key=second"),
    "/x?api_key=[REDACTED:credential]&api_key=[REDACTED:credential]",
    "repeated secret params are all redacted");
});

test("H-3: scrubAttempt redacts bare query-param secrets in request paths", () => {
  const attempt = {
    goal: "g",
    request: { method: "GET", path: "/api/things?api_key=deadbeef1&verbose=true" },
    response: { status: 200, body: {} },
  };
  const out = scrubAttempt(attempt);
  assert.equal(out.request.path, "/api/things?api_key=[REDACTED:credential]&verbose=true");
});
