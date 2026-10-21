// QA-SEARCH-1: the public receipts list accepted ?q= and silently ignored
// it — a nonsense term returned the identical unfiltered page, so "no
// matches" was indistinguishable from "search does not exist here". q now
// filters over the receipt title and its room title, case-insensitively,
// composes with the room/agent filters and the cursor, and a present but
// unusable q is refused with the surface's invalid_receipt_query 422.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { queryPublicReceipts } from "../server/receipts-live.mjs";
import { renderReceiptsHtml, receiptsListJson } from "../server/receipts-page.mjs";

function serve(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "receipts-q-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  const key = store.issueAccessKey("alpha", "owner");
  store.command(key, "alpha", { id: "opt-in", type: "room.public_receipts_set", data: { enabled: true } });
  const claim = (id, title, at) => ({
    id, title, state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", at }],
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/1", outcome: "merged", syncedAt: at },
    blobs: [], updatedAt: at,
  });
  store.workClaims.set("alpha", claim("haiku-old", "Haiku garden", "2026-10-01T00:00:00.000Z"));
  store.workClaims.set("alpha", claim("deploy", "Deploy notes", "2026-10-02T00:00:00.000Z"));
  store.workClaims.set("alpha", claim("haiku-new", "HAIKU review", "2026-10-03T00:00:00.000Z"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store };
}

const titles = page => page.receipts.map(r => r.title);

test("q filters receipts by title, case-insensitively", t => {
  const { store } = serve(t);
  assert.deepEqual(titles(queryPublicReceipts(store, { q: "haiku" })), ["HAIKU review", "Haiku garden"]);
  assert.deepEqual(titles(queryPublicReceipts(store, { q: "DEPLOY" })), ["Deploy notes"]);
  // The applied term rides the result for the HTML page.
  assert.equal(queryPublicReceipts(store, { q: " Haiku " }).q, "haiku");
});

test("a nonsense q returns an honestly empty page, not the unfiltered list", t => {
  const { store } = serve(t);
  const page = queryPublicReceipts(store, { q: "zzzznotpresent" });
  assert.deepEqual(page.receipts, []);
  assert.equal(page.nextCursor, null);
  const html = renderReceiptsHtml(page);
  assert.match(html, /No receipts match/);
  assert.match(html, /zzzznotpresent/);
  // The no-q page keeps its original empty-state wording path and content.
  assert.equal(queryPublicReceipts(store, {}).receipts.length, 3);
  assert.equal(queryPublicReceipts(store, {}).q, null);
});

test("q composes with limit and cursor over the filtered set", t => {
  const { store } = serve(t);
  const first = queryPublicReceipts(store, { q: "haiku", limit: 1 });
  assert.deepEqual(titles(first), ["HAIKU review"]);
  const second = queryPublicReceipts(store, { q: "haiku", limit: 1, cursor: first.nextCursor });
  assert.deepEqual(titles(second), ["Haiku garden"]);
  assert.equal(second.nextCursor, null);
  // The HTML older-receipts link keeps the search term.
  const html = renderReceiptsHtml(first);
  assert.match(html, /\/receipts\?q=haiku&cursor=/);
  // The JSON list shape is unchanged (no q key leaks into it).
  assert.deepEqual(Object.keys(receiptsListJson(first)).sort(), ["nextCursor", "receipts", "schema"]);
});

test("a present but unusable q is refused, naming the parameter", t => {
  const { store } = serve(t);
  for (const q of ["", "   ", "x".repeat(81), 42]) {
    const page = queryPublicReceipts(store, { q });
    assert.equal(page.error?.status, 422, `q=${JSON.stringify(q)}`);
    assert.equal(page.error?.code, "invalid_receipt_query");
    assert.match(page.error?.message, /q filter/);
  }
});
