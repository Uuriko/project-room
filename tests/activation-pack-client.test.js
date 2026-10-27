import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";

test("activation reads preserve full callers, offer a brief, and propagate cancellation", async () => {
  const seen = [];
  const client = new RoomAgentClient({
    origin: "http://127.0.0.1:1", roomId: "commons", token: "a".repeat(43),
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return new Response(JSON.stringify({ view: url.endsWith("?view=brief") ? "brief" : "full" }));
    }
  });
  assert.equal((await client.activationPack()).view, "full");
  assert.equal((await client.activationPack({ view: "full" })).view, "full");
  const controller = new AbortController();
  assert.equal((await client.activationPack({ view: "brief", signal: controller.signal })).view, "brief");
  assert.deepEqual(seen.map(({ url }) => new URL(url).pathname + new URL(url).search), [
    "/api/rooms/commons/activation-pack", "/api/rooms/commons/activation-pack",
    "/api/rooms/commons/activation-pack?view=brief"
  ]);
  controller.abort();
  assert.equal(seen[2].options.signal.aborted, true);
  assert.throws(() => client.activationPack({ view: "everything" }), { code: "invalid_view" });
  assert.equal(seen.length, 3, "invalid views never reach the transport");
});
