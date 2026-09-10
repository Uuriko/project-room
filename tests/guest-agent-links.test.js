import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  classifyJoinToken, guestAgentLinkContract, previewGuestAgentLink, joinGuestAgentLink, mintGuestAgentLink,
  GUEST_AGENT_TOKEN_PREFIX, GUEST_AGENT_KIND, GUEST_AGENT_PERMISSIONS, GUEST_AGENT_HASH_PATH, HUMAN_SHARE_HASH_PATH
} from "../server/guest-agent-links.mjs";

const guestToken = () => GUEST_AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
const humanToken = () => randomBytes(32).toString("base64url");

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-guest-agent-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data } = {}) => fetch(origin + path, {
    method, headers: { Origin: origin, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, origin, request };
}

test("guest-agent tokens are a different shape from human share tokens", () => {
  const agent = guestToken(), human = humanToken();
  assert.equal(classifyJoinToken(agent), "guest-agent");
  assert.equal(classifyJoinToken(human), "human-share");
  assert.equal(classifyJoinToken("not-a-token"), "invalid");
  assert.notEqual(GUEST_AGENT_HASH_PATH, HUMAN_SHARE_HASH_PATH);
  assert.equal(guestAgentLinkContract().kind, GUEST_AGENT_KIND);
  assert.deepEqual(guestAgentLinkContract().permissions, [...GUEST_AGENT_PERMISSIONS]);
  assert.equal(guestAgentLinkContract().mint, "not_implemented");
  assert.equal(guestAgentLinkContract().separateFromHumanShareLinks, true);
  assert.equal(guestAgentLinkContract().account, false);
});

test("stubs refuse mint and reject human share tokens as agent credentials", () => {
  assert.throws(() => mintGuestAgentLink(), { status: 501, code: "guest_agent_link_not_implemented" });
  assert.throws(() => previewGuestAgentLink(humanToken()), { status: 422, code: "wrong_link_kind" });
  assert.throws(() => joinGuestAgentLink(humanToken()), { status: 422, code: "wrong_link_kind" });
  assert.throws(() => previewGuestAgentLink(guestToken()), { status: 501, code: "guest_agent_link_not_implemented" });
  assert.throws(() => joinGuestAgentLink(guestToken()), { status: 501, code: "guest_agent_link_not_implemented" });
  assert.throws(() => previewGuestAgentLink("nope"), { status: 410, code: "link_unavailable" });
});

test("HTTP guest-agent stubs stay 501 and share-links reject agent-shaped tokens", async t => {
  const { store, request } = await serve(t);
  const contract = await request("/api/guest-agent-links");
  assert.equal(contract.status, 200);
  assert.deepEqual(await contract.json(), guestAgentLinkContract());
  assert.equal((await request("/api/guest-agent-links", { method: "HEAD" })).status, 200);
  const mint = await request("/api/guest-agent-links", { method: "POST", data: {} });
  assert.equal(mint.status, 501);
  assert.equal((await mint.json()).error.code, "guest_agent_link_not_implemented");
  const human = humanToken(), agent = guestToken();
  const wrongKind = await request("/api/guest-agent-links/preview", { method: "POST", data: { linkToken: human } });
  assert.equal(wrongKind.status, 422);
  assert.equal((await wrongKind.json()).error.code, "wrong_link_kind");
  const designed = await request("/api/guest-agent-links/join", { method: "POST", data: { linkToken: agent } });
  assert.equal(designed.status, 501);
  const share = await request("/api/share-links/preview", { method: "POST", data: { linkToken: agent } });
  assert.equal(share.status, 422);
  assert.equal((await share.json()).error.code, "wrong_link_kind");
  assert.throws(() => store.shareLinks.preview(agent), { code: "wrong_link_kind" });
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'guest_agent%'").all().length, 0);
});
