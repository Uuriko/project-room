import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validConnection, validConnectionCommand, validChannelSend, validConnectionRecord, validLive } from "../src/inbox-client.js";

// WhatsApp is exposed in the unified-inbox connection flow as an honest,
// non-live, pairing-required channel: the profile stores only the phone
// number's last-four fingerprint, the full number is never persisted or
// rendered, and no live/send/reconnect adapter exists for it.
const whatsappProfile = () => ({
  accountId: "owner", id: "whatsapp", revision: 1, channel: "whatsapp", provider: "whatsapp-cloud",
  externalId: "wa-1234",
  identity: { kind: "user", id: "wa:1234", handle: "…1234", displayName: "WhatsApp …1234" },
  capabilities: { read: true, send: false, threads: true, edit: false }
});
const record = () => ({ ...whatsappProfile(), state: "active" });
const viewer = { accountId: "owner" };

test("WhatsApp connection profiles validate as non-live records", () => {
  assert.equal(validConnection(record(), "owner"), true);
  // Only whatsapp-cloud is the pairing provider; a fabricated live status is rejected.
  assert.equal(validLive({ contractVersion: 1, channel: "whatsapp", state: "configured", bindings: [], missing: [], invalid: [], webhook: "unset", webhookSetAt: null, lastUpdateReceivedAt: null, receivedUpdates: 1, lastSendResult: null, importAvailable: false }), false);
  assert.equal(validLive(null), true);
});

test("WhatsApp connection records must carry no live state", () => {
  const connection = record();
  assert.equal(validConnectionRecord({ viewer, connection, mode: "fixture", webhook: false, webhookSetAt: null, syncAvailable: false, live: null }, "whatsapp"), true);
  const fabricated = { ...connection, state: "active" };
  assert.equal(validConnectionRecord({ viewer, connection: fabricated, mode: "fixture", webhook: false, webhookSetAt: null, syncAvailable: false, live: { contractVersion: 1, channel: "whatsapp" } }, "whatsapp"), false);
});

test("WhatsApp configure commands validate; sending stays unavailable", () => {
  const profile = whatsappProfile();
  assert.equal(validConnectionCommand({ action: "connection.configure", requestId: "r1", connectionId: "whatsapp", expectedRevision: 0, profile }), true);
  // No WhatsApp send provider exists: telegram-bot remains the only accepted one.
  assert.equal(validChannelSend({ provider: "whatsapp-cloud", mode: "fixture" }), false);
  assert.equal(validChannelSend({ provider: "telegram-bot", mode: "fixture" }), true);
  assert.equal(validChannelSend(null), true);
});

test("E.164 phone validation shape matches the pairing state machine", () => {
  // The form builder mirrors src/whatsapp-connect.mjs: E.164 only, last four kept.
  const e164 = /^\+[1-9]\d{7,14}$/;
  for (const ok of ["+15551234567", "+442071234567", "+911234567890"]) assert.equal(e164.test(ok), true);
  for (const bad of ["15551234567", "+015551234567", "+1", "abc", "+15551234567890123"]) assert.equal(e164.test(bad), false);
});

test("UI exposes WhatsApp as pairing-required, never live", () => {
  const ui = readFileSync(new URL("../src/inbox-ui.js", import.meta.url), "utf8");
  assert.match(ui, /whatsapp: "WhatsApp"/);
  assert.match(ui, /Pairing: required/);
  assert.match(ui, /Inbound: not yet routed/);
  assert.match(ui, /Sending: not available/);
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /<option value="whatsapp">WhatsApp \(pairing required\)<\/option>/);
  assert.match(page, /name="phone"/);
  assert.match(page, /Only the last four digits are kept; the full number is never stored or shown/);
});
