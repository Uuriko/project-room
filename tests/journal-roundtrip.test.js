// The stored rows and graph-reply JSON in tests/fixtures/journal-records.json
// were produced by the per-kind journal modules. server/journal.mjs has to
// write those same bytes and read them back. Regenerating the fixture from
// the shared module would not satisfy the legacy assertion below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as legacyChannel from "../server/channel-journal.mjs";
import * as legacySpam from "../server/spam-quarantine-journal.mjs";
import * as legacyJev from "../server/jev-shadow-journal.mjs";
import * as legacySla from "../server/sla-breach-journal.mjs";
import * as legacyMembership from "../server/membership-delegation-journal.mjs";
import * as legacyInvitation from "../server/invitation-journal.mjs";
import * as legacyGraph from "../server/graph-reply-journal.mjs";
import { openJournal } from "../server/journal.mjs";
import * as shared from "../server/journal.mjs";
import { replayJournals, readCapturedJournal } from "./journal-record-replay.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/journal-records.json", import.meta.url), "utf8"));
const legacy = { ...legacyChannel, ...legacySpam, ...legacyJev, ...legacySla, ...legacyMembership, ...legacyInvitation, ...legacyGraph };
const sharedApi = {
  ...shared,
  ChannelUpdateJournal: class { constructor(store) { return openJournal(store, "channel"); } },
  SpamQuarantineJournal: class { constructor(store) { return openJournal(store, "spamQuarantine"); } },
  JevShadowJournal: class { constructor(store) { return openJournal(store, "jevShadow"); } },
  SlaBreachAlertJournal: class { constructor(store) { return openJournal(store, "slaBreach"); } },
  MembershipDelegationJournal: class { constructor(store) { return openJournal(store, "membershipDelegation"); } }
};

test("shared journal writes the bytes captured from the per-kind modules", () => {
  assert.deepEqual(replayJournals(sharedApi), fixture.replay);
});

test("shared journal reads captured rows back into the same records", () => {
  assert.deepEqual(readCapturedJournal(sharedApi, fixture.replay), fixture.reads);
});

test("per-kind modules still produce the captured records", () => {
  assert.deepEqual(replayJournals(legacy), fixture.replay);
  assert.deepEqual(readCapturedJournal(legacy, fixture.replay), fixture.reads);
});

test("shared journal does not import store.mjs", () => {
  const source = readFileSync(new URL("../server/journal.mjs", import.meta.url), "utf8");
  assert.equal(source.includes('from "./store.mjs"'), false);
});
