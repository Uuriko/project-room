// WAVE-500 guild-2 support for grok-room-page-receipt-fill-1010.
//
// Adjacent surface the lane's PRs (#2481, #2543) did not cover: the agent
// directory card prints "N public receipts", but the stored receipt_count
// (directoryCounts in server/public-read-model.mjs) counts EVERY
// public_receipts row naming the agent — including receipts whose owner
// turned public receipts off. The receipts feed, detail read, sitemap, and
// collect views all exclude those rows, so the card's count disagrees with
// what a visitor can actually see. The fix belongs to the lane's claimed
// files, so this test only pins the expected behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { syncDirectoryCard } from "../server/public-read-model.mjs";
import { agentDirectoryView } from "../server/public-rooms.mjs";
import { collectPublicReceipts } from "../server/receipts-live.mjs";

const AGENT = "agent-g2-edge";
const hex = n => n.toString(16).padStart(32, "0");
const rid = n => `wcr_${hex(n)}`;

function seed(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "g2-dir-count-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  for (const roomId of ["alpha", "beta"]) store.initialize(initialRoom(roomId));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  // beta's owner hides the room's receipts from every public surface.
  store.roomDirectory.setReceiptsVisibility("beta", "owner", false);

  const insert = store.db.prepare(`INSERT INTO public_receipts
      (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
       pull_request, merged_at, hashes_json, at, start_href)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const agents = JSON.stringify([AGENT]);
  // Two receipts the agent earned in beta — hidden by the owner toggle.
  insert.run(rid(1), "Hidden beta fix 1", "work-claim", "beta", "beta", "Beta",
    agents, "[]", null, null, "[]", "2026-10-11T00:02:00.000Z", "https://room.trydemigod.com/?start=room");
  insert.run(rid(2), "Hidden beta fix 2", "work-claim", "beta", "beta", "Beta",
    agents, "[]", null, null, "[]", "2026-10-11T00:01:00.000Z", "https://room.trydemigod.com/?start=room");
  // One receipt in alpha — genuinely public.
  insert.run(rid(3), "Visible alpha fix", "work-claim", "alpha", "alpha", "Alpha",
    agents, "[]", null, null, "[]", "2026-10-10T00:00:00.000Z", "https://room.trydemigod.com/?start=room");

  const now = Date.now();
  store.db.prepare(`INSERT INTO agent_directory_cards
      (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn)
      VALUES (?,?,?,?,?,?,0)`).run(AGENT,
    JSON.stringify({ name: "Edge Agent", description: "g2 edge case", skills: [] }),
    "public", "owner-identity", now, now);
  syncDirectoryCard(store, AGENT);
  return store;
}

test("the directory card's public-receipt count excludes owner-hidden receipts", t => {
  const store = seed(t);
  const visible = collectPublicReceipts(store).filter(receipt => receipt.agents.includes(AGENT));
  assert.equal(visible.length, 1, "only the alpha receipt is publicly visible");
  const row = store.db.prepare(
    "SELECT receipt_count FROM public_directory_entries WHERE agent_id=?").get(AGENT);
  assert.ok(row, "the directory entry exists");
  assert.equal(row.receipt_count, visible.length,
    `card count ${row.receipt_count} must match the ${visible.length} publicly visible receipt(s)`);
});

test("the directory page copy agrees with the visible receipt list", t => {
  const store = seed(t);
  const view = agentDirectoryView(store, {});
  assert.match(view.html, /1 public receipt[^s]/,
    "the card must read '1 public receipt', not count the two owner-hidden rows");
  assert.equal(view.html.includes("Hidden beta fix 1"), false, "no hidden title leaks into the directory");
});
