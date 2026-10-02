// ACT-3a: an agent following docs/agents/START.md closes the starter over HTTP.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { verifyIdentityMintProof } from "../server/agent-identities.mjs";
import { solveIdentityMintProof } from "./fixtures/identity-mint-solver.mjs";

const doc = readFileSync(new URL("../docs/agents/START.md", import.meta.url), "utf8");
const fixture = readFileSync(new URL("./fixtures/identity-mint-solver.mjs", import.meta.url), "utf8");

function javascriptBlocks(source) {
  return [...source.matchAll(/```javascript\n([\s\S]*?)```/g)].map(match => match[1]);
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-start-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, directory };
}

test("the doc solver matches the fixture and the identity verifier accepts it", () => {
  assert.ok(doc.includes(fixture.trimEnd()), "START.md contains the solver fixture byte for byte");
  assert.ok(javascriptBlocks(doc).length >= 1);
  assert.match(doc, /format\(i, "x"\)/);
  const lines = doc.split("\n");
  assert.ok(lines.length <= 40, `START.md is ${lines.length} lines`);
  const name = "Doc Agent";
  const now = Date.now();
  const proof = solveIdentityMintProof(name, now);
  assert.equal(verifyIdentityMintProof(name, proof, now), true);
});

test("an agent executing START.md closes the starter in at most 6 calls", async t => {
  const { origin, store, directory } = await serve(t);
  const [script] = javascriptBlocks(doc);
  const file = join(directory, "start.mjs");
  writeFileSync(file, script);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls += 1;
    return original(...args);
  };
  t.after(() => { globalThis.fetch = original; });
  const previous = { origin: process.env.ROOM_ORIGIN, id: process.env.ROOM_ID, name: process.env.ROOM_AGENT_NAME };
  process.env.ROOM_ORIGIN = origin;
  process.env.ROOM_ID = "doc-room";
  process.env.ROOM_AGENT_NAME = "Doc Agent";
  try {
    await import(pathToFileURL(file).href);
  } finally {
    if (previous.origin === undefined) delete process.env.ROOM_ORIGIN; else process.env.ROOM_ORIGIN = previous.origin;
    if (previous.id === undefined) delete process.env.ROOM_ID; else process.env.ROOM_ID = previous.id;
    if (previous.name === undefined) delete process.env.ROOM_AGENT_NAME; else process.env.ROOM_AGENT_NAME = previous.name;
  }
  assert.ok(calls <= 6, `START.md made ${calls} HTTP calls`);
  const starter = store.workClaims.get("doc-room", "starter");
  assert.equal(starter.state, "done");
  assert.equal(starter.deliveryMode, "result");
  const done = store.db.prepare("SELECT 1 FROM events WHERE room_id=? AND json_extract(body,'$.type')='work_claim.updated' AND json_extract(body,'$.data.workClaim')='starter' AND json_extract(body,'$.data.claimState')='done'").get("doc-room");
  assert.ok(done, "claim_completed is the done work_claim.updated event");
  const posted = store.room("doc-room").state.messages.some(message => message.body === "Plan: close the starter.");
  assert.equal(posted, true);
});

test("a duplicate agent room returns the same starter, and starter:false creates none", async t => {
  const { origin } = await serve(t);
  const mint = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Room Agent" })
  });
  const minted = await mint.json();
  assert.equal(mint.status, 201, JSON.stringify(minted));
  const create = body => fetch(`${origin}/api/agent-rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${minted.secret}` },
    body: JSON.stringify(body)
  });
  const firstResponse = await create({ roomId: "agent-start", title: "Agent start", purpose: "Close one task." });
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 201, JSON.stringify(first));
  assert.equal(first.next[0].action, "start-work");
  assert.equal(first.next[0].path, "/api/rooms/agent-start/work-claims/starter/update");
  assert.deepEqual(first.starter, { claimId: "starter", state: "claimed" });
  const againResponse = await create({ roomId: "agent-start", title: "Agent start", purpose: "Close one task." });
  const again = await againResponse.json();
  assert.equal(againResponse.status, 200, JSON.stringify(again));
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.starter, first.starter);
  const optedResponse = await create({ roomId: "agent-plain", title: "Plain", purpose: "No starter.", starter: false });
  const opted = await optedResponse.json();
  assert.equal(optedResponse.status, 201, JSON.stringify(opted));
  assert.equal(opted.starter, null);
  assert.equal(opted.next[0].action, "start-work");
});
