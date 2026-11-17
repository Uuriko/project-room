import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { publishProjectMapOverlap } from "../server/project-map-store.mjs";
import { privateWorkFixture, privateMarkers, PRIVATE } from "./helpers/private-work-fixture.mjs";

test("legacy: Board overlap does not name private work to a member outside it", async t => {
  const f = await privateWorkFixture(t, "legacy");
  const repo = `acme/${PRIVATE.REPO}`, path = `${PRIVATE.PATH}.js`;
  const published = await fetch(`${f.origin}/api/rooms/commons/map`, { method: "POST", headers: { Authorization: `Bearer ${f.owner}`, "content-type": "application/json" },
    body: JSON.stringify({ repo, revision: "abc", files: [{ path, source: "export function helper() { return 1; }\n" }] }) });
  assert.equal(published.status, 200);
  // The observer takes public work in the same repository and file.
  f.send(f.owner, "work.proposed", { workItemId: "shared", title: "Shared public", definitionOfDone: "Public", accountableMemberId: f.observer.id, mode: "write" });
  f.send(f.observer.key, "work.accepted", { workItemId: "shared", expectedRevision: f.rev("shared") });
  f.send(f.observer.key, "claim.acquired", { workItemId: "shared", expectedRevision: f.rev("shared"), repository: repo, ref: "main", paths: [path],
    expiresAt: new Date(Date.now() + 3600000).toISOString() });
  // The observer typed the repository and path, so only other markers count.
  const unknown = text => privateMarkers(text).filter(marker => ![PRIVATE.REPO, PRIVATE.PATH].includes(marker));
  const leaks = {};
  for (const [label, read] of [["GET /work-claims", () => f.rest(f.observer, "/work-claims")], ["GET /work-claims/shared", () => f.rest(f.observer, "/work-claims/shared")],
    ["room_read_board", () => f.mcp(f.observer, "room_read_board")]]) {
    const found = unknown((await read()).text);
    if (found.length) leaks[label] = found;
  }
  assert.deepEqual(leaks, {});
  const allowed = await f.rest(f.producer, "/work-claims/shared");
  assert.ok(allowed.text.includes(PRIVATE.TITLE), "a party still sees private overlap advice");
});


test("legacy: REST claim overlap notices never publish private peers or subjects", async t => {
  const f = await privateWorkFixture(t, "legacy");
  const repo = `acme/${PRIVATE.REPO}`, path = `${PRIVATE.PATH}.js`;
  const response = await fetch(`${f.origin}/api/rooms/commons/map`, { method: "POST",
    headers: { Authorization: `Bearer ${f.owner}`, "content-type": "application/json" },
    body: JSON.stringify({ repo, revision: "abc", files: [{ path, source: "export function helper() {}" },
      { path: "public-one.js", source: `import { helper } from "./${path}"; export function one() { return helper(); }` },
      { path: "public-two.js", source: 'import { one } from "./public-one.js"; export function two() { return one(); }' }] }) });
  assert.equal(response.status, 200);
  const client = new RoomAgentClient({ origin: f.origin, roomId: "commons", token: f.observer.secret });
  const notices = () => f.store.db.prepare("SELECT body FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='message.posted'").all()
    .map(row => JSON.parse(row.body).data.body).filter(body => /^(Overlap|Duplicate):/.test(body));
  const claimed = await client.workClaim("public-overlap-one", { title: "Public overlap one", files: ["public-one.js"], repo });
  assert.equal(claimed.overlap, undefined, "a private peer cannot generate public advice");
  assert.deepEqual(notices(), []);
  const second = await client.workClaim("public-overlap-two", { title: "Public overlap two", files: ["public-two.js"], repo });
  assert.ok(second.overlap?.summary.includes("Public overlap one"));
  assert.ok(notices().length > 0, "public overlap notices still work");
  assert.ok(notices().every(body => !body.includes(PRIVATE.TITLE)));
  const privateRow = f.store.workClaims.list("commons").find(row => row.workItemId === "secret");
  const before = f.stored(), count = notices().length;
  assert.equal(publishProjectMapOverlap(f.store, "commons", privateRow), null, "a private subject cannot generate a public notice");
  assert.equal(notices().length, count);
  assert.equal(f.stored(), before, "filtering leaves stored work and events untouched");
});
