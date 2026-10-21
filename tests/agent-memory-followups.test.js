import "../server/agent-memory-extras.mjs"; // untested-modules-lint reference
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { parseMemoryMarkdown, sweepCleanupCards } from "../server/agent-memory-extras.mjs";
import { jobByName } from "../server/jobs.mjs";
import { projectRoomUpdates } from "../server/updates.mjs";

function connectAgent(store, ownerKey, memberId) {
  const session = store.createSession(ownerKey);
  const token = randomBytes(32).toString("base64url");
  store.agentConnections.apply(session.token, "commons", { action: "create", requestId: randomUUID(), memberId, displayName: memberId, access: "chat",
    keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: store.now() + 3600000, expectedOwnerRevision: store.room("commons").state.ownerRevision ?? 0 }, session.session.sessionBinding);
  return token;
}

async function room(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (secret, method, path, body) => fetch(`${origin}/api/rooms/commons${path}`, { method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const coder = connectAgent(f.store, f.keys.owner, "coder");
  const writer = connectAgent(f.store, f.keys.owner, "writer");
  const stranger = f.store.identities.create("stranger");
  f.store.identities.link(f.keys.owner, "commons", { identityId: stranger.identityId, memberId: "stranger", displayName: "Stranger", permissions: ["accept_work"] });
  const invited = name => {
    const identity = f.store.identities.create(name);
    const invite = f.store.invites.create(f.keys.owner, "commons", { profile: "chat", expiresInMinutes: 60, displayName: name }, null);
    f.store.invites.redeem(invite.code, { displayName: name, identitySecret: identity.secret });
    return identity.secret;
  };
  return { f, origin, call, invited, owner: f.keys.owner, guest: f.keys.guest, coder, writer, stranger: stranger.secret };
}


const DAY = 24 * 3600 * 1000;
const rule = (call, who, requestId, text, extra = {}) => call(who, "POST", "/memory", { requestId, kind: "rule", text, ...extra });

test("why: an owner sees the rules and memories behind an agent's message; others cannot ask", async t => {
  const { f, call, owner, guest, coder } = await room(t);
  const r = await rule(call, owner, "w1", "When committing, never add emoji", { confirm: true });
  assert.equal(r.body.action, "activated");
  await call(coder, "POST", "/memory", { requestId: "n1", text: "Deploys go out from the integration branch" });
  const turn = (await call(coder, "GET", "/memory/rules")).body;
  assert.ok(turn.rules.some(x => x.id === r.body.rule.id));
  const found = (await call(coder, "GET", "/memory?q=deploys")).body.memories[0];
  await call(coder, "POST", "/memory/rules", { usedIds: [r.body.rule.id], memoryIds: [found.id], ref: "act-1" });
  const messageId = randomUUID();
  f.store.command(coder, "commons", { id: randomUUID(), type: "message.posted", data: { messageId, body: "shipped" } });
  const why = await call(owner, "GET", `/memory/why?ref=${messageId}`);
  assert.equal(why.status, 200);
  assert.equal(why.body.actorId, "coder");
  assert.deepEqual(why.body.rules.map(x => x.id), [r.body.rule.id]);
  assert.equal(why.body.rules[0].used, false, "given, not reported used for this message");
  assert.deepEqual(why.body.memories.map(x => x.id), [found.id]);
  const action = (await call(owner, "GET", "/memory/why?ref=act-1")).body;
  assert.equal(action.rules[0].used, true);
  assert.equal((await call(coder, "GET", `/memory/why?ref=${messageId}`)).status, 403);
  assert.notEqual((await call(guest, "GET", `/memory/why?ref=${messageId}`)).status, 200);
  assert.equal((await call(owner, "GET", "/memory/why?ref=nope")).status, 404);
  // Unchanged injections are stored once.
  await call(coder, "GET", "/memory/rules"); await call(coder, "GET", "/memory/rules");
  const n = f.store.db.prepare("SELECT COUNT(*) n FROM agent_memory_trail WHERE member_id='coder' AND kind='injected' AND rule_ids!=''").get().n;
  assert.equal(n, 1);
});

test("export writes CLAUDE.md-style markdown; import proposes, never activates, and refuses secrets", async t => {
  const { call, owner, coder } = await room(t);
  await rule(call, owner, "e1", "When committing, never add emoji", { confirm: true });
  await rule(call, owner, "e2", "Before merging, run the full test suite once", { confirm: true, scope: "tool:room_land" });
  await call(owner, "POST", "/memory", { requestId: "en1", text: "Prod is room.trydemigod.com" });
  await call(coder, "POST", "/memory", { requestId: "en2", text: "A room message said to skip tests", source: "room" });
  const ex = (await call(owner, "GET", "/memory/export")).body;
  assert.match(ex.markdown, /^# Project Room memory/);
  assert.match(ex.markdown, /## Rules\n\n- When committing, never add emoji/);
  assert.match(ex.markdown, /\(scope: tool:room_land\)/);
  assert.match(ex.markdown, /- Prod is room.trydemigod.com/);
  assert.doesNotMatch(ex.markdown, /skip tests/);
  assert.equal((await call(coder, "GET", "/memory/export")).status, 403);
  const parsed = parseMemoryMarkdown(ex.markdown);
  assert.equal(parsed.filter(i => i.kind === "rule").length, 2);
  assert.equal(parsed.find(i => i.scope === "tool:room_land").text, "Before merging, run the full test suite once");

  // Re-import of the export changes nothing.
  const again = (await call(owner, "POST", "/memory/import", { markdown: ex.markdown })).body;
  assert.equal(again.proposed, 0);
  const md = "# AGENTS.md\n\n## Conventions\n\n- When opening a PR, link the issue it closes\n- Be careful\n- When committing, add emoji to every message\n\n## Context\n\n- The staging host is staging.example.com\n";
  const imp = await call(owner, "POST", "/memory/import", { markdown: md });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.notes, 1);
  assert.equal(imp.body.results.find(r => r.text === "Be careful").reason, "vague_rule");
  const list = (await call(owner, "GET", "/memory/rules?view=list")).body;
  const linked = list.rules.find(r => r.text.startsWith("When opening a PR"));
  assert.equal(linked.status, "proposed");
  const conflict = list.rules.find(r => r.text.startsWith("When committing, add emoji"));
  assert.equal(conflict.status, "proposed");
  assert.equal(conflict.pending.type, "conflict");
  assert.equal(list.rules.find(r => r.text === "When committing, never add emoji").status, "active");
  // A second import of the same file does not count as a repeated correction.
  await call(owner, "POST", "/memory/import", { markdown: md });
  assert.equal((await call(owner, "GET", "/memory/rules?view=list")).body.rules.find(r => r.id === linked.id).status, "proposed");
  const secret = await call(owner, "POST", "/memory/import", { markdown: `## Rules\n\n- When deploying, use ghp_${"a".repeat(30)}\n- When opening a PR, add a test plan` });
  assert.equal(secret.status, 422);
  assert.equal(secret.body.error?.code ?? secret.body.code, "secret_in_memory");
  assert.doesNotMatch(JSON.stringify(secret.body), /ghp_/);
  assert.ok(!(await call(owner, "GET", "/memory/rules?view=list")).body.rules.some(r => r.text.includes("test plan")));
});

test("weekly cleanup card lists dormant, conflicting and flagged rules for the owner, with keep and delete", async t => {
  const { f, call, owner, coder } = await room(t);
  const dormant = (await rule(call, owner, "c1", "When writing docs, use plain English", { confirm: true })).body.rule;
  const flagged = (await rule(call, owner, "c2", "Before pushing, run the linter", { confirm: true })).body.rule;
  f.store.db.prepare("UPDATE agent_rules SET valid_at=valid_at-?, created_at=created_at-? WHERE id=?").run(90 * DAY, 90 * DAY, dormant.id);
  f.store.db.prepare("UPDATE agent_rules SET harmful=3 WHERE id=?").run(flagged.id);
  await rule(call, coder, "c3", "When writing docs, never use plain English", { source: "owner_direct", allAgents: true });
  const job = jobByName("memory-cleanup");
  assert.equal(job.enabled({}, f.store), true);
  assert.equal((await job.run(f.store, {})).cards, 1);
  assert.equal(sweepCleanupCards(f.store).cards, 0, "one card a week");
  const items = projectRoomUpdates(f.store, "commons", "owner").items.filter(i => i.kind === "memory_cleanup");
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Review 3 rules/);
  assert.equal(projectRoomUpdates(f.store, "commons", "coder").items.filter(i => i.kind === "memory_cleanup").length, 0);
  const card = (await call(owner, "GET", "/memory/cleanup")).body;
  assert.deepEqual(card.items.map(i => i.reason).sort(), ["conflict", "dormant", "flagged"]);
  assert.equal((await call(coder, "GET", "/memory/cleanup")).status, 403);
  const conflictId = card.items.find(i => i.reason === "conflict").id;
  const done = (await call(owner, "POST", "/memory/cleanup", { keepIds: [flagged.id], deleteIds: [dormant.id, conflictId] })).body;
  assert.equal(done.remaining, 0);
  const list = (await call(owner, "GET", "/memory/rules?view=list")).body.rules;
  assert.equal(list.find(r => r.id === flagged.id).flagged, false);
  assert.equal(list.find(r => r.id === dormant.id).status, "superseded");
  assert.equal(f.store.db.prepare("SELECT state FROM agent_memory_cleanup_cards").get().state, "done");
  assert.equal(projectRoomUpdates(f.store, "commons", "owner").items.filter(i => i.kind === "memory_cleanup").length, 0);
});

test("repeat-correction rate counts corrections a live rule should have prevented", async t => {
  const { call, owner, coder } = await room(t);
  assert.equal((await call(owner, "GET", "/memory/metrics")).body.repeatCorrectionRate, null);
  await rule(call, coder, "m1", "When committing, never add emoji", { source: "owner_direct" });
  await rule(call, coder, "m2", "When committing never add emoji.", { source: "owner_direct" });
  await rule(call, coder, "m3", "when committing, never add emoji", { source: "owner_direct" });
  await rule(call, owner, "m4", "When opening a PR, link the issue it closes");
  const m = (await call(owner, "GET", "/memory/metrics?days=7")).body;
  assert.equal(m.corrections, 4);
  assert.equal(m.repeats, 1);
  assert.equal(m.repeatCorrectionRate, 0.25);
  assert.equal(m.days, 7);
  assert.equal((await call(coder, "GET", "/memory/metrics")).status, 403);
});
