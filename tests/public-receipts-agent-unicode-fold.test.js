import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { queryPublicReceipts } from "../server/public-read-model.mjs";
import { queryPublicReceipts as queryLive } from "../server/receipts-live.mjs";

// Regression: the public receipts agent filter must keep non-ASCII
// case-folded matches. The documented semantics are "case-insensitive
// substring of an agent name" (docs/openapi.yaml, /api/public/receipts)
// and the needle is folded with JS `toLowerCase()` (full Unicode), but
// the filter decided in SQL with `instr(lower(agents_json), ?)` —
// SQLite `lower()` folds ASCII only, so receipts whose match depends on
// non-ASCII folding (Ä, İ, É, Σ, Œ, ...) silently dropped out of the
// public agent search, and could not anchor a cursor either.
const ROWS = [
  // [idSuffix, title, agents, at]
  ["a", "Apfel win", ["ÄPFEL"], "2026-10-05T00:00:00.000Z"],
  ["b", "Istanbul win", ["İstanbul"], "2026-10-04T00:00:00.000Z"],
  ["c", "Cafe upper win", ["CAFÉ"], "2026-10-03T00:00:00.000Z"],
  ["d", "Cafe society win", ["Café Society"], "2026-10-02T00:00:00.000Z"],
  ["e", "Sisyphus win", ["ΣΊΣΥΦΟΣ"], "2026-10-01T00:00:00.000Z"],
  ["f", "Oeuvre win", ["Œuvre"], "2026-09-30T00:00:00.000Z"],
  ["0", "Fox win", ["Plain FOX"], "2026-10-06T00:00:00.000Z"],
];

const EXPECTED = {
  "äpfel": ["Apfel win"],
  "ÄPFEL": ["Apfel win"],
  "i̇stanbul": ["Istanbul win"],
  "café": ["Cafe upper win", "Cafe society win"],
  "CAFÉ": ["Cafe upper win", "Cafe society win"],
  "σίσυφος": ["Sisyphus win"],
  "œuvre": ["Oeuvre win"],
  "fox": ["Fox win"],
  "zzz": [],
};

function serve(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "public-receipts-agent-fold-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  const ins = store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href, agent_ids_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = {};
  for (const [suffix, title, agents, at] of ROWS) {
    const id = `wcr_${suffix.repeat(32)}`;
    ids[title] = id;
    ins.run(id, title, "work-claim", "alpha", "alpha", "Alpha", JSON.stringify(agents), "[]",
      null, null, null, "[]", at, "https://room.trydemigod.com/?start=room", "[]");
  }
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ids };
}

const titles = page => (page.receipts ?? []).map(r => r.title);

test("public receipts agent search keeps non-ASCII case-folded matches", t => {
  const { store } = serve(t);
  for (const query of [queryPublicReceipts, queryLive]) {
    for (const [needle, expected] of Object.entries(EXPECTED)) {
      const page = query(store, { agent: needle, limit: 20 });
      assert.equal(page.error, undefined, needle);
      assert.deepEqual(titles(page), expected, `${query.name}: ${needle}`);
    }
  }
});

test("non-ASCII rows are candidates, not matches: a non-matching needle serves nothing extra", t => {
  const { store } = serve(t);
  // Every non-ASCII row passes the widened SQL superset for any needle;
  // the exact JS fold must decide, so an unrelated needle stays empty
  // and an ASCII needle does not collect non-ASCII decoys.
  assert.deepEqual(titles(queryPublicReceipts(store, { agent: "quux", limit: 20 })), []);
  assert.deepEqual(titles(queryPublicReceipts(store, { agent: "fox", limit: 20 })), ["Fox win"]);
});

test("agent-filtered pagination walks folded matches in order, with no short pages", t => {
  const { store } = serve(t);
  // Newer non-ASCII decoys (Œuvre, ΣΊΣΥΦΟΣ, İstanbul, ÄPFEL rows) are
  // superset candidates for "café" but not matches; they must not eat
  // the page budget or be served as nextCursor.
  const seen = [];
  let cursor = null;
  for (let hops = 0; hops < 5; hops += 1) {
    const page = queryPublicReceipts(store, { agent: "café", cursor, limit: 1 });
    assert.equal(page.error, undefined);
    seen.push(...titles(page));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, ["Cafe upper win", "Cafe society win"]);
});

test("the candidate scan advances past a full batch of folded non-matches", t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "public-receipts-agent-fold-many-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ins = store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href, agent_ids_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const base = Date.parse("2026-10-06T00:00:00.000Z");
  // 120 newer non-ASCII decoys: superset candidates for any needle,
  // JS non-matches for "café" — more than one scan batch of them.
  for (let i = 0; i < 120; i += 1) {
    ins.run(`wcr_${i.toString(16).padStart(32, "0")}`, `Decoy ${i}`, "work-claim", "alpha", "alpha", "Alpha",
      JSON.stringify(["Œuvre"]), "[]", null, null, null, "[]",
      new Date(base - i * 60_000).toISOString(), "https://room.trydemigod.com/?start=room", "[]");
  }
  ins.run(`wcr_${"f".repeat(32)}`, "Cafe buried win", "work-claim", "alpha", "alpha", "Alpha",
    JSON.stringify(["CAFÉ"]), "[]", null, null, null, "[]",
    "2026-10-01T00:00:00.000Z", "https://room.trydemigod.com/?start=room", "[]");
  const page = queryPublicReceipts(store, { agent: "café", limit: 20 });
  assert.equal(page.error, undefined);
  assert.deepEqual(titles(page), ["Cafe buried win"]);
  assert.equal(page.nextCursor, null);
});

test("a folded match anchors a cursor; a folded non-match is refused like a ghost", t => {
  const { store, ids } = serve(t);
  const anchored = queryPublicReceipts(store, { agent: "café", cursor: ids["Cafe upper win"], limit: 10 });
  assert.equal(anchored.error, undefined);
  assert.deepEqual(titles(anchored), ["Cafe society win"]);
  // Œuvre is a superset candidate for "café" but not a JS match, so it
  // is not a receipt this list could serve: same 422 as a ghost id.
  const viaDecoy = queryPublicReceipts(store, { agent: "café", cursor: ids["Oeuvre win"], limit: 10 });
  assert.equal(viaDecoy.error?.status, 422);
  assert.equal(viaDecoy.error?.code, "invalid_receipt_query");
  const viaGhost = queryPublicReceipts(store, { agent: "café", cursor: `wcr_${"9".repeat(32)}`, limit: 10 });
  assert.deepEqual(viaDecoy, viaGhost);
});
