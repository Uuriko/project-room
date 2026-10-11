// Adjacent to grok-opportunities-title-surrogate-1010 (PR #2547): that fix
// drops a trailing high surrogate so a code-unit cut stays well-formed
// UTF-16. It does not keep the cut on a grapheme boundary. A title cut in
// the middle of a ZWJ emoji sequence leaves a dangling U+200D; a cut
// between the two regional indicators of a flag leaves a lone indicator
// that renders as a boxed letter. Both outputs are well-formed, so #2547
// does not cover them — this is a separate, grapheme-level contract on the
// public feed: a truncated title must not end mid-grapheme.
//
// Repro-only: server/opportunities.mjs is under the #2547 lane's active
// claim, so the repair (e.g. also dropping a dangling U+200D / lone
// regional indicator, or Intl.Segmenter truncation) is left to that lane.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { buildOpportunitiesFeed } from "../server/opportunities.mjs";

const ROOM = "commons";
const ZWJ = 0x200d;
const RI_LOW = 0x1f1e6;
const RI_HIGH = 0x1f1ff;

function listedStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "opp-text-edge-g2-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.roomDirectory.set(ROOM, "owner", true);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedBounty(store, { bountyId, title }) {
  const now = store.now();
  store.db.prepare(`INSERT INTO bounty_records
    (bounty_id, room_id, title, criteria, amount_millis, poster, state, state_changed_ms, deadline_ms, label, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    bountyId, ROOM, title, "criteria", 5000, "poster-member",
    "funded", now, now + 3600e3, "test",
    new Date(now).toISOString(), new Date(now).toISOString());
}

function feedTitle(store, bountyId) {
  const feed = buildOpportunitiesFeed(store, { now: store.now() });
  const opp = feed.opportunities.find(item => item.bountyId === bountyId);
  assert.ok(opp, "the funded bounty stays on the feed");
  return opp.title;
}

test("a truncated title does not end with a dangling ZWJ", t => {
  const store = listedStore(t);
  // 197 units + family emoji (8 units: man, ZWJ, woman, ZWJ, girl) = 205.
  // The 200-unit cut lands after man + ZWJ: well-formed, but the joiner
  // dangles — the title no longer ends on a grapheme boundary.
  const title = "a".repeat(197) + "👨‍👩‍👧";
  assert.equal(title.isWellFormed(), true);
  seedBounty(store, { bountyId: "b-zwj", title });
  const out = feedTitle(store, "b-zwj");
  assert.equal(out.isWellFormed(), true);
  const zwjCps = [...out].map(ch => ch.codePointAt(0));
  assert.notEqual(
    zwjCps[zwjCps.length - 1], ZWJ,
    `truncation split a ZWJ sequence; title ends with dangling U+200D: ${JSON.stringify(out.slice(-4))}`);
});

test("a truncated title does not end with a lone regional indicator", t => {
  const store = listedStore(t);
  // 198 units + US flag (4 units: two regional indicators) = 202.
  // The 200-unit cut keeps the first indicator alone: well-formed, but it
  // renders as a boxed letter instead of a flag.
  const title = "c".repeat(198) + "🇺🇸";
  assert.equal(title.isWellFormed(), true);
  seedBounty(store, { bountyId: "b-flag", title });
  const out = feedTitle(store, "b-flag");
  assert.equal(out.isWellFormed(), true);
  const riCps = [...out].map(ch => ch.codePointAt(0));
  const last = riCps[riCps.length - 1];
  const prev = riCps[riCps.length - 2];
  const loneRI = last >= RI_LOW && last <= RI_HIGH && !(prev >= RI_LOW && prev <= RI_HIGH);
  assert.equal(loneRI, false,
    `truncation split a regional-indicator pair; title ends with lone U+${last.toString(16).toUpperCase()}`);
});
