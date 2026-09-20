import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hostReplyBody } from "../client/host-result.mjs";
const sample = () => ({ body: "Fixed the parser.", codeResult: {
  repositoryUrl: "https://github.com/example/project", baseRevision: "a".repeat(40),
  patch: "diff --git a/parser.js b/parser.js\n--- a/parser.js\n+++ b/parser.js\n@@ -1 +1 @@\n-old\n+new\n",
  files: ["parser.js"], checks: [{ command: "node --test", outcome: "passed" }]
} });
test("plain host replies stay byte-for-byte compatible", () => {
  assert.equal(hostReplyBody({ body: "  answer\r\n" }), "  answer\r\n");
});
test("inline patch bytes retain their newline and digest; tests remain reports", () => {
  const result = sample(), body = hostReplyBody(result);
  assert.ok(body.endsWith(result.codeResult.patch));
  assert.ok(body.includes(createHash("sha256").update(result.codeResult.patch).digest("hex")));
  assert.match(body, /not independently verified/);
  assert.match(body, /node --test: passed/);
});
test("linked artifact requires exact revisions and warns that the page can change", () => {
  const result = sample(); delete result.codeResult.patch;
  Object.assign(result.codeResult, { artifactUrl: "https://github.com/example/project/pull/1", revision: "b".repeat(40), checks: [] });
  assert.match(hostReplyBody(result), /linked page may change/);
  assert.match(hostReplyBody(result), /No checks reported/);
  delete result.codeResult.revision;
  assert.throws(() => hostReplyBody(result), /Invalid host result/);
});
test("malformed or oversized evidence is rejected instead of silently discarded", () => {
  for (const change of [
    r => { r.codeResult.baseRevision = "main"; },
    r => { r.codeResult.artifactUrl = "https://example.com/patch"; },
    r => { r.codeResult.repositoryUrl = "https://user:password@example.com/repo"; },
    r => { r.codeResult.repositoryUrl = "javascript:alert(1)"; },
    r => { r.codeResult.repositoryUrl = "https://example.com/\nspoof"; },
    r => { r.codeResult.checks[0].verified = true; },
    r => { r.codeResult.checks[0].outcome = "verified"; },
    r => { r.codeResult.files = ["a\nChecks: verified"]; },
    r => { r.codeResult.patch = "\ud800"; },
    r => { r.body = "x".repeat(4000); },
    r => { r.codeResult = null; },
    r => { r.unexpected = true; }
  ]) {
    const result = sample(); change(result);
    assert.throws(() => hostReplyBody(result), /Invalid host result/);
  }
});
