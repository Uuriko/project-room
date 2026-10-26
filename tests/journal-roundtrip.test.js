// The stored rows and graph-reply JSON in tests/fixtures/journal-records.json
// were produced by the per-kind journal modules (deleted in the T0 cut:
// server/journal.mjs is the only journal implementation now). The shared
// module has to write those same bytes and read them back; the frozen fixture
// is the contract, and legs 1-2 below pin it without the legacy code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openJournal } from "../server/journal.mjs";
import * as shared from "../server/journal.mjs";
import { replayJournals, readCapturedJournal } from "./journal-record-replay.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/journal-records.json", import.meta.url), "utf8"));
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

test("shared journal does not import store.mjs", () => {
  const source = readFileSync(new URL("../server/journal.mjs", import.meta.url), "utf8");
  assert.equal(source.includes('from "./store.mjs"'), false);
});
