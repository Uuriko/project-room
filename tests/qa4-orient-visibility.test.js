// QA4 Q4-SEC-1: the orient ?q= search corpus and the pinned lists on orient
// and the activation pack read projection messages directly. They must apply
// the same DM filter as every other read (RC-2026-09-19-070): only the two
// parties see a targeted message, the room owner included.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const DM_BODY = "qa4dm-orient-secret-8k";
const PUBLIC_BODY = "qa4public-orient-note-2m";

async function seed(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, key) => fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: randomUUID(), type, data });
  f.store.dmConsents.request("commons", "producer", "reviewer", "test fixture");
  f.store.dmConsents.decide("commons", "reviewer", "producer", "approve");
  send("producer", T.MESSAGE_POSTED, { messageId: "qa4-dm", body: DM_BODY, toMemberId: "reviewer" });
  send("owner", T.MESSAGE_POSTED, { messageId: "qa4-public", body: PUBLIC_BODY });
  return { ...f, get, send };
}

test("orient ?q= never searches another member's DM", async t => {
  const f = await seed(t);
  for (const [who, sees] of [["owner", false], ["guest", false], ["producer", true], ["reviewer", true]]) {
    const res = await f.get(`/api/rooms/commons/orient?q=${encodeURIComponent("qa4dm orient secret")}`, f.keys[who]);
    assert.equal(res.status, 200, who);
    assert.equal((await res.text()).includes(DM_BODY), sees, `${who} ${sees ? "should" : "must not"} see the DM`);
  }
  // Positive control: public text is still searchable by a bystander.
  const pub = await (await f.get(`/api/rooms/commons/orient?q=${encodeURIComponent("qa4public orient note")}`, f.keys.guest)).text();
  assert.ok(pub.includes(PUBLIC_BODY));
});

test("pinned DMs stay out of a bystander's activation pack and orient", async t => {
  const f = await seed(t);
  f.send("producer", T.MESSAGE_PINNED, { messageId: "qa4-dm" });
  f.send("owner", T.MESSAGE_PINNED, { messageId: "qa4-public" });
  for (const path of ["/api/rooms/commons/activation-pack", "/api/rooms/commons/orient?q=pinned"]) {
    const bystander = await (await f.get(path, f.keys.guest)).text();
    assert.equal(bystander.includes(DM_BODY), false, `${path} leaked a pinned DM`);
    assert.ok(path.includes("orient") || bystander.includes(PUBLIC_BODY), `${path} lost the public pin`);
    const party = await (await f.get(path, f.keys.reviewer)).text();
    if (path.includes("activation-pack")) assert.ok(party.includes(DM_BODY), "the addressee still sees their pinned DM");
  }
});
