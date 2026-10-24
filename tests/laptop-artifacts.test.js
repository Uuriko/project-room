import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { laptopTransfer, laptopTransferLimits } from "../server/laptop-transfers.mjs";
import { LAPTOP_TRANSFER_ROUTES } from "../server/routes/laptop-transfers.mjs";
import { roomFileTransport, sha256 } from "../client/room-artifact-transfer.mjs";
import { offerLaptopArtifact, serveLaptopArtifact, receiveLaptopArtifact } from "../client/laptop-artifacts.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sender = { origin, roomId: "commons", memberId: "owner", token: f.keys.owner };
  const receiver = { ...sender, memberId: "producer", token: f.keys.producer };
  return { ...f, sender, receiver };
}
test("10 MiB moves through real authenticated Room routes with no stored attachment bytes", async t => {
  const f = await fixture(t), path = join(f.directory, "source.bin"), bytes = Buffer.alloc(10 * 1024 ** 2, 71);
  writeFileSync(path, bytes);
  const signal = AbortSignal.timeout(15000);
  const reference = await offerLaptopArtifact({ connection: f.sender, path, transferId: "large", recipientId: "producer", signal });
  const [sent, received] = await Promise.all([
    serveLaptopArtifact({ connection: f.sender, path, reference, signal, pollMs: 1 }),
    receiveLaptopArtifact({ connection: f.receiver, reference, directory: join(f.directory, "downloads"), signal, reserveBytes: 0, pollMs: 1 }),
  ]);
  assert.equal(sent.state, "receiver_verified"); assert.equal(received.sha256, sha256(bytes));
  assert.deepEqual(readFileSync(received.path), bytes);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM room_attachments").get().n, 0);
});
test("receiver restarts after a chunk checkpoint and resumes from laptop disk", async t => {
  const f = await fixture(t), path = join(f.directory, "source.bin"), bytes = Buffer.alloc(2 * 1024 ** 2, 81);
  writeFileSync(path, bytes); const signal = AbortSignal.timeout(15000);
  const reference = await offerLaptopArtifact({ connection: f.sender, path, transferId: "resume", recipientId: "producer", signal });
  const base = roomFileTransport(f.receiver); let fail = true;
  const transport = async (path, options) => {
    if (fail && options.body.action === "want" && options.body.index === 1) { fail = false; throw new Error("simulated receiver crash"); }
    return base(path, options);
  };
  const sending = serveLaptopArtifact({ connection: f.sender, path, reference, signal, pollMs: 1 });
  await assert.rejects(receiveLaptopArtifact({ connection: f.receiver, reference, directory: join(f.directory, "downloads"), signal, reserveBytes: 0, pollMs: 1, transport }), /receiver crash/);
  const received = await receiveLaptopArtifact({ connection: f.receiver, reference, directory: join(f.directory, "downloads"), signal, reserveBytes: 0, pollMs: 1 });
  assert.equal(received.sha256, sha256(bytes)); assert.equal((await sending).state, "receiver_verified");
});
test("relay validates direction, checksum, scope, quotas, revocation and expiration", () => {
  const members = { sender: { active: true }, receiver: { active: true }, outsider: { active: true } };
  const store = { room: () => ({ state: { members } }) }, bytes = Buffer.from("abc"), offer = { action: "offer", recipientId: "receiver", byteLength: 3, sha256: sha256(bytes) };
  const call = (member, data, id = "a", room = "r", now = 1000) => laptopTransfer(store, room, member, id, data, now);
  call("sender", offer);
  assert.throws(() => call("outsider", { action: "inspect" }), { status: 404 });
  assert.throws(() => call("receiver", { action: "inspect" }, "a", "other"), { status: 404 });
  assert.throws(() => call("sender", { action: "want", index: 0 }), { status: 403 });
  call("receiver", { action: "want", index: 0 });
  assert.throws(() => call("sender", { action: "put", index: 0, sha256: sha256("bad"), data: bytes.toString("base64") }), { status: 422 });
  call("sender", { action: "put", index: 0, sha256: sha256(bytes), data: bytes.toString("base64") });
  assert.equal(call("receiver", { action: "take", index: 0 }).data, bytes.toString("base64"));
  call("sender", offer, "b"); assert.throws(() => call("sender", offer, "c"), { status: 429 });
  members.receiver.active = false;
  assert.throws(() => call("sender", { action: "inspect" }), { status: 403 });
  members.receiver.active = true;
  assert.throws(() => call("receiver", { action: "inspect" }, "b", "r", 1000 + laptopTransferLimits.ttlMs), { status: 404 });
});
test("local size and free-disk policy reject before writing an input", async t => {
  const f = await fixture(t), path = join(f.directory, "source.bin"); writeFileSync(path, "data");
  const reference = await offerLaptopArtifact({ connection: f.sender, path, transferId: "policy", recipientId: "producer" });
  const directory = join(f.directory, "downloads");
  await assert.rejects(receiveLaptopArtifact({ connection: f.receiver, reference, directory, maxBytes: 1 }), /not permitted/);
  assert.equal(existsSync(directory), false);
  await assert.rejects(receiveLaptopArtifact({ connection: f.receiver, reference, directory, reserveBytes: Number.MAX_SAFE_INTEGER }), /disk headroom/);
});
test("the mounted laptop transfer route refuses unauthenticated bytes", async t => {
  const f = await fixture(t);
  const path = LAPTOP_TRANSFER_ROUTES[0].path.replace("{roomId}", "commons").replace("{transferId}", "auth-check");
  const response = await fetch(f.sender.origin + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "inspect" }) });
  assert.ok([401, 403].includes(response.status));
});
