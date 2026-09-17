// Slice 3 (RC-2026-09-17-012) unit tests: the magic-link mail sender seam.
//
// The seam is the boundary between the Room and the operator's mail
// provider. Unconfigured by default, it answers honestly
// (mail_not_configured) instead of pretending to deliver; tests inject a
// memory mailer. No network, no real credentials, no SMTP.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createMagicLinkMailer, magicLinkUnavailable, MAIL_NOT_CONFIGURED_MESSAGE } from "../server/magic-links.mjs";

const makeStore = (now = 1700000000000) => {
  const directory = mkdtempSync(join(tmpdir(), "magic-links-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  return store;
};

test("default mailer is unconfigured: honest non-delivery, never a fake send", async () => {
  const mailer = createMagicLinkMailer();
  assert.equal(mailer.isConfigured(), false);
  const result = await mailer.sendMagicLink({ to: "ada@example.com", code: "one-time-code", expiresAt: 1700000000001 });
  assert.deepEqual(result, { delivered: false, reason: "mail_not_configured" });
});

test("configured mailer delegates to the injected send and reports delivery", async () => {
  const sent = [];
  const mailer = createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
  assert.equal(mailer.isConfigured(), true);
  const result = await mailer.sendMagicLink({ to: "ada@example.com", code: "abc123", expiresAt: 1700000000001 });
  assert.deepEqual(result, { delivered: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { to: "ada@example.com", code: "abc123", expiresAt: 1700000000001, baseUrl: null });
});

test("injected memory mailer receives exactly what the model issued", async () => {
  const store = makeStore();
  try {
    const sent = [];
    const mailer = createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
    const issued = store.accountLogins.issueMagicCode({ email: "Ada@Example.COM" });
    const result = await mailer.sendMagicLink({ to: issued.email, code: issued.code, expiresAt: issued.expiresAt });
    assert.deepEqual(result, { delivered: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "ada@example.com");
    assert.equal(sent[0].code, issued.code);
    assert.equal(sent[0].expiresAt, issued.expiresAt);
    // Only the code digest is stored; the plaintext never touches the table.
    const row = store.db.prepare("SELECT code_hash FROM account_magic_codes").get();
    assert.equal(row.code_hash, createHash("sha256").update(issued.code, "utf8").digest("hex"));
    assert.notEqual(issued.code, row.code_hash);
  } finally {
    store.close();
  }
});

test("magicLinkUnavailable() carries the honest disabled shape for the HTTP layer", () => {
  assert.deepEqual(magicLinkUnavailable(), {
    status: "unavailable",
    reason: "mail_not_configured",
    message: MAIL_NOT_CONFIGURED_MESSAGE
  });
  assert.ok(MAIL_NOT_CONFIGURED_MESSAGE.includes("not configured"));
});

test("mailer rejects calls missing a recipient or code before any send", async () => {
  const sent = [];
  const mailer = createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
  await assert.rejects(() => mailer.sendMagicLink({ to: "", code: "x" }), /recipient and a code/);
  await assert.rejects(() => mailer.sendMagicLink({ to: "ada@example.com" }), /recipient and a code/);
  await assert.rejects(() => mailer.sendMagicLink(), /recipient and a code/);
  assert.equal(sent.length, 0);
});

test("mailer is frozen and ignores a non-function send", () => {
  const mailer = createMagicLinkMailer({ send: "smtp://example.invalid" });
  assert.equal(mailer.isConfigured(), false);
  assert.throws(() => { mailer.isConfigured = () => true; }, TypeError);
});
