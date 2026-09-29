import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { StorageUnavailableError } from "../server/store.mjs";

async function fixture(t, failPump) {
  const f = createAcceptanceFixture(), original = f.store.eventsAfter.bind(f.store);
  let calls = 0;
  f.store.eventsAfter = (...args) => {
    if (++calls === 3) failPump(f);
    return original(...args);
  };
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`, after = f.store.room("commons").sequence;
  const open = () => fetch(`${origin}/api/rooms/commons/stream?after=${after}`, {
    headers: { Authorization: `Bearer ${f.keys.owner}` }, signal: AbortSignal.timeout(1500)
  });
  return { ...f, open };
}

for (const [name, error] of [["storage503", () => new StorageUnavailableError(new Error("private driver detail"))],
  ["unexpected error", () => new Error("private unexpected detail")], ["non-Error failure", () => null]]) {
  test(`a transient ${name} ends transport without claiming lost access and the same credential reconnects`, async t => {
    const f = await fixture(t, () => { throw error(); });
    const first = await f.open(); assert.equal(first.status, 200);
    const failedWire = await first.text();
    assert.match(failedWire, /event: unavailable/);
    assert.doesNotMatch(failedWire, /access-ended|private driver|private unexpected/);
    assert.equal(f.store.authenticate(f.keys.owner, "commons").member.id, "owner");
    const second = await f.open(); assert.equal(second.status, 200);
    const receipt = f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: { body: "visible-after-transport-recovery" } });
    const reader = second.body.getReader(); let text = "";
    try {
      while (!text.includes("visible-after-transport-recovery")) {
        const chunk = await reader.read(); if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      assert.match(text, new RegExp(`id: ${receipt.sequence}\\n`));
      assert.match(text, /visible-after-transport-recovery/);
      assert.doesNotMatch(text, /access-ended/);
    } finally { await reader.cancel().catch(() => {}); }
  });
}

test("credential revocation during an open stream still emits conclusive access-ended", async t => {
  const f = await fixture(t, f => f.store.revoke(f.keys.owner));
  const response = await f.open(); assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /event: access-ended/);
  assert.doesNotMatch(wire, /event: unavailable/);
  assert.throws(() => f.store.authenticate(f.keys.owner, "commons"), error => error.status === 401);
});
