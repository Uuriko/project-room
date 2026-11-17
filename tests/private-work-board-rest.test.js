// Regression reproduced on 4b3d1ab2. Legacy storage. Two table routes in
// server/routes/work-claims.mjs read Board rows without the viewer boundary:
//   GET /api/rooms/{roomId}/work-claims-read            (getWorkClaimsRead)
//   GET /api/rooms/{roomId}/work-claims/{claimId}/thread (threadRoute)
// The Board row mirrors private work, so both hand its content to a member
// outside the task. The participant and public-work controls keep "hide
// everything" from passing.
import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkFixture, privateMarkers, PRIVATE, PUBLIC } from "./helpers/private-work-fixture.mjs";

const read = async (f, who, path) => {
  const response = await fetch(`${f.origin}/api/rooms/commons${path}`, { headers: { Authorization: `Bearer ${who.secret}` } });
  return { status: response.status, text: await response.text() };
};

test("legacy: Board table routes withhold private work from members outside it", async t => {
  const f = await privateWorkFixture(t, "legacy");
  const before = f.stored(), leaks = {};
  for (const path of ["/work-claims-read", "/work-claims/secret/thread"]) {
    for (const viewer of ["observer", "triage", "broad"]) {
      const response = await read(f, f[viewer], path);
      assert.equal(response.status, 200, `${path} as ${viewer}`);
      const found = privateMarkers(response.text);
      if (found.length) leaks[`${path} as ${viewer}`] = found.map(marker => marker.slice(11, -3));
    }
    for (const viewer of ["producer", "reviewer"]) {
      const response = await read(f, f[viewer], path);
      assert.ok(response.status === 200 && response.text.includes(PRIVATE.TITLE), `${viewer} still reads the private row on ${path}`);
    }
  }
  assert.ok((await read(f, f.observer, "/work-claims-read")).text.includes(PUBLIC.TITLE), "public work stays listed");
  assert.equal(f.stored(), before, "reads changed stored rows");
  assert.deepEqual(leaks, {});
});
