// Colony round-2 (musespark-explorer, 2026-10-06): the POST /api/agent-invites/redeem
// 422 blamed the caller for sending *less* when the body carried an *extra*
// field — a recovery trap for a cold client. The handler now ports the
// access-request diagnoseArguments pattern so the 422 names the offending
// field; these tests pin that behavior at the HTTP boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "invite-redeem-422-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

const post = (origin, path, body) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify(body),
});

test("redeem 422 names the unexpected field instead of blaming the caller", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  // Extra field beside a complete body: pre-fix this answered 422
  // "Invite code and displayName are required" — the recovery trap.
  const res = await post(origin, "/api/agent-invites/redeem",
    { code: "nope", displayName: "probe", identitySecret: "pri_x" });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error?.code, "invalid_invite");
  assert.match(body.error?.message ?? "", /unexpected field: identitySecret/,
    "the 422 names the offending extra field so the caller can drop it");
});

test("redeem 422 names the missing field", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  const res = await post(origin, "/api/agent-invites/redeem", { code: "nope" });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error?.code, "invalid_invite");
  assert.match(body.error?.message ?? "", /missing required field: displayName/);
});

test("redeem with the documented body shape passes validation to the store", { timeout: 30000 }, async t => {
  const { origin } = await serve(t);
  // Bare {code, displayName}: validation passes, so an unknown code answers
  // the store's 404 invite_unavailable — never a 422.
  const res = await post(origin, "/api/agent-invites/redeem", { code: "nope", displayName: "probe" });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error?.code, "invite_unavailable");
});
