// Join-flow handoff (RC-2026-09-23): the /join page's "Open room" link
// lands on /#room/<id> with a valid __Host-room_session cookie but no
// account session. The boot (and the bfcache pageshow path) must try the
// room-cookie session BEFORE the account gate, or a fresh joiner is
// stranded at the sign-in panel despite holding a working session.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(join(ROOT, "src/app.js"), "utf8");

test("deep-link boot tries the room-cookie session before the account gate", () => {
  const probe = app.indexOf("// Join-flow sessions are room-cookie sessions");
  assert.ok(probe !== -1, "the deep-link boot carries the join-flow comment");
  const restoreCall = app.indexOf("const joined = await client.restore();", probe);
  assert.ok(restoreCall > probe, "the room-cookie probe (no roomId, room mode) runs first");
  const matchCheck = app.indexOf("if (joined?.roomId === requestedRoom) return;", restoreCall);
  assert.ok(matchCheck > restoreCall, "a matching cookie session opens the room immediately");
  const dropMismatch = app.indexOf("client.endAccess();", matchCheck);
  assert.ok(dropMismatch > matchCheck, "a cookie for a different room is dropped, not opened");
  const accountGate = app.indexOf("const account = await ensureAccountSession();", dropMismatch);
  assert.ok(accountGate > dropMismatch, "the account gate only runs after the cookie probe fails");
});

test("pageshow deep-link path tries the room-cookie session before the account gate", () => {
  const handler = app.indexOf('window.addEventListener("pageshow"');
  assert.ok(handler !== -1, "the pageshow handler exists");
  const probe = app.indexOf("const joined = await client.restore();", handler);
  assert.ok(probe > handler, "pageshow tries the room-cookie probe for deep links");
  const matchCheck = app.indexOf("if (joined?.roomId === roomId) return joined;", probe);
  assert.ok(matchCheck > probe, "pageshow opens the room when the cookie matches the deep link");
  const accountGate = app.indexOf("const account = await ensureAccountSession();", matchCheck);
  assert.ok(accountGate > matchCheck, "pageshow falls back to the account flow only after the probe");
});
