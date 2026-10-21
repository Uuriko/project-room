import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function room(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = f.store.identities.create("helper");
  f.store.identities.link(f.keys.owner, "commons", { identityId: agent.identityId, memberId: "helper", displayName: "Helper", permissions: ["accept_work"] });
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  return { f, call, agent: agent.secret, owner: f.keys.owner };
}

// The tables come from the approvals, drafts-by-default and group-review
// routes; this test creates the columns the projection reads so it stands alone.
function seed(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS approval_cards (id TEXT PRIMARY KEY, room_id TEXT, requested_by TEXT, summary TEXT, state TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS outbound_drafts (id TEXT PRIMARY KEY, room_id TEXT, author_id TEXT, channel TEXT, recipient TEXT, state TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS group_reviews (id TEXT PRIMARY KEY, room_id TEXT, author_id TEXT, draft TEXT, reviewers TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS group_review_answers (review_id TEXT, member_id TEXT, PRIMARY KEY(review_id, member_id));`);
  const now = Date.now();
  db.prepare("INSERT INTO approval_cards VALUES ('apv_1','commons','helper','Book the offsite room','pending',?)").run(now);
  db.prepare("INSERT INTO approval_cards VALUES ('apv_2','commons','helper','Old one','done',?)").run(now);
  db.prepare("INSERT INTO outbound_drafts VALUES ('drf_1','commons','helper','email','customer@example.com','draft',?)").run(now);
  db.prepare("INSERT INTO group_reviews VALUES ('rev_1','commons','other','Ship Friday?','[\"helper\"]',?)").run(now);
}
const kinds = body => body.items.map(i => i.kind).sort();

test("one needs-you list: the owner sees approvals and drafts, a reviewer sees its open reviews", async t => {
  const { f, call, agent, owner } = await room(t);
  const empty = await call(owner, "GET", "/updates?kinds=approval,outbound_draft,group_review");
  assert.equal(empty.status, 200, "no feature tables yet contributes nothing");
  assert.deepEqual(empty.body.items, []);
  seed(f.store.db);
  const mine = (await call(owner, "GET", "/updates?kinds=approval,outbound_draft,group_review")).body;
  assert.deepEqual(kinds(mine), ["approval", "outbound_draft"]);
  assert.equal(mine.items.find(i => i.kind === "approval").title, "Book the offsite room");
  assert.match(mine.items.find(i => i.kind === "approval").next.path, /\/approvals\/apv_1\/decision$/);
  const helper = (await call(agent, "GET", "/updates?kinds=approval,outbound_draft,group_review")).body;
  assert.deepEqual(kinds(helper), ["group_review"], "a non-owner never sees the owner's approvals");
  f.store.db.prepare("INSERT INTO group_review_answers VALUES ('rev_1','helper')").run();
  assert.deepEqual((await call(agent, "GET", "/updates?kinds=group_review")).body.items, []);
});
