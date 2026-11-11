// Public agent page: access policy, wake pointer, and the privacy boundary.
// HTTP coverage for server/routes/public-agent-page.mjs. A question is not a
// room message. The public card, page, poll, and errors carry the ask and the
// display name, and nothing from the room log.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { linkWithProof } from "./helpers/link-with-proof.mjs";

async function listen(t, store, publicAgentPages, extra = {}) {
  const server = createRoomServer({ store, publicAgentPages, ...extra });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(origin, path, { method = "GET", body, secret, accept, client } = {}) {
  const url = path.startsWith("http") ? path : `${origin}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...(accept ? { accept } : {}),
      ...(client ? { "x-test-client": client } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json, headers: res.headers };
}

const code = res => res.json?.error?.code;
const hidden = (text, secrets) => {
  for (const secret of secrets) assert.equal(text.includes(secret), false);
};

test("an open ask wakes the agent with a pointer and stays out of the room", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = await listen(t, f.store, true);
  const identity = f.store.identities.create("Relay");
  linkWithProof(f.store, f.keys.owner, "commons", identity, { displayName: "Relay", permissions: [] });
  const marker = `private-room-${randomUUID()}`;
  const eventsBefore = f.store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  f.store.command(f.keys.owner, "commons", {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: marker },
  });
  const beat = await call(origin, "/api/agent-heartbeats", { method: "POST", body: { hostId: "relay-host" }, secret: identity.secret });
  assert.equal(beat.status, 200, beat.text);
  const saved = await call(origin, `/api/rooms/commons/public-agent/${identity.identityId}`, {
    method: "POST", secret: f.keys.owner,
    body: { access: "open", slug: "relay", blurb: "Ask me about the work.", enabled: true },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.page, `${origin}/u/relay`);
  const question = `what is ready ${randomUUID()}`;
  const eventsAtAsk = f.store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  assert.equal(eventsAtAsk, eventsBefore + 1);
  const posted = await call(origin, "/api/public/agents/relay/asks", {
    method: "POST", body: { question, from: "visitor" },
  });
  assert.equal(posted.status, 202, posted.text);
  assert.equal(posted.json.status, "open");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, eventsAtAsk);
  const eventBodies = f.store.db.prepare("SELECT body FROM events").all().map(row => row.body).join("\n");
  assert.equal(eventBodies.includes(question), false);
  const signal = f.store.db.prepare(
    "SELECT kind, message_id FROM agent_wake_signals WHERE message_id=?"
  ).get(`public-ask:${posted.json.id}`);
  assert.equal(signal.kind, "ask");
  const again = await call(origin, "/api/agent-heartbeats", { method: "POST", body: { hostId: "relay-host" }, secret: identity.secret });
  const wake = again.json.pendingWakes.find(item => item.publicAsk === posted.json.id);
  assert.ok(wake, again.text);
  assert.equal(wake.kind, "ask");
  assert.equal(JSON.stringify(wake).includes(question), false);
  const card = await call(origin, "/api/public/agents/relay", { accept: "application/json" });
  assert.deepEqual(Object.keys(card.json).sort(), ["access", "ask", "blurb", "name", "page", "poll", "slug"]);
  assert.equal(card.json.name, "Relay");
  assert.equal(card.json.access, "open");
  const page = await call(origin, "/u/relay");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /style-src 'unsafe-inline'/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /script-src/);
  assert.equal(page.text.includes("<script"), false);
  const plain = await call(origin, "/u/relay", { accept: "text/plain" });
  assert.match(plain.text, /POST a question as JSON:/);
  const waiting = await call(origin, posted.json.poll, { accept: "text/plain" });
  assert.equal(waiting.text, "no reply yet\n");
  const answered = await call(origin, `/api/rooms/commons/public-agent/${identity.identityId}/asks/${posted.json.id}`, {
    method: "POST", secret: identity.secret, body: { action: "answer", answer: "The board is clear." },
  });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(answered.json.status, "answered");
  const poll = await call(origin, posted.json.poll);
  assert.equal(poll.json.answer, "The board is clear.");
  assert.deepEqual(Object.keys(poll.json).sort(), ["answer", "from", "id", "poll", "question", "status"]);
  const surfaces = [posted.text, card.text, page.text, plain.text, waiting.text, poll.text];
  for (const surface of surfaces) hidden(surface, [marker, f.keys.owner, identity.secret, identity.identityId]);
  const stranger = await call(origin, `/api/rooms/commons/public-agent/${identity.identityId}`, {
    method: "POST", secret: f.keys.producer,
    body: { access: "closed", slug: "relay", blurb: "", enabled: true },
  });
  assert.equal(stranger.status, 403);
  assert.equal(code(stranger), "owner_required");
});

test("knock waits for acceptance and closed stores nothing", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = await listen(t, f.store, true);
  const identity = f.store.identities.create("Porter");
  linkWithProof(f.store, f.keys.owner, "commons", identity, { displayName: "Porter", permissions: [] });
  await call(origin, "/api/agent-heartbeats", { method: "POST", body: { hostId: "porter-host" }, secret: identity.secret });
  const save = (slug, access) => call(origin, `/api/rooms/commons/public-agent/${identity.identityId}`, {
    method: "POST", secret: f.keys.owner,
    body: { access, slug, blurb: "", enabled: true },
  });
  assert.equal((await save("porter", "knock")).status, 200);
  const knocked = await call(origin, "/api/public/agents/porter/asks", { method: "POST", body: { question: "May I ask?" } });
  assert.equal(knocked.status, 202, knocked.text);
  assert.equal(knocked.json.status, "knock");
  const early = await call(origin, knocked.json.poll, { accept: "text/plain" });
  assert.equal(early.text, "no reply yet\n");
  const accepted = await call(origin, `/api/rooms/commons/public-agent/${identity.identityId}/asks/${knocked.json.id}`, {
    method: "POST", secret: f.keys.owner, body: { action: "accept" },
  });
  assert.equal(accepted.json.status, "open");
  const wakes = f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM agent_wake_signals WHERE kind='ask' AND message_id=?"
  ).get(`public-ask:${knocked.json.id}`).n;
  assert.equal(wakes, 1);
  assert.equal((await save("porter", "closed")).status, 200);
  const refused = await call(origin, "/api/public/agents/porter/asks", { method: "POST", body: { question: "One more?" } });
  assert.equal(refused.status, 403);
  assert.equal(code(refused), "agent_closed");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_public_asks WHERE question=?").get("One more?").n, 0);
  const listed = await call(origin, `/api/rooms/commons/public-agent/${identity.identityId}/asks`, { secret: f.keys.owner });
  assert.equal(listed.json.asks.length, 1);
  assert.equal(listed.json.asks[0].question, "May I ask?");
});

test("the eleventh ask from one address is refused", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = await listen(t, f.store, true);
  // Three questions per agent, so the per-address minute cap is what
  // refuses the eleventh request. One page would stop at three.
  const slugs = [];
  for (let i = 0; i < 4; i += 1) {
    const identity = f.store.identities.create(`Limiter ${i}`);
    linkWithProof(f.store, f.keys.owner, "commons", identity, { displayName: `Limiter ${i}`, permissions: [] });
    const slug = `limiter${i}`;
    const saved = await call(origin, `/api/rooms/commons/public-agent/${identity.identityId}`, {
      method: "POST", secret: f.keys.owner,
      body: { access: "open", slug, blurb: "", enabled: true },
    });
    assert.equal(saved.status, 200, saved.text);
    slugs.push(slug);
  }
  const plan = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3];
  for (let n = 0; n < plan.length; n += 1) {
    const posted = await call(origin, `/api/public/agents/${slugs[plan[n]]}/asks`, { method: "POST", body: { question: `n${n}` } });
    assert.equal(posted.status, 202, posted.text);
  }
  const blocked = await call(origin, `/api/public/agents/${slugs[3]}/asks`, { method: "POST", body: { question: "overflow" } });
  assert.equal(blocked.status, 429);
  assert.equal(code(blocked), "rate_limited");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_public_asks WHERE question='overflow'").get().n, 0);
});

test("public and owner routes stay dark when the flag is off", async t => {
  const directory = mkdtempSync(join(tmpdir(), "public-agent-off-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = await listen(t, store, false);
  const page = await call(origin, "/u/relay");
  const card = await call(origin, "/api/public/agents/relay");
  const ask = await call(origin, "/api/public/agents/relay/asks", { method: "POST", body: { question: "hello" } });
  const poll = await call(origin, "/api/public/agents/relay/asks/ask_0123456789");
  for (const res of [page, card, ask, poll]) {
    assert.equal(res.status, 404, res.text);
    assert.equal(code(res), "agent_page_unavailable");
  }
  const owner = store.issueAccessKey("commons", "owner");
  const list = await call(origin, "/api/rooms/commons/public-agent", { secret: owner });
  assert.equal(list.status, 404);
  assert.equal(code(list), "not_found");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_public_asks").get().n, 0);
});

test("one caller cannot fill an agent's hourly asks while another caller still can", async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = await listen(t, f.store, true, {
    resolveClientAddress: req => String(req.headers["x-test-client"] || ""),
  });
  const identity = f.store.identities.create("Relay");
  linkWithProof(f.store, f.keys.owner, "commons", identity, { displayName: "Relay", permissions: [] });
  const saved = await call(origin, `/api/rooms/commons/public-agent/${identity.identityId}`, {
    method: "POST", secret: f.keys.owner,
    body: { access: "open", slug: "relay", blurb: "", enabled: true },
  });
  assert.equal(saved.status, 200, saved.text);
  const ask = (client, n) => call(origin, "/api/public/agents/relay/asks", {
    method: "POST", client, body: { question: `question ${client} ${n} ${randomUUID()}` },
  });
  for (let n = 1; n <= 3; n += 1) {
    const posted = await ask("caller-a", n);
    assert.equal(posted.status, 202, posted.text);
  }
  const blocked = await ask("caller-a", 4);
  assert.equal(blocked.status, 429, blocked.text);
  assert.equal(code(blocked), "rate_limited");
  assert.match(blocked.json.error.message, /this client/);
  const other = await ask("caller-b", 1);
  assert.equal(other.status, 202, other.text);
  const hashes = f.store.db.prepare("SELECT client_hash FROM agent_public_asks").all().map(row => row.client_hash);
  assert.equal(hashes.length, 4);
  assert.equal(new Set(hashes).size, 2);
  for (const hash of hashes) {
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(hash.includes("caller"), false);
  }
});

test("ten waiting questions from one client stop that client before the agent-wide cap", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = "https://room.example.test";
  const slugs = [];
  for (let i = 0; i < 4; i += 1) {
    const identity = f.store.identities.create(`Relay ${i}`);
    linkWithProof(f.store, f.keys.owner, "commons", identity, { displayName: `Relay ${i}`, permissions: [] });
    const slug = `relay${i}`;
    f.store.publicAgentPages.configure("commons", "owner", identity.identityId, {
      access: "open", slug, blurb: "", enabled: true,
    }, origin);
    slugs.push(slug);
  }
  const pages = f.store.publicAgentPages;
  let posted = 0;
  for (const slug of slugs.slice(0, 3)) {
    for (let i = 0; i < 3; i += 1) {
      const ask = pages.postAsk(slug, { question: `queued ${posted}` }, origin, "203.0.113.8");
      assert.equal(ask.status, "open");
      posted += 1;
    }
  }
  const tenth = pages.postAsk(slugs[3], { question: "queued 9" }, origin, "203.0.113.8");
  assert.equal(tenth.status, "open");
  assert.throws(
    () => pages.postAsk(slugs[3], { question: "queued 10" }, origin, "203.0.113.8"),
    error => error.status === 429 && /this client/.test(error.message)
  );
  const other = pages.postAsk(slugs[0], { question: "from the other caller" }, origin, "203.0.113.9");
  assert.equal(other.status, "open");
  const waiting = f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_public_asks WHERE status='open'").get().n;
  assert.equal(waiting, 11);
  assert.ok(waiting < 50);
});

test("an asks table created before client hashes still stores a question", t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const identity = f.store.identities.create("Relay");
  linkWithProof(f.store, f.keys.owner, "commons", identity, { displayName: "Relay", permissions: [] });
  f.store.publicAgentPages.configure("commons", "owner", identity.identityId, {
    access: "open", slug: "relay", blurb: "", enabled: true,
  }, "https://room.example.test");
  f.store.db.exec("DROP TABLE agent_public_asks");
  f.store.db.exec(`CREATE TABLE agent_public_asks (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('knock','open','answered','rejected')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const posted = f.store.publicAgentPages.postAsk("relay", { question: "still works" }, "https://room.example.test", "203.0.113.10");
  assert.equal(posted.status, "open");
  const columns = f.store.db.prepare("PRAGMA table_info(agent_public_asks)").all().map(column => column.name);
  assert.ok(columns.includes("client_hash"));
  const hash = f.store.db.prepare("SELECT client_hash FROM agent_public_asks").get().client_hash;
  assert.match(hash, /^[a-f0-9]{64}$/);
});
