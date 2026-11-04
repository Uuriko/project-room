import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { normalizeItem, importClaimId, boardImportEnabled } from "../server/board-import.mjs";
import { postBoardImport, BOARD_IMPORT_ROUTES } from "../server/routes/board-import.mjs";
import { ROUTES } from "../server/routes/table.mjs";

const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-lead", type: "member.added", data: { memberId: "lead", displayName: "lead", kind: "agent", permissions: ["accept_work"] } });
  t.after(() => { store.close(); delete process.env.ROOM_BOARD_IMPORT; });
  const owner = store.roomAuthority("commons").ownerId;
  const post = async (memberId, body) => {
    const ctx = { params: { roomId: "commons" }, req: {}, res: {}, url: new URL("https://room.example/"), store,
      roomCredentials: () => ({ mode: "room", bearer: false }), expectedBinding: () => null, accountBinding: () => null,
      roomAuth: () => ({ member: { id: memberId }, credentialScope: "room", credentialHash: memberId }),
      protectWrite: () => {}, rate: () => {}, body: async () => body, json: (_r, status, value) => ({ status, value }), reject };
    try { return await postBoardImport(ctx); } catch (e) { if (!Number.isInteger(e.status)) throw e; return { status: e.status, code: e.code }; }
  };
  return { store, owner, post };
}

const gh = [
  { number: 12, title: "Fix login", body: "steps", html_url: "https://github.com/o/r/issues/12", state: "open", labels: [{ name: "bug" }, { name: "good first issue" }] },
  { number: 13, title: "Closed one", state: "closed" },
  { number: 14, title: "A PR", state: "open", pull_request: {} },
];

test("pure: normalizes GitHub, Jira and Asana items and skips done ones", () => {
  assert.equal(boardImportEnabled({}), false);
  assert.deepEqual(normalizeItem("github", gh[0]).labels, ["bug", "good first issue"]);
  assert.equal(normalizeItem("github", gh[1]).skip, "closed");
  assert.equal(normalizeItem("github", gh[2]).skip, "pull_request");
  assert.equal(normalizeItem("jira", { key: "AB-1", fields: { summary: "S", labels: ["x"] } }).key, "AB-1");
  assert.equal(normalizeItem("jira", { key: "AB-2", fields: { summary: "S", status: { statusCategory: { key: "done" } } } }).skip, "closed");
  assert.equal(normalizeItem("asana", { gid: "9", name: "T", completed: true }).skip, "closed");
  assert.equal(normalizeItem("asana", { gid: "9", name: "T", tags: [{ name: "q" }] }).title, "T");
  assert.equal(importClaimId("r", "github", "#1"), importClaimId("r", "github", "#1"));
  assert.notEqual(importClaimId("r", "github", "#1"), importClaimId("r2", "github", "#1"));
});

test("route is in the table and 404s with the flag off", async t => {
  assert.ok(ROUTES.includes(BOARD_IMPORT_ROUTES[0]));
  const f = fixture(t);
  assert.equal((await f.post(f.owner, { source: "github", items: gh })).status, 404);
});

test("flag on: owner imports, dry run writes nothing, re-import is a no-op", async t => {
  process.env.ROOM_BOARD_IMPORT = "1";
  const f = fixture(t);
  const before = f.store.workClaims.list("commons").length;
  const dry = await f.post(f.owner, { source: "github", items: gh, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.value.wouldCreate, 1);
  assert.equal(f.store.workClaims.list("commons").length, before);
  const out = await f.post(f.owner, { source: "github", items: gh });
  assert.equal(out.status, 201);
  assert.deepEqual([out.value.created, out.value.skipped], [1, 2]);
  const item = f.store.workClaims.get("commons", importClaimId("commons", "github", "#12"));
  assert.equal(item.title, "[#12] Fix login");
  assert.deepEqual([...item.tags], ["imported", "github", "bug", "good-first-issue"]);
  assert.equal(item.ownerId ?? null, null);
  const again = await f.post(f.owner, { source: "github", items: gh });
  assert.equal(again.status, 200);
  assert.equal(again.value.duplicates, 1);
  assert.equal(f.store.workClaims.list("commons").length, before + 1);
});

test("flag on: non-owner forbidden; bad source and oversize rejected", async t => {
  process.env.ROOM_BOARD_IMPORT = "1";
  const f = fixture(t);
  assert.deepEqual(await f.post("lead", { source: "github", items: gh }), { status: 403, code: "access_denied" });
  assert.equal((await f.post(f.owner, { source: "trello", items: gh })).code, "invalid_body");
  assert.equal((await f.post(f.owner, { source: "jira", items: [] })).code, "invalid_body");
  assert.equal((await f.post(f.owner, { source: "jira", items: Array.from({ length: 101 }, (_, i) => ({ key: `A-${i}`, fields: { summary: "s" } })) })).code, "invalid_body");
});
