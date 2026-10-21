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

// QA 2026-10-20: the room-cookie probe 401'd on every room load for signed-in
// account users (who hold no room cookie). A cookie-only joiner still opens the
// room: the probe runs when there is no account session, and again if the
// account path is refused.
test("deep-link boot tries the room-cookie session for joiners without an account", () => {
  const probe = app.indexOf("// Join-flow sessions are room-cookie sessions");
  assert.ok(probe !== -1, "the deep-link boot carries the join-flow comment");
  const restoreCall = app.indexOf("const joined = await client.restore();", probe);
  assert.ok(restoreCall > probe, "the room-cookie probe (no roomId, room mode) exists");
  const matchCheck = app.indexOf("if (joined?.roomId === requestedRoom) return true;", restoreCall);
  assert.ok(matchCheck > restoreCall, "a matching cookie session opens the room");
  const dropMismatch = app.indexOf("client.endAccess();", matchCheck);
  assert.ok(dropMismatch > matchCheck, "a cookie for a different room is dropped, not opened");
  const accountGate = app.indexOf("const account = await ensureAccountSession();", dropMismatch);
  assert.ok(accountGate > dropMismatch);
  const noAccountProbe = app.indexOf("!account?.authenticated && await probeRoomCookie()) return;", accountGate);
  assert.ok(noAccountProbe > accountGate, "no account session: the cookie is tried before the sign-in wall");
  const refusedProbe = app.indexOf("if (!accountHomeFromLocation() && await probeRoomCookie()) return;", noAccountProbe);
  assert.ok(refusedProbe > noAccountProbe, "account refused: the cookie is still tried");
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
