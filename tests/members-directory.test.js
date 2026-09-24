// RC-2026-09-24-202: members directory + evidence-backed skill cards.
// Instinct spec RC-2026-09-24-005: room members list with identity,
// presence and skill ids; per-identity skill publish (A2A skill shape +
// receipt-hash evidence); public opt-in skill card; /skills catalog gains
// an opted-in `members` array.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, payload, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(payload),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const errorCode = async res => (await res.json()).error?.code;

const SKILL = id => ({ id, name: `Skill ${id}`, description: `Does ${id}.`, tags: ["fixtures"], evidence: ["sha256:".padEnd(71, "ab")] });

function setup() {
  const f = createAcceptanceFixture();
  const identity = f.store.identities.create("skills-agent");
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  f.store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, displayName: "Skills Agent", permissions: ["accept_work"], memberId: "skills-agent",
  });
  const roomKey = f.store.issueAccessKey("commons", "skills-agent");
  return { f, identity, roomKey };
}

async function issueScopedKey(origin, secret, scopes) {
  const issued = await post(origin, "/api/agent-keys", { scopes, label: "skills test key" }, secret);
  assert.equal(issued.status, 201);
  return (await issued.json()).credential; // the presentation-ready Authorization-header value (rak_…)
}

test("skill publish validates shape: 422 on bad payloads", async t => {
  const { f, identity } = setup();
  const origin = await startServer(t, f);
  const key = await issueScopedKey(origin, identity.secret, ["skills:publish"]);
  for (const [label, payload] of [
    ["missing publish", { skills: [] }],
    ["publish not boolean", { publish: "yes", skills: [] }],
    ["skills not array", { publish: false }],
    ["too many skills", { publish: false, skills: Array.from({ length: 51 }, (_, i) => SKILL(`s${i}`)) }],
    ["bad skill id", { publish: false, skills: [SKILL("no spaces")] }],
    ["duplicate skill id", { publish: false, skills: [SKILL("dup"), SKILL("dup")] }],
    ["bad evidence", { publish: false, skills: [{ ...SKILL("e"), evidence: ["not-a-hash"] }] }],
    ["unknown field", { publish: false, skills: [{ ...SKILL("u"), bogus: 1 }] }],
    ["extra body field", { publish: false, skills: [], bogus: 1 }],
  ]) {
    const res = await post(origin, "/api/agent-skills", payload, key);
    assert.equal(res.status, 422, `${label}: expected 422, got ${res.status}`);
    assert.equal(await errorCode(res), "invalid_skills", label);
  }
});

test("publish requires the skills:publish scope", async t => {
  const { f, identity } = setup();
  const origin = await startServer(t, f);
  const key = await issueScopedKey(origin, identity.secret, ["rooms:read"]);
  const res = await post(origin, "/api/agent-skills", { publish: false, skills: [] }, key);
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "insufficient_scope");
});

test("publish stores the set, labels unevidenced skills self-declared, replace works", async t => {
  const { f, identity } = setup();
  const origin = await startServer(t, f);
  const key = await issueScopedKey(origin, identity.secret, ["skills:publish"]);

  const res = await post(origin, "/api/agent-skills", {
    publish: true,
    skills: [SKILL("attested"), { id: "declared", name: "Declared", description: "No evidence yet." }],
  }, key);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.skills, 2);
  assert.equal(out.publish, true);
  assert.deepEqual(out.selfDeclared, ["declared"]);

  // Public card is A2A-shaped and carries the declaration labels.
  const cardRes = await get(origin, `/api/agents/${identity.identityId}/card`);
  assert.equal(cardRes.status, 200);
  const card = await cardRes.json();
  assert.ok(Array.isArray(card.skills));
  assert.deepEqual(card.skills.map(s => [s.id, s.declaration]).sort(),
    [["attested", "attested"], ["declared", "self-declared"]]);

  // Replace: the second publish is the whole new set.
  const res2 = await post(origin, "/api/agent-skills", { publish: true, skills: [SKILL("only")] }, key);
  assert.equal((await res2.json()).skills, 1);
  const card2 = await (await get(origin, `/api/agents/${identity.identityId}/card`)).json();
  assert.deepEqual(card2.skills.map(s => s.id), ["only"]);
});

test("public card is 404 unless publish:true; the key manifest advertises the action", async t => {
  const { f, identity } = setup();
  const origin = await startServer(t, f);
  const key = await issueScopedKey(origin, identity.secret, ["skills:publish"]);

  const before = await get(origin, `/api/agents/${identity.identityId}/card`);
  assert.equal(before.status, 404);
  assert.equal(await errorCode(before), "unknown_skill_card");

  await post(origin, "/api/agent-skills", { publish: false, skills: [SKILL("quiet")] }, key);
  const after = await get(origin, `/api/agents/${identity.identityId}/card`);
  assert.equal(after.status, 404); // publish:false stays private

  const manifest = await (await get(origin, "/api/agent-manifest")).json();
  const vocab = manifest.auth?.apiKeyScopes?.scopes ?? [];
  assert.ok(vocab.some(s => s.scope === "skills:publish"
    && s.routes?.some(r => r.includes("POST /api/agent-skills"))), JSON.stringify(vocab.map(s => s.scope)));
});

test("members directory lists identity, presence and skill ids; unauthenticated is refused", async t => {
  const { f, identity, roomKey } = setup();
  const origin = await startServer(t, f);
  const key = await issueScopedKey(origin, identity.secret, ["skills:publish"]);
  await post(origin, "/api/agent-skills", { publish: true, skills: [SKILL("directory-skill")] }, key);

  const anon = await get(origin, "/api/rooms/commons/members");
  assert.ok([401, 403].includes(anon.status), `expected 401/403, got ${anon.status}`);

  const res = await get(origin, "/api/rooms/commons/members", roomKey);
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.roomId, "commons");
  const me = doc.members.find(m => m.memberId === "skills-agent");
  assert.ok(me, JSON.stringify(doc.members.map(m => m.memberId)));
  assert.equal(me.identityId, identity.identityId);
  assert.equal(me.displayName, "Skills Agent");
  assert.ok(typeof me.joinedAt === "number");
  assert.ok(["online", "stale"].includes(me.presence));
  assert.deepEqual(me.skillIds, ["directory-skill"]);

  // Members without published skills list an empty skillIds array.
  const owner = doc.members.find(m => m.memberId === "owner");
  assert.ok(owner);
  assert.deepEqual(owner.skillIds, []);
});

test("/skills catalog gains an opted-in members array", async t => {
  const { f, identity } = setup();
  const origin = await startServer(t, f);
  const key = await issueScopedKey(origin, identity.secret, ["skills:publish"]);
  await post(origin, "/api/agent-skills", { publish: true, skills: [SKILL("catalog-skill")] }, key);

  const res = await get(origin, "/skills");
  assert.equal(res.status, 200);
  const catalog = await res.json();
  assert.ok(Array.isArray(catalog.skills), "base catalog intact");
  assert.ok(Array.isArray(catalog.members));
  const entry = catalog.members.find(m => m.identityId === identity.identityId);
  assert.ok(entry, JSON.stringify(catalog.members));
  assert.equal(entry.card, `/api/agents/${identity.identityId}/card`);
  assert.deepEqual(entry.skills, ["catalog-skill"]);

  // Opt out: publish:false removes the card from the catalog.
  await post(origin, "/api/agent-skills", { publish: false, skills: [SKILL("catalog-skill")] }, key);
  const res2 = await (await get(origin, "/skills")).json();
  assert.ok(!res2.members.some(m => m.identityId === identity.identityId));
});
