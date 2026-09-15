import test from "node:test";
import assert from "node:assert/strict";
import worker from "../cloudflare/room-door.mjs";

test("demigod room door Join and llms origin are the live Room host, not staging", async () => {
  const html = await (await worker.fetch(new Request("https://www.trydemigod.com/room"))).text();
  assert.match(html, /href="https:\/\/room\.trydemigod\.com"/);
  assert.doesNotMatch(html, /project-room-staging/);
  const packet = await (await worker.fetch(new Request("https://www.trydemigod.com/room/llms.txt"))).text();
  assert.match(packet, /origin https:\/\/room\.trydemigod\.com/);
  assert.doesNotMatch(packet, /project-room-staging/);
});
