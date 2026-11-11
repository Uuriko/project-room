import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { linkWithProof } from "./helpers/link-with-proof.mjs";
import { RoomClient } from "../src/client.js";
import { createNeedsAttentionCard } from "../src/needs-attention.js";

function section() {
  const elements = new Map();
  const element = () => ({ hidden: false, disabled: false, innerHTML: "", textContent: "", dataset: {},
    classList: { toggle() {} }, addEventListener() {}, querySelectorAll: () => [], focus() {} });
  return { hidden: true, querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  } };
}
function dom(t) {
  const previous = globalThis.document;
  globalThis.document = { activeElement: null };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}
const member = (id, kind = "human", permissions = ["manage_members"]) => ({ id, kind, permissions, active: true });
const ownerItem = { kind: "decision", id: "private-owner-item", title: "OWNER_ONLY_CONTENT", severity: "action", detail: "Owner decision",
  actions: [{ method: "GET", path: "/record" }] };
const report = () => ({ items: [ownerItem], itemCount: 1, pageOffset: 0 });
const queue = () => ({ roomId: "commons", requests: [] });
function model(t, viewer, ownerId = "owner") {
  dom(t);
  let state = { room: { id: "commons", ownerId }, members: { [viewer.id]: viewer } };
  const calls = [], target = section();
  const client = { session: { roomId: "commons", member: viewer }, generation: 1, sequence: 1,
    path: path => "/api/rooms/commons" + path, ownsAccountSession: () => true,
    needsAttention: async () => { calls.push("rollup"); return report(); },
    request: async path => { calls.push(path); return queue(); },
    endAccess: () => { client.session = null; }, handleFailure: () => { client.session = null; } };
  const card = createNeedsAttentionCard({ client, section: target, getState: () => state });
  return { client, calls, target, card, state: () => state, replace: value => { state = value; } };
}

for (const [kind, isOwner] of [["agent", false], ["agent", true], ["human", false], ["human", true]]) {
  test(`${kind} ${isOwner ? "owner" : "administrator"} reads only the rollup their identity allows`, async t => {
    const viewer = member("viewer", kind), f = model(t, viewer, isOwner ? viewer.id : "owner");
    await f.card.refresh();
    assert.deepEqual(f.calls, kind === "human" && isOwner
      ? ["rollup", "/api/rooms/commons/access-requests?status=pending"]
      : ["/api/rooms/commons/access-requests?status=pending"]);
    assert.equal(f.client.session.member, viewer);
  });
}

test("losing human-owner eligibility clears cached rollup before the authorized queue settles", async t => {
  const f = model(t, member("owner"));
  await f.card.refresh();
  assert.match(f.target.querySelector("#attention-list").innerHTML, /OWNER_ONLY_CONTENT/);
  // Same scope/permissions, but updated identity kind: ownerId alone is not eligibility.
  f.state().members.owner = member("owner", "agent");
  let release;
  f.client.request = async path => { f.calls.push(path); return new Promise(resolve => { release = resolve; }); };
  f.calls.length = 0;
  const pending = f.card.refresh();
  assert.equal(f.target.hidden, true);
  assert.equal(f.target.querySelector("#attention-list").innerHTML, "");
  assert.deepEqual(f.calls, ["/api/rooms/commons/access-requests?status=pending"]);
  release(queue()); await pending;
  assert.doesNotMatch(f.target.querySelector("#attention-list").innerHTML, /OWNER_ONLY_CONTENT/);
});

test("revoked administration clears the card without any request or session bootstrap", async t => {
  const f = model(t, member("owner"));
  await f.card.refresh(); f.calls.length = 0;
  f.state().members.owner = member("owner", "human", []);
  f.card.sync(); await f.card.refresh();
  assert.equal(f.target.hidden, true);
  assert.equal(f.target.querySelector("#attention-list").innerHTML, "");
  assert.deepEqual(f.calls, []);
});

test("late previous-owner response cannot replace a switched agent queue", async t => {
  const f = model(t, member("owner"));
  let release, first = true;
  f.client.needsAttention = () => {
    if (!first) return Promise.resolve(report());
    first = false;
    return new Promise(resolve => { release = resolve; });
  };
  const old = f.card.refresh();
  const agent = member("agent", "agent");
  f.client.session = { roomId: "commons", member: agent }; f.client.generation++;
  f.replace({ room: { id: "commons", ownerId: "owner" }, members: { agent } });
  await f.card.refresh();
  release(report()); await old;
  assert.equal(f.target.hidden, true);
  assert.doesNotMatch(f.target.querySelector("#attention-list").innerHTML, /OWNER_ONLY_CONTENT/);
  assert.equal(f.client.session.member.id, "agent");
});

test("real agent browser session keeps owner-only 403 while the card reads its permitted queue only", async t => {
  dom(t);
  const store = new RoomStore(":memory:"); store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner"), agent = store.identities.create("Attention Agent");
  linkWithProof(store, owner, "commons", agent, { permissions: ["manage_members"] });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(origin + "/api/auth/agent/session", { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", Authorization: "Bearer " + agent.secret
  }, body: JSON.stringify({ identityId: agent.identityId, roomId: "commons" }) });
  assert.equal(login.status, 201);
  const session = await login.json(), cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const read = path => fetch(origin + path, { headers: { cookie, Origin: origin } });
  const refused = await read("/api/rooms/commons/needs-attention");
  assert.equal(refused.status, 403); assert.equal((await refused.json()).error.code, "owner_required");
  assert.equal((await read("/api/rooms/commons/access-requests?status=pending")).status, 200);
  assert.equal((await read("/api/session")).status, 200, "the rollup refusal does not end the agent session");
  const paths = [], client = new RoomClient({ fetcher: async (path, options) => {
    paths.push(path); return fetch(new URL(path, origin), { ...options, headers: { ...options?.headers, cookie, Origin: origin } });
  } });
  client.session = session;
  const target = section(), card = createNeedsAttentionCard({ client, section: target, getState: () => store.room("commons").state });
  await card.refresh();
  assert.deepEqual(paths, ["/api/rooms/commons/access-requests?status=pending"]);
  assert.equal(client.session, session);
  assert.equal(client.session.member.kind, "agent");
});

for (const native of [false, true]) test(`existing-agent sponsorship card preserves the typed approve and deny contract (${native ? 'native' : 'legacy'})`,async t=>{
 const f=model(t,member('owner'));
 // Legacy owner reports include the selected approval row; native reports
 // explicitly leave membership requests to the separate authorized queue.
 f.client.needsAttention=async()=>native ? {...report(),contractVersion:2} : {...report(),items:[{kind:'access_request',id:'adoption'}],itemCount:1};
 f.client.request=async()=>({roomId:'commons',requests:[{requestId:'adoption',kind:'agent-sponsor-transfer',displayName:'Existing Claude',note:'John requests sponsorship; identity and permissions stay unchanged',requestedPermissions:[]}]});
 await f.card.refresh();const html=f.target.querySelector('#attention-list').innerHTML;
 assert.match(html,/Connect Existing Claude to the requesting human/);assert.match(html,/Agent sponsorship/);assert.doesNotMatch(html,/asks to join|Choose permissions/);
});
