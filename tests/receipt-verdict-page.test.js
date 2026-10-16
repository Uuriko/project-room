// The verdict block on the public receipt page (charter Workstream B,
// P1/P2; server/receipts-page.mjs + server/receipt-verify.mjs through
// server/http.mjs). Behavior protected:
//   - the plain page shows a displayed "Not yet verified" state with the
//     verify action — unverified is a state, never a blank, and the word
//     "verified" appears nowhere on it as a claim;
//   - ?verify=1 renders ONE graded verdict with its scope in the same
//     first-screen block — checked / not checked / by whom / when — and
//     the stored-values honesty note is replaced, not contradicted;
//   - a source that changed since the record (GitHub: pull still open)
//     renders the contradicted verdict on the page itself;
//   - the JSON shape carries the verification only when one ran;
//   - verify runs are rate-limited (they can cost a GitHub call).
// Seams: real RoomStore + read model + HTTP; GitHub is the injected
// fetchPullRequest stub — the seam claim-pr-sync uses.
// Run: node --test tests/receipt-verdict-page.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const PR_URL = "https://github.com/Uuriko/project-room/pull/2099";
const github = body => async () => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
const mergedFetch = github({ state: "closed", merged: true,
  merged_at: "2026-10-01T00:00:00.000Z", merge_commit_sha: "a".repeat(40) });
const openFetch = github({ state: "open", merged: false });

async function serve(t, fetchPullRequest) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "receipt-verdict-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  const key = store.issueAccessKey("alpha", "owner");
  store.workClaims.set("alpha", { id: "alpha-claim", title: "Done work in alpha", state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: PR_URL, outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: ["sha256:" + "ab".repeat(32)], updatedAt: "2026-10-01T00:00:00.000Z" });
  store.command(key, "alpha", { id: "publish-alpha", type: "room.public_receipts_set", data: { enabled: true } });
  const server = createRoomServer({ store, fetchPullRequest, githubToken: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const receiptId = store.db.prepare("SELECT id FROM public_receipts WHERE origin_room_id='alpha'").get().id;
  return { origin: `http://127.0.0.1:${server.address().port}`, receiptId };
}

test("the plain page shows Not yet verified with the action, and claims nothing", async t => {
  const { origin, receiptId } = await serve(t, mergedFetch);
  const html = await (await fetch(`${origin}/receipts/${receiptId}`)).text();
  assert.match(html, /Not yet verified/);
  assert.match(html, /href="\?verify=1"/);
  assert.doesNotMatch(html, /data-verdict=/, "no verdict is rendered before one runs");
  assert.match(html, /Hashes are stored values, not re-verified/,
    "the stored-values note stays while nothing was re-checked");
  const json = await (await fetch(`${origin}/receipts/${receiptId}.json`)).json();
  assert.equal(json.verification, undefined, "JSON carries verification only when one ran");
});

test("?verify=1 renders the graded verdict with its scope in one block", async t => {
  const { origin, receiptId } = await serve(t, mergedFetch);
  const html = await (await fetch(`${origin}/receipts/${receiptId}?verify=1`)).text();
  assert.match(html, /data-verdict="server-verified"/);
  assert.match(html, /<strong>Server-verified<\/strong>/);
  assert.match(html, /Pull request on GitHub<\/strong> — matches: GitHub reports pull request #2099 merged/);
  assert.match(html, /What was not checked/);
  assert.match(html, /Whether the work itself is any good/);
  assert.match(html, /Checked <time datetime=/, "the verdict is stamped with the check time");
  assert.doesNotMatch(html, /Hashes are stored values, not re-verified/,
    "the unverified note is replaced once a verification ran");
});

test("?verify=1 puts the same verdict on the JSON shape", async t => {
  const { origin, receiptId } = await serve(t, mergedFetch);
  const json = await (await fetch(`${origin}/receipts/${receiptId}.json?verify=1`)).json();
  assert.equal(json.verification.schema, "project-room-receipt-verification/1");
  assert.equal(json.verification.verdict, "server-verified");
  assert.equal(json.verification.scope.by, "the Project Room server, at read time");
});

test("a changed source renders the contradicted verdict on the page", async t => {
  const { origin, receiptId } = await serve(t, openFetch);
  const html = await (await fetch(`${origin}/receipts/${receiptId}?verify=1`)).text();
  assert.match(html, /data-verdict="contradicted"/);
  assert.match(html, /still open — not merged, as this record shows/);
});

test("verify runs are rate-limited per address", async t => {
  const { origin, receiptId } = await serve(t, mergedFetch);
  let last;
  for (let i = 0; i < 11; i++) last = await fetch(`${origin}/receipts/${receiptId}?verify=1`);
  assert.equal(last.status, 429, "the 11th verify in a minute is refused");
  const plain = await fetch(`${origin}/receipts/${receiptId}`);
  assert.equal(plain.status, 200, "the plain page is not limited by the verify bucket");
});
