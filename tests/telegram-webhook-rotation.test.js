// Telegram webhook secret rotation: generation, dual-accept window, rotation
// state transitions, the connection.webhook.rotate/.complete journal actions,
// the Reconnect trigger's rotation behavior, and the connection card surface.
// Fixture secrets only; nothing here is a real credential.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { ChannelWebhookInbox, validateWebhookSecret } from "../server/channel-import.mjs";
import { generateWebhookSecret, hashRotationSecret, startWebhookRotation, completeWebhookRotation,
  webhookRotationState, webhookRotationView, webhookAcceptsHash, webhookRotationDefaults } from "../server/channel-adapters/telegram-rotation.mjs";
import { telegramConfig, telegramLiveView } from "../server/channel-adapters/telegram-config.mjs";
import { runRotateWebhook } from "../scripts/telegram-rotate-webhook.mjs";
import { createRoomServer } from "../server/http.mjs";

const OLD_SECRET = "fixture-old-webhook-secret-0123456789";
const NEW_SECRET = "fixture-new-webhook-secret-9876543210";
const WRONG_SECRET = "fixture-wrong-webhook-secret-0000000000";
const oldHash = ChannelWebhookInbox.hash(OLD_SECRET);
const newHash = ChannelWebhookInbox.hash(NEW_SECRET);

function fixture(t) {
  const f = createAcceptanceFixture(); f.filename = join(f.directory, "room.sqlite");
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.telegram = telegramContractFixture();
  const account = f.store.accountForMember("commons", "owner"), key = f.store.issueAccountAccessKey(account.id), slot = f.store.createAccountSessionSlot();
  f.auth = { token: slot.token, account, ...f.store.loginAccountSession(slot.token, key, 0) };
  f.telegram.connection.accountId = f.auth.account.id;
  f.apply = request => f.store.connections.apply(f.auth.token, request, f.auth.sessionBinding);
  f.configure = () => f.apply({ action: "connection.configure", requestId: randomUUID(), connectionId: f.telegram.connection.id,
    expectedRevision: 0, profile: structuredClone(f.telegram.connection) });
  f.registerWebhook = secret => f.apply({ action: "connection.webhook", requestId: randomUUID(), connectionId: f.telegram.connection.id,
    expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret) });
  f.rotate = (secret, previousSecret, windowMs) => f.apply({ action: "connection.webhook.rotate", requestId: randomUUID(),
    connectionId: f.telegram.connection.id, expectedRevision: 1, secretHash: ChannelWebhookInbox.hash(secret),
    previousSecretHash: ChannelWebhookInbox.hash(previousSecret), rotationExpiresAt: Date.now() + windowMs });
  f.webhooks = new ChannelWebhookInbox(f.store);
  f.deliver = (secret, update) => f.webhooks.receive({ connectionId: f.telegram.connection.id, secret, body: update });
  return f;
}

test("generateWebhookSecret produces crypto-secure secrets the server's gate accepts", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const secret = generateWebhookSecret();
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(new Set(secret).size >= 6, "enough distinct characters");
    assert.equal(seen.has(secret), false, "no repeats"); seen.add(secret);
    assert.equal(validateWebhookSecret(secret), true);
    assert.match(hashRotationSecret(secret), /^[a-f0-9]{64}$/);
    assert.equal(ChannelWebhookInbox.hash(secret), hashRotationSecret(secret), "same digest as the inbox gate");
  }
  assert.throws(() => generateWebhookSecret(8), /16 to 64/);
  assert.throws(() => generateWebhookSecret(65), /16 to 64/);
  assert.throws(() => hashRotationSecret("short"), /16 to 256/);
});

test("rotation state transitions: none -> pending -> complete, by expiry or by hand", () => {
  const at = 1_700_000_000_000, windowMs = 3600_000;
  assert.equal(webhookRotationState(null, at), "none");
  assert.equal(webhookRotationState(undefined, at), "none");
  assert.equal(webhookRotationState({ secretHash: oldHash }, at), "none");
  const record = startWebhookRotation({ webhook: { secretHash: oldHash }, newSecretHash: newHash, windowMs, at });
  assert.deepEqual(record, { secretHash: newHash, previousSecretHash: oldHash, rotationExpiresAt: at + windowMs, rotationState: "pending", updatedAt: at });
  assert.equal(webhookRotationState(record, at), "pending");
  assert.equal(webhookRotationState(record, at + windowMs - 1), "pending");
  assert.equal(webhookRotationState(record, at + windowMs), "complete", "the window end stops accepting the old secret");
  assert.equal(webhookRotationState(record, at + windowMs + 1), "complete");
  assert.deepEqual(webhookRotationView(record, at), { contractVersion: 1, state: "pending", windowExpiresAt: new Date(at + windowMs).toISOString() });
  assert.deepEqual(webhookRotationView(record, at + windowMs), { contractVersion: 1, state: "complete", windowExpiresAt: null });
  assert.deepEqual(webhookRotationView(null, at), { contractVersion: 1, state: "none", windowExpiresAt: null });
  const done = completeWebhookRotation(record, at + 1000);
  assert.deepEqual(done, { secretHash: newHash, rotationState: "complete", rotationCompletedAt: at + 1000, updatedAt: at + 1000 });
  assert.equal(webhookRotationState(done, at + 1000), "complete");
  assert.deepEqual(webhookRotationView(done, at + 1000), { contractVersion: 1, state: "complete", windowExpiresAt: null });
  assert.throws(() => completeWebhookRotation({ secretHash: newHash }, at), /No webhook rotation is pending/);
  assert.throws(() => completeWebhookRotation(done, at), /No webhook rotation is pending/);
  assert.throws(() => completeWebhookRotation(null, at), /No webhook secret is registered/);
});

test("startWebhookRotation rejects bad inputs", () => {
  const at = 1_700_000_000_000;
  assert.throws(() => startWebhookRotation({ webhook: null, newSecretHash: newHash, at }), /currently registered/);
  assert.throws(() => startWebhookRotation({ webhook: {}, newSecretHash: newHash, at }), /currently registered/);
  assert.throws(() => startWebhookRotation({ webhook: { secretHash: oldHash }, newSecretHash: oldHash, at }), /must differ/);
  assert.throws(() => startWebhookRotation({ webhook: { secretHash: oldHash }, newSecretHash: "nope", at }), /SHA-256/);
  assert.throws(() => startWebhookRotation({ webhook: { secretHash: oldHash }, newSecretHash: newHash, windowMs: 999, at }), /1 second to 7 days/);
  assert.throws(() => startWebhookRotation({ webhook: { secretHash: oldHash }, newSecretHash: newHash, windowMs: 8 * 24 * 3600_000, at }), /1 second to 7 days/);
  assert.equal(webhookRotationDefaults.windowMs, 24 * 3600_000, "the default window is 24h");
});

test("webhookAcceptsHash dual-accepts during the window and rejects after expiry", () => {
  const at = 1_700_000_000_000;
  const record = startWebhookRotation({ webhook: { secretHash: oldHash }, newSecretHash: newHash, windowMs: 3600_000, at });
  assert.equal(webhookAcceptsHash(record, newHash, at), true);
  assert.equal(webhookAcceptsHash(record, oldHash, at), true, "old secret accepted during the window");
  assert.equal(webhookAcceptsHash(record, "f".repeat(64), at), false);
  assert.equal(webhookAcceptsHash(record, "not-hex", at), false);
  assert.equal(webhookAcceptsHash(record, oldHash, at + 3600_000), false, "old secret rejected after expiry");
  assert.equal(webhookAcceptsHash(record, newHash, at + 3600_000), true, "new secret still accepted after expiry");
  assert.equal(webhookAcceptsHash(null, newHash, at), false);
  assert.equal(webhookAcceptsHash({ secretHash: newHash }, newHash, at), true);
  assert.equal(webhookAcceptsHash({ secretHash: newHash }, oldHash, at), false);
});

test("the webhook inbox dual-accepts the old and new secrets while a rotation is pending", t => {
  const f = fixture(t); f.configure(); f.registerWebhook(OLD_SECRET);
  f.rotate(NEW_SECRET, OLD_SECRET, webhookRotationDefaults.windowMs);
  const stored = f.store.connections.connection(f.auth.account.id, f.telegram.connection.id).webhook;
  assert.equal(stored.rotationState, "pending");
  assert.equal(stored.secretHash, newHash); assert.equal(stored.previousSecretHash, oldHash);
  assert.equal(f.deliver(OLD_SECRET, f.telegram.updates[0]).received, 1, "old secret verifies during the window");
  assert.equal(f.deliver(NEW_SECRET, f.telegram.updates[1]).received, 1, "new secret verifies during the window");
  assert.throws(() => f.deliver(WRONG_SECRET, f.telegram.updates[2]), { code: "channel_webhook_denied" });
});

test("an expired rotation window rejects the old secret end to end", async t => {
  const f = fixture(t); f.configure(); f.registerWebhook(OLD_SECRET);
  f.rotate(NEW_SECRET, OLD_SECRET, 1000); // the floor: a 1s window
  assert.equal(f.deliver(OLD_SECRET, f.telegram.updates[0]).received, 1, "old secret verifies during the window");
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.throws(() => f.deliver(OLD_SECRET, f.telegram.updates[1]), { code: "channel_webhook_denied" }, "old secret rejected after expiry");
  assert.equal(f.deliver(NEW_SECRET, f.telegram.updates[1]).received, 1, "new secret still verifies after expiry");
});

test("connection.webhook.complete ends dual-accept immediately", t => {
  const f = fixture(t); f.configure(); f.registerWebhook(OLD_SECRET);
  f.rotate(NEW_SECRET, OLD_SECRET, webhookRotationDefaults.windowMs);
  assert.equal(f.deliver(OLD_SECRET, f.telegram.updates[0]).received, 1);
  const result = f.apply({ action: "connection.webhook.complete", requestId: randomUUID(), connectionId: f.telegram.connection.id, expectedRevision: 1 });
  assert.equal(result.receipt.action, "connection.webhook.complete");
  const stored = f.store.connections.connection(f.auth.account.id, f.telegram.connection.id).webhook;
  assert.equal(stored.rotationState, "complete");
  assert.equal(stored.previousSecretHash, undefined, "the old digest is dropped");
  assert.equal(stored.secretHash, newHash);
  assert.throws(() => f.deliver(OLD_SECRET, f.telegram.updates[1]), { code: "channel_webhook_denied" });
  assert.equal(f.deliver(NEW_SECRET, f.telegram.updates[1]).received, 1);
});

test("connection.webhook.rotate validates its inputs", t => {
  const f = fixture(t); f.configure(); f.registerWebhook(OLD_SECRET);
  const base = { action: "connection.webhook.rotate", connectionId: f.telegram.connection.id, expectedRevision: 1 };
  const rotate = overrides => f.apply({ ...base, requestId: randomUUID(), ...overrides });
  assert.throws(() => rotate({ secretHash: oldHash, previousSecretHash: oldHash, rotationExpiresAt: Date.now() + 3600_000 }), { code: "invalid_email_import" }, "same digest twice");
  assert.throws(() => rotate({ secretHash: "short", previousSecretHash: oldHash, rotationExpiresAt: Date.now() + 3600_000 }), { code: "invalid_email_import" }, "malformed digest");
  assert.throws(() => rotate({ secretHash: newHash, previousSecretHash: oldHash, rotationExpiresAt: Date.now() - 1000 }), { code: "invalid_email_import" }, "window in the past");
  assert.throws(() => rotate({ secretHash: newHash, previousSecretHash: oldHash, rotationExpiresAt: Date.now() + 8 * 24 * 3600_000 }), { code: "invalid_email_import" }, "window beyond the max");
  assert.throws(() => f.apply({ action: "connection.webhook.rotate", requestId: randomUUID(), connectionId: "no-such-connection",
    expectedRevision: 0, secretHash: newHash, previousSecretHash: oldHash, rotationExpiresAt: Date.now() + 3600_000 }), { code: "channel_connection_not_found" });
  assert.throws(() => f.apply({ action: "connection.webhook.complete", requestId: randomUUID(), connectionId: f.telegram.connection.id, expectedRevision: 1 }),
    { code: "webhook_rotation_not_pending" }, "completing with nothing pending");
});

test("the connection card surfaces rotation state: pending, window expiry, complete", t => {
  const f = fixture(t); f.configure();
  const record = { accountId: f.auth.account.id, id: f.telegram.connection.id, channel: "telegram" };
  const config = telegramConfig({});
  const at = 1_700_000_000_000;
  const plain = telegramLiveView({ config, connection: { webhook: { secretHash: oldHash, updatedAt: at } }, record, now: at });
  assert.deepEqual(plain.rotation, { contractVersion: 1, state: "none", windowExpiresAt: null });
  const rotation = startWebhookRotation({ webhook: { secretHash: oldHash }, newSecretHash: newHash, windowMs: 3600_000, at });
  const pending = telegramLiveView({ config, connection: { webhook: rotation }, record, now: at });
  assert.deepEqual(pending.rotation, { contractVersion: 1, state: "pending", windowExpiresAt: new Date(at + 3600_000).toISOString() });
  const expired = telegramLiveView({ config, connection: { webhook: rotation }, record, now: at + 3600_000 });
  assert.deepEqual(expired.rotation, { contractVersion: 1, state: "complete", windowExpiresAt: null });
  const done = telegramLiveView({ config, connection: { webhook: completeWebhookRotation(rotation, at + 500) }, record, now: at + 500 });
  assert.deepEqual(done.rotation, { contractVersion: 1, state: "complete", windowExpiresAt: null });
});

test("the rotate script prints one fresh secret and the runbook, never twice the same", () => {
  const first = { text: "" }, second = { text: "" };
  const sink = out => ({ write(chunk) { out.text += chunk; return true; } });
  assert.equal(runRotateWebhook(["--generate"], { stdout: sink(first), stderr: sink(second) }), 0);
  assert.equal(second.text, "");
  const secret = /^New TELEGRAM_WEBHOOK_SECRET \(store it now; it is shown only here\):\n([A-Za-z0-9_-]{43})\n\n/.exec(first.text)?.[1];
  assert.ok(secret, "the secret is printed once");
  assert.equal(validateWebhookSecret(secret), true);
  assert.ok(first.text.includes("telegram-set-webhook.mjs"), "the runbook names the existing setWebhook path");
  assert.ok(first.text.includes("Reconnect"), "the runbook names the card trigger");
  const other = { text: "" };
  assert.equal(runRotateWebhook(["--generate"], { stdout: sink(other), stderr: sink(second) }), 0);
  assert.notEqual(/^New TELEGRAM_WEBHOOK_SECRET \(store it now; it is shown only here\):\n([A-Za-z0-9_-]{43})/.exec(other.text)[1], secret, "every run generates a fresh secret");
  assert.equal(runRotateWebhook([], { stdout: sink(first), stderr: sink(second) }), 2, "usage without --generate");
  assert.equal(runRotateWebhook(["--generate", "--window-hours", "0"], { stdout: sink(first), stderr: sink(second) }), 2, "window below the floor");
});

test("the Reconnect trigger starts a rotation when the binding changes instead of a hard swap", async t => {
  const f = fixture(t); f.configure(); f.registerWebhook(OLD_SECRET);
  // Obviously fake bindings: the shape Telegram uses, never a real token.
  const config = telegramConfig({ TELEGRAM_BOT_TOKEN: "7000000001:" + "A".repeat(35), TELEGRAM_WEBHOOK_SECRET: NEW_SECRET });
  assert.equal(config.state, "configured");
  const server = createRoomServer({ store: f.store, channelWebhooks: f.webhooks, telegram: config });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const headers = { Cookie: "account_session=" + f.auth.token, "X-Session-Binding": f.auth.sessionBinding,
    Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": f.auth.csrf };
  const reconnect = () => fetch(origin + "/api/inbox/connections/" + f.telegram.connection.id + "/reconnect",
    { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID() }) });
  const response = await reconnect();
  assert.ok(response.status === 200 || response.status === 201, "reconnect ok: " + response.status);
  assert.equal((await response.json()).registered, true);
  const stored = f.store.connections.connection(f.auth.account.id, f.telegram.connection.id).webhook;
  assert.equal(stored.rotationState, "pending", "a changed binding starts a rotation");
  assert.equal(stored.secretHash, newHash); assert.equal(stored.previousSecretHash, oldHash);
  assert.ok(stored.rotationExpiresAt > Date.now(), "the window lies in the future");
  assert.equal(f.deliver(OLD_SECRET, f.telegram.updates[0]).received, 1, "old secret still verifies mid-rotation");
  assert.equal(f.deliver(NEW_SECRET, f.telegram.updates[1]).received, 1, "binding secret verifies mid-rotation");
  const again = await reconnect();
  assert.ok(again.status === 200 || again.status === 201);
  assert.equal((await again.json()).registered, false, "a second Reconnect leaves the pending rotation alone");
  const card = await (await fetch(origin + "/api/inbox/connections/" + f.telegram.connection.id, { headers })).json();
  assert.equal(card.live.rotation.state, "pending");
  assert.ok(typeof card.live.rotation.windowExpiresAt === "string", "the card carries the window expiry");
});
