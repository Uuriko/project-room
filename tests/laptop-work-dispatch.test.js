import test from "node:test";
import assert from "node:assert/strict";
import { laptopWorkers } from "../server/laptop-workers.mjs";
import { selectLaptopWorker } from "../client/laptop-work-dispatch.mjs";
import { advertiseLaptopWorker, discoverLaptopWorkers, dispatchLaptopTask } from "../client/laptop-work-dispatch.mjs";
import { LAPTOP_WORKER_ROUTES } from "../server/routes/laptop-workers.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { rmSync } from "node:fs";
import { join } from "node:path";

const advertisement = { version: 1, state: "available", slots: 1, maxInputBytes: 1024 ** 3,
  requesters: ["agent"], adapters: ["recipe-v1"], recipes: ["test-and-build"] };
test("agents discover only willing current workers, and select by recipe and capacity", () => {
  const members = { laptop1: { active: true }, laptop2: { active: true } }, store = { room: () => ({ state: { members } }) };
  laptopWorkers(store, "room", "laptop1", advertisement, 1000);
  laptopWorkers(store, "room", "laptop2", { ...advertisement, slots: 4 }, 1000);
  const directory = laptopWorkers(store, "room", "agent", undefined, 1000);
  assert.equal(selectLaptopWorker(directory, { adapter: "recipe-v1", recipeId: "test-and-build" }, 1000).memberId, "laptop2");
  assert.equal(laptopWorkers(store, "room", "outsider", undefined, 1000).workers.length, 0);
  assert.throws(() => selectLaptopWorker(directory, { adapter: "recipe-v1", recipeId: "unapproved" }, 1000));
  members.laptop2.active = false;
  assert.equal(laptopWorkers(store, "room", "agent", undefined, 1001).workers.length, 1);
  assert.equal(laptopWorkers(store, "room", "agent", undefined, 91000).workers.length, 0);
});
test("pause, stale advertisements and insufficient disk-input allowance prevent selection", () => {
  const store = { room: () => ({ state: { members: { laptop: { active: true } } } }) };
  laptopWorkers(store, "room", "laptop", { ...advertisement, state: "paused" }, 1000);
  assert.throws(() => selectLaptopWorker(laptopWorkers(store, "room", "agent", undefined, 1000), { adapter: "recipe-v1" }, 1000));
  const directory = laptopWorkers(store, "room", "laptop", advertisement, 1000);
  assert.throws(() => selectLaptopWorker(directory, { adapter: "recipe-v1", inputBytes: 2 * 1024 ** 3 }, 1000));
  assert.throws(() => selectLaptopWorker(directory, { adapter: "recipe-v1" }, 100000));
});
test("real worker discovery and retry keep the original dispatch recipient after lost acknowledgement", async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.dmConsents.request("commons", "reviewer", "producer", "fixture"); f.store.dmConsents.decide("commons", "producer", "reviewer", "approve");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connection = { origin, roomId: "commons", memberId: "reviewer", token: f.keys.reviewer };
  const worker = { ...connection, memberId: "producer", token: f.keys.producer };
  const path = LAPTOP_WORKER_ROUTES[0].path.replace("{roomId}", "commons");
  assert.ok([401, 403].includes((await fetch(origin + path)).status));
  await advertiseLaptopWorker(worker, { ...advertisement, requesters: ["reviewer"] });
  assert.equal((await discoverLaptopWorkers(connection)).workers[0].memberId, "producer");
  const task = { version: 1, adapter: "recipe-v1", recipeId: "test-and-build", input: {}, inputSha256: "a".repeat(64), expectedResultSha256: null };
  let lost = false;
  const broken = { ...connection, fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (!lost && options.method === "POST" && url.endsWith("/commands")) { lost = true; throw new TypeError("lost response"); }
    return response;
  } };
  const args = { task, requestId: "dispatch-1", directory: join(f.directory, "dispatch") };
  await assert.rejects(dispatchLaptopTask({ ...args, connection: broken }), /lost response/);
  await advertiseLaptopWorker(worker, { ...advertisement, requesters: ["reviewer"], state: "working" });
  const result = await dispatchLaptopTask({ ...args, connection });
  assert.equal(result.workerId, "producer"); assert.equal(result.receipt.duplicate, true);
  await assert.rejects(dispatchLaptopTask({ ...args, task: { ...task, recipeId: "changed" }, connection }), /payload changed/);
});
