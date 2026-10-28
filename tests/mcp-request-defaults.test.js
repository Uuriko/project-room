import test from "node:test";
import assert from "node:assert/strict";
import { pinnedRoomForApiKey, withDefaultRoomId } from "../server/mcp-request-defaults.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";

const roomRequired = { properties: { roomId: {}, body: {} }, required: ["roomId", "body"] };
const roomOptional = { properties: { roomId: {}, body: {} }, required: ["body"] };

function storeWithScopes(scopes) {
  const secret = `${API_KEY_PREFIX}test`;
  return {
    secret,
    store: { agentPlugin: { verifyPresentedApiKey: value => value === secret ? { scopes } : null } }
  };
}

test("pinned room defaults apply only to an unambiguous scoped room key", () => {
  const pinned = storeWithScopes(["rooms:read", "mcp:room:alpha"]);
  assert.equal(pinnedRoomForApiKey(pinned.store, pinned.secret), "alpha");
  assert.deepEqual(withDefaultRoomId(pinned.store, pinned.secret, "room_post_message", { body: "hi" }, roomRequired), {
    body: "hi", roomId: "alpha"
  });
  assert.deepEqual(withDefaultRoomId(pinned.store, pinned.secret, "room_post_message", { roomId: "beta" }, roomRequired), {
    roomId: "beta"
  });

  const ambiguous = storeWithScopes(["mcp:room:alpha", "mcp:room:beta"]);
  assert.equal(pinnedRoomForApiKey(ambiguous.store, ambiguous.secret), null);
  assert.deepEqual(withDefaultRoomId(ambiguous.store, ambiguous.secret, "room_post_message", {}, roomRequired), {});

  assert.deepEqual(withDefaultRoomId(pinned.store, pinned.secret, "room_check_access", {}, { properties: { roomId: {} } }), {});
  assert.deepEqual(withDefaultRoomId(pinned.store, pinned.secret, "room_create", {}, roomRequired), {});
  assert.deepEqual(withDefaultRoomId(pinned.store, pinned.secret, "room_read_board", {}, roomOptional), {});
  assert.deepEqual(withDefaultRoomId(pinned.store, pinned.secret, "room_needs_me", {}, roomOptional), { roomId: "alpha" });
});
