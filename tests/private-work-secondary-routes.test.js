import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkFixture, privateMarkers, PRIVATE, PUBLIC } from "./helpers/private-work-fixture.mjs";

test("legacy: real session heartbeats withhold private titles and preserve public work", async t => {
  const f = await privateWorkFixture(t, "legacy");
  for (const workItemId of ["secret", "open"]) {
    f.send(f.producer.key, "session.started", { workItemId, expectedRevision: f.rev(workItemId) });
  }
  const before = f.stored();
  for (const viewer of [f.observer, f.triage, f.broad, f.producer, f.reviewer]) {
    const read = await f.rest(viewer, "/provider-heartbeats");
    assert.equal(read.status, 200);
    const provider = read.json.providers.find(row => row.memberId === f.producer.id);
    assert.equal(provider.status, "live");
    assert.ok(provider.lastHeartbeatAt);
    const secret = provider.workingOn.find(row => row.workItemId === "secret");
    const open = provider.workingOn.find(row => row.workItemId === "open");
    assert.ok(secret.heartbeat_at);
    assert.equal(open.title, PUBLIC.TITLE);
    const authorized = viewer === f.producer || viewer === f.reviewer;
    assert.equal(secret.title, authorized ? PRIVATE.TITLE : null);
    if (!authorized) assert.deepEqual(privateMarkers(read.text), []);
  }
  assert.equal(f.stored(), before);
});

test("legacy: duplicate lookup filters private Board text before matching", async t => {
  const f = await privateWorkFixture(t, "legacy"), before = f.stored();
  for (const viewer of [f.observer, f.triage, f.broad, f.producer, f.reviewer]) {
    const read = await f.rest(viewer, `/work-claims/duplicates?q=${encodeURIComponent(PRIVATE.TITLE)}`);
    assert.equal(read.status, 200);
    const authorized = viewer === f.producer || viewer === f.reviewer;
    assert.equal(read.json.duplicates.some(row => row.id === "secret"), authorized);
    // The response echoes the caller's query; only returned records are secret-bearing output.
    if (!authorized) assert.deepEqual(privateMarkers(JSON.stringify(read.json.duplicates)), []);
    const publicRead = await f.rest(viewer, `/work-claims/duplicates?q=${encodeURIComponent(PUBLIC.TITLE)}`);
    assert.equal(publicRead.status, 200);
    assert.ok(publicRead.json.duplicates.some(row => row.id === "open"));
  }
  assert.equal(f.stored(), before);
});
