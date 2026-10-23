import { RoomAgentClient } from "./room-agent.mjs";
import { roomFileTransport } from "./room-artifact-transfer.mjs";
import { readFileSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory, sha256 } from "./room-artifact-transfer.mjs";
export async function discoverLaptopWorkers(connection, { signal } = {}) {
  return roomFileTransport(connection)("/laptop-workers", { signal });
}
export async function advertiseLaptopWorker(connection, advertisement, { signal } = {}) {
  return roomFileTransport(connection)("/laptop-workers", { method: "POST", body: advertisement, signal });
}
export function selectLaptopWorker(directory, { adapter, recipeId, inputBytes = 0, recipientId }, now = Date.now()) {
  const eligible = (directory?.workers ?? []).filter(worker => worker.roomId && worker.state === "available" && worker.slots > 0
    && Number.isSafeInteger(worker.observedAt) && worker.observedAt <= now && worker.expiresAt > now
    && now - worker.observedAt < 90000 && worker.maxInputBytes >= inputBytes && worker.adapters.includes(adapter)
    && (!recipeId || worker.recipes.includes(recipeId)) && (!recipientId || worker.memberId === recipientId));
  eligible.sort((a, b) => b.slots - a.slots || a.memberId.localeCompare(b.memberId));
  if (!eligible.length) throw new Error("No eligible laptop is currently available");
  return eligible[0];
}
export async function dispatchLaptopTask({ connection, task, requestId, directory: stateDirectory, signal }) {
  if (typeof requestId !== "string" || !requestId) throw new Error("A stable operation ID is required");
  if (typeof stateDirectory !== "string") throw new Error("A private dispatch journal directory is required");
  privateDirectory(stateDirectory);
  const path = join(stateDirectory, sha256(JSON.stringify([connection.origin, connection.roomId, connection.memberId, requestId])) + ".json");
  const body = "Project Room task v1\n" + JSON.stringify(task);
  let plan;
  if (existsSync(path)) {
    plan = JSON.parse(readFileSync(path, "utf8"));
    if (plan.requestId !== requestId || plan.body !== body) throw new Error("Dispatch operation payload changed");
  } else {
    const directory = await discoverLaptopWorkers(connection, { signal });
    const worker = selectLaptopWorker(directory, { adapter: task.adapter, recipeId: task.recipeId,
      inputBytes: task.input?.kind === "laptop" ? task.input.byteLength : 0,
      recipientId: task.input?.kind === "laptop" ? task.input.recipientId : undefined });
    plan = { requestId, toMemberId: worker.memberId, body };
    let fd;
    try { fd = openSync(path, "wx", 0o600); writeFileSync(fd, JSON.stringify(plan)); fsyncSync(fd); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      plan = JSON.parse(readFileSync(path, "utf8"));
      if (plan.requestId !== requestId || plan.body !== body) throw new Error("Dispatch operation payload changed");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const receipt = await new RoomAgentClient(connection).replyAction("room_request_reply", plan, { signal });
  return { workerId: plan.toMemberId, receipt, status: "submitted", execution: "not_observed" };
}
