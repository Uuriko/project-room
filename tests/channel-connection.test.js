import test from "node:test";
import assert from "node:assert/strict";
import { channelConnection, channelProfile, toChannelProfile, profileExternalId, profileChannel, channels } from "../server/channel-connection.mjs";
import { emailConnection, EmailContractError } from "../server/email-envelope.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { channelAdapters, adapterForProfile, readChannelEnvelope } from "../server/channel-adapters/index.mjs";

test("the generic connection record validates every field and rejects extra or unknown keys", () => {
  const profile = telegramContractFixture().connection, record = { ...profile, state: "active" };
  assert.deepEqual(channelConnection(record), record);
  assert.deepEqual(channelProfile(profile), profile);
  for (const change of [r => r.extra = true, r => delete r.capabilities, r => r.state = "paused", r => r.channel = "sms", r => r.provider = "microsoft-graph",
    r => r.revision = 0, r => r.accountId = "bad id", r => r.identity.kind = "human", r => r.identity.token = "secret", r => r.capabilities.send = "yes",
    r => r.capabilities.fetch = true, r => r.externalId = "", r => r.identity.id = "x\u0000"]) {
    const value = structuredClone(record); change(value);
    assert.throws(() => channelConnection(value), EmailContractError);
  }
  assert.throws(() => channelProfile(record), EmailContractError, "the profile has no state");
  assert.deepEqual(channels, ["email", "telegram", "whatsapp", "discord", "slack"]);
});
test("email connections stay Graph-shaped while mapping onto the generic record", () => {
  const raw = emailContractFixture().connection, clean = emailConnection(raw);
  assert.deepEqual(clean, raw);
  const generic = toChannelProfile(raw);
  assert.deepEqual(generic, { accountId: raw.accountId, id: raw.id, revision: 1, channel: "email", provider: "microsoft-graph", externalId: raw.mailboxId,
    identity: { kind: "mailbox", id: raw.identity.address, handle: raw.identity.address, displayName: raw.identity.name },
    capabilities: { read: true, send: false, threads: true, edit: false } });
  assert.equal(profileExternalId(raw), raw.mailboxId); assert.equal(profileChannel(raw), "email");
  assert.equal(profileExternalId(telegramContractFixture().connection), "7000000001");
  for (const change of [r => r.provider = "telegram-bot", r => r.channel = "email", r => r.accountId = "no spaces allowed", r => r.identity.address = "not-an-address"]) {
    const value = structuredClone(raw); change(value);
    assert.throws(() => emailConnection(value), EmailContractError);
  }
  assert.equal(adapterForProfile(raw).provider, "microsoft-graph");
  assert.equal(adapterForProfile(telegramContractFixture().connection).provider, "telegram-bot");
  assert.deepEqual([...channelAdapters.keys()], ["microsoft-graph", "telegram-bot", "gmail-api", "whatsapp-cloud", "discord-bot", "slack-app"]);
  for (const adapter of channelAdapters.values()) for (const key of ["channel", "provider", "readEnvelope", "sourceId", "scope", "bind"]) assert.ok(key in adapter, key);
  assert.throws(() => readChannelEnvelope({ channel: "sms" }), { code: "unsupported_channel" });
  assert.throws(() => readChannelEnvelope(null), { code: "unsupported_channel" });
});
