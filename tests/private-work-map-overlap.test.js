// REPRODUCTION, expected to fail until repaired. Legacy storage, code map
// published. The project-map overlap decoration on Board reads compares the
// reader's row against every raw Board row, including the mirror of private
// work, and names that work's title to a member outside it.
import test from "node:test";
import assert from "node:assert/strict";
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
});
