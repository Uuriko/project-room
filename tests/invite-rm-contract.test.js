// #2465 regression guard: the server's agent-invite mint shape and the
// client's two parsers (the SPA #invite/ fragment gate and the join-page
// route parser) must agree on what an agent-invite code looks like. #2465
// broke exactly on this seam: the SPA only spoke 43-char human tokens while
// the server minted RM- + 16 Crockford symbols, so agent links dead-ended
// ("This invitation link is unavailable.") before any API call. These tests
// pin the contract with REAL minted codes, end to end:
//   mint (HTTP) -> SPA #invite/ fragment -> join-page path
//   -> join-page parse -> API join (web-UI: POST /api/join) and
//   API redeem (machine: POST /api/agent-invites/redeem).
// If mint ever changes shape or either parser narrows, this fails before a
// stranger hits a dead link.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AGENT_INVITE_CODE_PATTERN, agentInviteJoinPath } from "../src/invite-context.js";
import { parseJoinCode } from "../src/join.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invite-contract-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

const mint = (origin, ownerKey, body = { permissions: ["accept_work"], displayName: "Contract Bot" }) =>
  fetch(`${origin}/api/rooms/commons/agent-invites`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify(body),
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));

test("minted 16-char code survives the full client round-trip", async t => {
  const { origin, ownerKey } = await serve(t);
  const res = await mint(origin, ownerKey);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const code = res.json.code;
  // v2 mint shape: RM- + 16 symbols from the 32-symbol Crockford alphabet.
  assert.match(code, /^RM-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/);

  // SPA fragment gate (#2465): the fragment must be flagged as an
  // agent invite, never opened as a human-token dialog.
  assert.ok(AGENT_INVITE_CODE_PATTERN.test(code), "fragment gate rejects a real minted code");
  // Fragment -> join-page path on both doors...
  const bare = agentInviteJoinPath(`#invite/${code}`, "/");
  const www = agentInviteJoinPath(`#invite/${code}`, "/room/");
  assert.equal(bare, `/join/${code}`);
  assert.equal(www, `/room/join/${code}`);
  // ...and the join page parses those paths back to the identical code.
  assert.equal(parseJoinCode(bare), code);
  assert.equal(parseJoinCode(www), code);
  assert.equal(parseJoinCode(`${bare}/`), code, "trailing slash still parses");
});

test("web-UI join path: POST /api/join with the client-parsed code redeems", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  assert.equal(minted.status, 201);
  // Exactly what the join page does: parse the code out of the redirected
  // path, then POST it as { displayName, inviteCode }.
  const parsed = parseJoinCode(agentInviteJoinPath(`#invite/${minted.json.code}`, "/"));
  const res = await fetch(`${origin}/api/join`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Contract Human", inviteCode: parsed }),
  });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.roomId, "commons");
  assert.equal(body.via, "invite");
  assert.ok(typeof body.roomToken === "string" && body.roomToken.length > 0, "web-UI join hands back the room token");
});

test("API join path: POST /api/agent-invites/redeem with the minted code redeems", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  assert.equal(minted.status, 201);
  const res = await fetch(`${origin}/api/agent-invites/redeem`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ code: minted.json.code, displayName: "Contract Agent" }),
  });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.roomId, "commons");
});

test("join route serves the page for a minted code segment", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  assert.equal(minted.status, 201);
  for (const path of [`/join/${minted.json.code}`, `/room/join/${minted.json.code}`]) {
    const res = await fetch(`${origin}${path}`, { headers: { Accept: "text/html" } });
    assert.equal(res.status, 200, `${path} -> ${res.status}`);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    await res.text();
  }
});

test("legacy v1 8-symbol codes still parse on both clients", () => {
  const legacy = "RM-ABCDEFGH";
  assert.ok(AGENT_INVITE_CODE_PATTERN.test(legacy), "fragment gate rejects legacy code shape");
  assert.equal(parseJoinCode(agentInviteJoinPath(`#invite/${legacy}`, "/")), legacy);
  assert.equal(parseJoinCode(agentInviteJoinPath(`#invite/${legacy}`, "/room")), legacy);
});

// The server folds case and confusables on redeem ("a transcribed code still
// works"), and the join page uppercases before calling the API — but the SPA
// fragment gate is the one hop that rejected lowercase, dead-ending a
// transcribed/lowercased link exactly like #2465's bug.
test("lowercase #invite/rm- fragments still reach the join page", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  assert.equal(minted.status, 201);
  const lower = minted.json.code.toLowerCase();
  assert.ok(AGENT_INVITE_CODE_PATTERN.test(lower), "fragment gate rejects lowercase code");
  const path = agentInviteJoinPath(`#invite/${lower}`, "/");
  assert.equal(path, `/join/${minted.json.code}`, "join path normalizes to the canonical uppercase code");
  const parsed = parseJoinCode(path);
  const res = await fetch(`${origin}/api/join`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Lowercase Human", inviteCode: parsed }),
  });
  assert.equal(res.status, 201, "lowercase-originated join redeems");
  await res.json().catch(() => null);
});
