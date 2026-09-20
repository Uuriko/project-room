// H005: secret scanning. Pure detector tests; no file writes.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { scanText, scanLines, SecretScanError, PATTERNS } from "../server/secret-scan.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SecretScanError && error.code === code);
// All example secrets are generated at runtime so this file never contains
// a literal secret-shaped string (GitHub push protection).
const fakeAwsKey = () => "AKIA" + randomBytes(12).toString("hex").toUpperCase().slice(0, 16);
const fakeStripeKey = () => "sk_test_" + randomBytes(16).toString("hex");

test("known secret patterns are found with redacted previews", () => {
  const awsKey = fakeAwsKey(), stripeKey = fakeStripeKey();
  const findings = scanText(`key = "${awsKey}"\napi_key: "${stripeKey}"\nhello world`);
  assert.equal(findings.length, 3); // line 2 matches both generic-api-key and stripe-key
  assert.deepEqual(findings.map(f => f.rule), ["aws-access-key", "generic-api-key", "stripe-key"]);
  assert.deepEqual(findings.map(f => f.line), [1, 2, 2]);
  assert.ok(!findings[0].preview.includes(awsKey), "preview must be redacted");
  assert.ok(Object.isFrozen(findings));
});
test("high-entropy strings are flagged; allowlist suppresses", () => {
  const secret = randomBytes(32).toString("base64url"); // 43 chars, entropy ~5.3
  const findings = scanLines([`deployed ${secret} ok`, "just a normal sentence here"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "high-entropy");
  const allowed = scanLines([`deployed ${secret} ok`], { allowlist: [new RegExp(secret.slice(0, 8))] });
  assert.equal(allowed.length, 0);
});
test("clean text yields no findings", () => {
  assert.deepEqual(scanText("hello world\nnothing to see here"), []);
});
test("malformed inputs are refused", () => {
  throwsCode(() => scanText(42), "invalid_secret_scan");
  throwsCode(() => scanLines("nope"), "invalid_secret_scan");
  throwsCode(() => scanText("x", { allowlist: ["not a regex"] }), "invalid_secret_scan");
});

// Regression for secret-scanning alert #1 (2026-09-17): a real Telegram bot
// token was committed in tests/telegram-connect.test.js. These tests lock in
// the fix once the token is rotated: the scanner must catch the bot-token
// shape, and committed fixtures may only carry obviously-fake placeholders.
// The burned token's VALUE never appears here — only its shape, generated
// at runtime.
const fakeBotToken = () => {
  const botId = String(100000000 + Math.floor(Math.random() * 899999999)); // 9 digits
  const secret = randomBytes(26).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "x").slice(0, 35);
  return `${botId}:${secret}`;
};

test("telegram bot token shape is detected with a redacted preview", () => {
  const pattern = PATTERNS.find(p => p.id === "telegram-bot-token");
  assert.ok(pattern, "scanner must have a telegram-bot-token rule");
  const token = fakeBotToken();
  assert.match(token, pattern.regex, "runtime fixture must exercise the real shape");
  const findings = scanText(`bot_token = "${token}"\nhello world`);
  assert.ok(findings.some(f => f.rule === "telegram-bot-token"), "real-shaped token must be flagged");
  const hit = findings.find(f => f.rule === "telegram-bot-token");
  assert.ok(!hit.preview.includes(token.slice(5)), "preview must be redacted");
});

test("telegram token detection includes non-word endings without partial matches", () => {
  const pattern = PATTERNS.find(p => p.id === "telegram-bot-token").regex;
  for (const length of [34, 35]) for (const ending of ["-", "_", "a", "0"]) {
    const token = [String(123456789), "A".repeat(length - 1) + ending].join(":");
    for (const wrapped of [token, `https://api.telegram.org/bot${token}/sendMessage`, `"${token}"`]) {
      assert.equal(pattern.exec(wrapped)?.[0].replace(/^bot/, ""), token);
      assert.ok(scanText(wrapped).some(f => f.rule === "telegram-bot-token"));
    }
    assert.equal(pattern.test(token + "AA"), false, "do not match only a prefix of a longer alphabet run");
  }
});

test("regression: telegram fixtures carry no real-shaped bot token", () => {
  const pattern = PATTERNS.find(p => p.id === "telegram-bot-token");
  const globalShape = new RegExp(pattern.regex.source, "g");
  const files = readdirSync(new URL(".", import.meta.url))
    .filter(name => /^telegram-.*\.test\.js$/.test(name));
  assert.ok(files.includes("telegram-connect.test.js"), "the alert-#1 fixture file must be covered");
  let shapedTotal = 0;
  for (const name of files) {
    const text = readFileSync(new URL(name, import.meta.url), "utf8");
    const shaped = text.match(globalShape) ?? [];
    shapedTotal += shaped.length;
    for (const value of shaped) {
      assert.match(value, /FAKE|PLACEHOLDER|EXAMPLE|DUMMY/i,
        `${name}: bot-token-shaped fixture value must be an obviously-fake placeholder`);
    }
  }
  assert.ok(shapedTotal > 0, "fixtures should still exercise the token shape");
});

// The gate's allowlist is where a false positive gets silenced, so it is also
// where a real secret would get silenced by accident. This pins the one entry
// that suppresses a whole shape rather than a named line.
test("the gate allows a token assembled at runtime and still catches a literal one", async () => {
  const { ALLOWLIST } = await import("../scripts/secret-scan-check.mjs");
  const scan = line => scanText(line, { allowlist: ALLOWLIST });

  // A template literal whose only content is interpolations and separators
  // carries nothing to leak. server/web-push.mjs builds the VAPID JWT this way.
  assert.deepEqual(scan("  const token = `${signingInput}.${toBase64Url(signature)}`;"), []);
  assert.deepEqual(scan("  const token = `${a}`;"), []);
  assert.deepEqual(scan("    headers: { token: `${scheme} ${value}` },"), []);

  // A literal run inside the template is exactly what the rule is for.
  const literal = "sk_test_" + randomBytes(16).toString("hex");
  assert.equal(scan(`  const token = \`${literal}\`;`).length > 0, true, "a hardcoded value in a template is still a finding");
  assert.equal(scan(`  const token = \`prefix-\${x}-${literal}\`;`).length > 0, true, "and so is one beside an interpolation");
  assert.equal(scan(`  const password = "${literal}";`).length > 0, true);
});
