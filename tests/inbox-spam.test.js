// A029: spam/phishing flagging. Pure heuristic tests; no network, no store.
import test from "node:test";
import assert from "node:assert/strict";
import { flagMessage, quarantineCandidates, scannableMessage, quarantineThreshold, SpamFlagError } from "../server/inbox-spam.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SpamFlagError && error.code === code);

test("ordinary mail scores zero and stays out of quarantine", () => {
  const flag = flagMessage({ from: "Avery Quinn <avery@example.com>", subject: "Lunch tomorrow?",
    body: "Want to grab lunch tomorrow at noon? Let me know what works.", urls: ["https://example.com/menu"], attachments: [] });
  assert.equal(flag.score, 0);
  assert.deepEqual(flag.signals, []);
  assert.equal(flag.quarantine, false);
});
test("a messaging-channel text with no email fields scans clean", () => {
  const flag = flagMessage({ body: "hey, are we still on for the call?" });
  assert.equal(flag.score, 0);
  assert.equal(flag.quarantine, false);
});
test("display-name address spoofing is caught", () => {
  const flag = flagMessage({ from: "security@paypal.com <bounce@evil-mail.ru>", subject: "Verify your account",
    body: "Dear customer, verify your account immediately.", urls: [] });
  assert.ok(flag.signals.some(s => s.key === "display_name_mismatch"));
  assert.ok(flag.score >= quarantineThreshold || flag.signals.some(s => s.key === "urgency_pressure"));
});
test("link text/target mismatch plus credential harvesting quarantines", () => {
  const flag = flagMessage({ from: "Support <support@banking-secure.top>", subject: "URGENT: verify now!",
    body: "Your account will be suspended. Log in here to verify your password now.",
    urls: [{ text: "https://mybank.com/login", target: "https://banking-secure.top/login" }], attachments: [] });
  const keys = flag.signals.map(s => s.key);
  assert.ok(keys.includes("link_text_mismatch"), keys.join(","));
  assert.ok(keys.includes("credential_harvest"), keys.join(","));
  assert.ok(keys.includes("suspicious_tld"), keys.join(","));
  assert.equal(flag.quarantine, true);
  assert.ok(flag.score <= 100);
});
test("dangerous attachments are flagged", () => {
  const flag = flagMessage({ from: "a@b.com", body: "see attached invoice", attachments: ["invoice.pdf.exe"] });
  assert.ok(flag.signals.some(s => s.key === "dangerous_attachment"));
  const clean = flagMessage({ from: "a@b.com", body: "see attached", attachments: ["invoice.pdf"] });
  assert.ok(!clean.signals.some(s => s.key === "dangerous_attachment"));
});
test("reply-to domain mismatch is flagged", () => {
  const flag = flagMessage({ from: "Billing <billing@example.com>", replyTo: "refunds@other-domain.net", body: "your receipt" });
  assert.ok(flag.signals.some(s => s.key === "reply_to_mismatch"));
});
test("quarantineCandidates returns only the tripped messages", () => {
  const clean = { body: "hello" };
  const phish = { from: "security@paypal.com <x@evil.ru>", subject: "FINAL NOTICE",
    body: "Your account will be suspended. Verify your password at the link below.",
    urls: [{ text: "https://paypal.com/verify", target: "https://evil.ru/verify" }], attachments: [] };
  const out = quarantineCandidates([clean, phish, clean]);
  assert.equal(out.length, 1);
  assert.equal(out[0].index, 1);
  assert.equal(out[0].flag.quarantine, true);
});
test("malformed inputs are contract errors", () => {
  throwsCode(() => flagMessage(null), "invalid_scannable_message");
  throwsCode(() => flagMessage({}), "invalid_scannable_message");
  throwsCode(() => flagMessage({ body: 42 }), "invalid_scannable_message");
  throwsCode(() => flagMessage({ body: "x", urls: [{}] }), "invalid_scannable_message");
  throwsCode(() => scannableMessage({ body: "x".repeat(131073) }), "invalid_scannable_message");
  const flag = flagMessage({ body: "hi" });
  assert.ok(Object.isFrozen(flag) && Object.isFrozen(flag.signals));
  assert.equal(quarantineThreshold, 60);
});
