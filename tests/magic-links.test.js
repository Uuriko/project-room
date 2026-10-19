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
import { createMagicLinkMailer, magicLinkUnavailable, MAIL_NOT_CONFIGURED_MESSAGE, isMailRecipientRefusal, attemptAuthMailDelivery, magicReturnToForAccount } from "../server/magic-links.mjs";

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
  await assert.rejects(() => mailer.sendMagicLink({ to: "", code: "x" }), /recipient/);
  await assert.rejects(() => mailer.sendMagicLink({ to: "ada@example.com" }), /recipient and a code/);
  await assert.rejects(() => mailer.sendMagicLink(), /recipient/);
  assert.equal(sent.length, 0);
});

const providerError = status => Object.assign(new Error(`send failed (HTTP ${status})`), { providerStatus: status });

test("isMailRecipientRefusal classifies permanent provider refusals only (#3529)", () => {
  // Permanent, recipient/request-class refusals: retrying cannot succeed.
  for (const status of [400, 403, 404, 409, 422]) {
    assert.equal(isMailRecipientRefusal(providerError(status)), true, `HTTP ${status} is a refusal`);
  }
  assert.equal(isMailRecipientRefusal(Object.assign(new Error("refused"), { recipientRefused: true })), true);
  assert.equal(isMailRecipientRefusal(Object.assign(new Error("refused"), { code: "mail_recipient_refused" })), true);
  // Transient or platform-wide failures stay retryable/loud, never absorbed.
  for (const status of [401, 408, 429, 500, 502, 503]) {
    assert.equal(isMailRecipientRefusal(providerError(status)), false, `HTTP ${status} is not a refusal`);
  }
  assert.equal(isMailRecipientRefusal(new Error("socket hangup")), false, "network errors carry no status");
  assert.equal(isMailRecipientRefusal(null), false);
  assert.equal(isMailRecipientRefusal("HTTP 422"), false, "a bare string is not a classified error");
});

test("attemptAuthMailDelivery absorbs refusals and rethrows transient failures (#3529)", async () => {
  const warnings = [];
  const warn = message => warnings.push(message);
  assert.equal(await attemptAuthMailDelivery(async () => {}, "magic-request", warn), true);
  assert.equal(await attemptAuthMailDelivery(async () => { throw providerError(422); }, "magic-request", warn), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mail delivery refused \(magic-request\)/);
  assert.match(warnings[0], /HTTP 422/, "the log keeps the provider status for operators");
  await assert.rejects(() => attemptAuthMailDelivery(async () => { throw providerError(503); }, "magic-request", warn), /HTTP 503/);
  await assert.rejects(() => attemptAuthMailDelivery(async () => { throw new Error("socket hangup"); }, "magic-request", warn), /socket hangup/);
  assert.equal(warnings.length, 1, "transient failures are not logged as refusals");
});

test("mailer is frozen and ignores a non-function send", () => {
  const mailer = createMagicLinkMailer({ send: "smtp://example.invalid" });
  assert.equal(mailer.isConfigured(), false);
  assert.throws(() => { mailer.isConfigured = () => true; }, TypeError);
});

test("magicReturnToForAccount keeps the room hint only for the account's own rooms", () => {
  const memberOfCommons = roomId => roomId === "commons";
  // A room the account belongs to: the target is untouched, byte for byte.
  assert.equal(magicReturnToForAccount("/?room=commons", memberOfCommons), "/?room=commons");
  const joinTarget = "/?room=commons#join/" + "A".repeat(43) + "/work/task-1";
  assert.equal(magicReturnToForAccount(joinTarget, memberOfCommons), joinTarget);
  // A room it does not belong to: the hint is silently dropped and the
  // rest of the target — account hint, invitation fragment — survives.
  assert.equal(magicReturnToForAccount("/?room=elsewhere", memberOfCommons), "/");
  assert.equal(magicReturnToForAccount("/?room=elsewhere&account=1", memberOfCommons), "/?account=1");
  const invite = "/?room=elsewhere#invite/" + "A".repeat(43);
  assert.equal(magicReturnToForAccount(invite, memberOfCommons), "/#invite/" + "A".repeat(43));
  // No room hint: nothing to vouch for. Invalid targets pass through
  // untouched, so the callers' 422 set is exactly as before.
  assert.equal(magicReturnToForAccount("/", memberOfCommons), "/");
  assert.equal(magicReturnToForAccount("/?account=1", memberOfCommons), "/?account=1");
  assert.equal(magicReturnToForAccount("https://evil.example/", memberOfCommons), "https://evil.example/");
  assert.equal(magicReturnToForAccount("/?room=a&room=b", memberOfCommons), "/?room=a&room=b");
  assert.equal(magicReturnToForAccount(undefined, memberOfCommons), undefined);
  assert.equal(magicReturnToForAccount("/?room=commons", null), "/?room=commons");
});
