import { readFileSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sha256, exactObject, privateDirectory, savePrivate, downloadArtifact, uploadArtifact, roomFileTransport, artifactLimits } from "./room-artifact-transfer.mjs";
import { RoomAgentClient } from "./room-agent.mjs";
import { openRequestJournal, runRequestOnce } from "./request-runner.mjs";
import { receiveLaptopArtifact } from "./laptop-artifacts.mjs";
import { observeLaptop, laptopBudget } from "./laptop-resources.mjs";
import { runLaptopRecipe, validateRecipe } from "./laptop-recipes.mjs";
import { advertiseLaptopWorker } from "./laptop-work-dispatch.mjs";

export const taskPrefix = "Project Room task v1\n";
const ensure = (yes, reason) => { if (!yes) throw new Error(reason); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function readWorkerGrant(path, connection, now = Date.now()) {
  const grant = JSON.parse(readFileSync(path, "utf8"));
  ensure(grant.version === 1 && grant.origin === connection.origin && grant.roomId === connection.roomId
    && grant.memberId === connection.memberId && Array.isArray(grant.requesters) && grant.requesters.length > 0
    && grant.requesters.every(value => typeof value === "string") && Array.isArray(grant.adapters)
    && grant.adapters.every(value => ["sha256-v1", "json-summary-v1", "node-test-v1", "recipe-v1"].includes(value))
    && Number.isSafeInteger(grant.maxInputBytes) && grant.maxInputBytes > 0 && grant.maxInputBytes <= 64 * 1024 ** 3
    && Number.isSafeInteger(grant.timeoutMs) && grant.timeoutMs >= 100 && grant.timeoutMs <= 3600000
    && grant.maxConcurrentJobs === 1 && typeof grant.paused === "boolean"
    && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now, "Worker grant invalid or expired");
  return grant;
}
export function parseTask(body) {
  ensure(typeof body === "string" && body.startsWith(taskPrefix) && body.length <= 4096, "Not a Room-native task");
  const task = JSON.parse(body.slice(taskPrefix.length));
  ensure(exactObject(task, ["version", "adapter", "input", "inputSha256", "expectedResultSha256", ...(task.adapter === "recipe-v1" ? ["recipeId"] : [])]) && task.version === 1
    && ["sha256-v1", "json-summary-v1", "node-test-v1", "recipe-v1"].includes(task.adapter)
    && (task.adapter !== "recipe-v1" || /^[a-z][a-z0-9-]{0,63}$/.test(task.recipeId))
    && digest(task.inputSha256) && (task.expectedResultSha256 === null || digest(task.expectedResultSha256)), "Invalid task contract");
  return task;
}
function taskFromContext(context) {
  const opening = context.page.items.find(item => item.message?.id === context.request.id)?.message;
  ensure(opening && opening.authorId === context.request.requesterId, "Opening task message unavailable");
  return parseTask(opening.body);
}
function admit(grant, request, task) {
  ensure(!grant.paused && grant.requesters.includes(request.requesterId) && grant.adapters.includes(task.adapter), "Task not permitted by local grant");
  if (task.adapter === "recipe-v1") ensure(grant.recipes?.some(recipe => recipe.id === task.recipeId), "Recipe not permitted by local grant");
}

async function nodeTest(grant, inputPath, signal) {
  const adapter = grant.nodeTest;
  ensure(adapter && isAbsolute(adapter.path) && digest(adapter.sha256)
    && sha256(readFileSync(adapter.path)) === adapter.sha256 && statSync(adapter.path).isFile(), "Local test adapter pin mismatch");
  // Only locally pinned code executes. Uploaded bytes are an input file; neither
  // the command, cwd, arguments nor environment is provided by a Room message.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", adapter.path], {
      detached: true, cwd: join(inputPath, ".."), stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", ROOM_TASK_INPUT: inputPath },
    });
    let output = "", capped = false, stopped = false;
    const stop = () => { stopped = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } };
    const collect = bytes => { if (Buffer.byteLength(output) + bytes.length > 65536) { capped = true; stop(); } else output += bytes.toString("utf8"); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", error => { signal.removeEventListener("abort", stop); reject(error); });
    child.once("close", code => {
      signal.removeEventListener("abort", stop);
      resolve({ adapter: "node-test-v1", exitCode: code, passed: code === 0 && !capped && !stopped, output, capped, interrupted: stopped });
    });
  });
}

export async function executeAdapter({ task, bytes, inputFile, grant, directory, signal }) {
  const byteLength = inputFile?.byteLength ?? bytes.length, inputDigest = inputFile?.sha256 ?? sha256(bytes);
  ensure(byteLength <= grant.maxInputBytes && inputDigest === task.inputSha256, "Input acceptance failed");
  signal?.throwIfAborted();
  if (task.adapter === "sha256-v1") return { adapter: task.adapter, sha256: inputDigest, byteLength };
  if (task.adapter === "json-summary-v1") {
    ensure(byteLength <= artifactLimits.bytes, "JSON summary exceeds in-memory parser limit; use a pinned streaming adapter");
    bytes ??= readFileSync(inputFile.path);
    const value = JSON.parse(bytes.toString("utf8"));
    return { adapter: task.adapter, sha256: sha256(bytes), byteLength: bytes.length,
      type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      entries: value !== null && typeof value === "object" ? Object.keys(value).length : null };
  }
  const inputPath = inputFile?.path ?? join(directory, "input.bin"); if (!inputFile) savePrivate(inputPath, bytes);
  if (task.adapter === "recipe-v1") {
    const recipe = grant.recipes?.find(value => value.id === task.recipeId);
    const cpuSlots = grant.resourcePolicy ? Math.max(1, laptopBudget(observeLaptop(directory), grant.resourcePolicy).slots ?? 1) : 1;
    return runLaptopRecipe({ recipe, inputPath, directory: join(directory, "recipe"), cpuSlots,
      signal: AbortSignal.any([AbortSignal.timeout(grant.timeoutMs), ...(signal ? [signal] : [])]) });
  }
  ensure(task.adapter === "node-test-v1", "Unsupported adapter");
  return nodeTest(grant, inputPath, AbortSignal.any([AbortSignal.timeout(grant.timeoutMs), ...(signal ? [signal] : [])]));
}

export function workerStatus(directory, now = Date.now()) {
  try {
    const status = JSON.parse(readFileSync(join(directory, "status.json"), "utf8"));
    return { ...status, fresh: Number.isSafeInteger(status.at) && now >= status.at && now - status.at < 90000 };
  } catch { return { state: "offline", fresh: false }; }
}

// One journal, one admission lock, and the existing service request reservation.
// No second scheduler and no automatic takeover of an ambiguous execution.
export async function runNativeRequest({ connection, requestMessageId, grantPath, directory, signal }) {
  privateDirectory(directory);
  const lock = join(directory, "admission.lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Worker busy or interrupted; inspect the original attempt before clearing its lock"); throw error; }
  const status = state => savePrivate(join(directory, "status.json"), JSON.stringify({ version: 1, at: Date.now(), state, requestMessageId }));
  const db = openRequestJournal(join(directory, "requests.sqlite"));
  try {
    const client = new RoomAgentClient(connection);
    const context = await client.replyContext(requestMessageId, { limit: 50, signal });
    const task = taskFromContext(context);
    const publishResult = async record => {
      const { binding, result, task: originalTask, resultSha256, accepted, requesterId } = record;
      const resultBytes = Buffer.from(JSON.stringify(result));
      ensure(sha256(resultBytes) === resultSha256 && binding.origin === connection.origin && binding.roomId === connection.roomId
        && binding.memberId === connection.memberId && binding.requestMessageId === requestMessageId
        && requesterId === context.request.requesterId, "Saved result binding mismatch");
      const messageId = `output-${binding.attemptId}`, transport = roomFileTransport(connection);
      await transport("/commands", { method: "POST", signal, body: {
        id: messageId, type: "message.posted", data: { messageId, toMemberId: requesterId,
          body: `Task output for ${requestMessageId}. Execution finished; request reply and acceptance are separate.` },
      } });
      const output = await uploadArtifact({ connection, bytes: resultBytes, operationId: binding.attemptId, messageId, signal });
      return JSON.stringify({ version: 1, adapter: originalTask.adapter, inputSha256: originalTask.inputSha256,
        resultSha256, output, accepted, execution: result.passed === false ? "failed" : "finished",
        modelUsage: ["node-test-v1", "recipe-v1"].includes(originalTask.adapter) ? "not_measured" : false,
        ...(result.state === "needs_agent" ? { handback: { state: "needs_agent", question: result.question } } : {}) });
    };
    // An interrupted output upload can be resumed from a durable local result.
    // Never reconstruct missing execution evidence or silently change its basis.
    for (const row of db.prepare("SELECT * FROM request_runs WHERE response IS NULL").all()) {
      const path = join(directory, `${row.attempt_id}.json`);
      if (!existsSync(path)) continue;
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (record.binding?.requestMessageId !== requestMessageId) continue;
      ensure(record.binding.requestId === row.id && record.binding.attemptId === row.attempt_id
        && record.binding.roomCreatedEventId === context.roomCreatedEventId && record.binding.openingEventId === context.request.openingEventId
        && record.binding.expectedRequestRevision === context.current.answerBasis?.expectedRequestRevision
        && record.binding.contextEventId === context.current.answerBasis?.contextEventId, "Saved result needs request reconciliation");
      const body = await publishResult(record);
      db.prepare("UPDATE request_runs SET response=? WHERE id=? AND response IS NULL").run(JSON.stringify({ requestId: row.id,
        responseToRequestId: requestMessageId, ...context.current.answerBasis, responseOutcome: "answered",
        toMemberId: context.request.requesterId, workItemId: context.request.workItemId, body }), row.id);
    }
    // Saved results remain deliverable after a local execution-only pause or
    // expiry. Server access and exact request basis are still rechecked.
    const saved = db.prepare("SELECT response FROM request_runs WHERE json_extract(response,'$.responseToRequestId')=?").get(requestMessageId);
    let grant;
    if (!saved) { grant = readWorkerGrant(grantPath, connection); admit(grant, context.request, task); }
    status("received");
    let input;
    const preflight = async () => {
      grant = readWorkerGrant(grantPath, connection); admit(grant, context.request, task);
      if (grant.resourcePolicy) ensure(laptopBudget(observeLaptop(directory), grant.resourcePolicy).available, "Local resources unavailable");
      if (task.input?.kind === "laptop") {
        input = { file: await receiveLaptopArtifact({ connection, reference: task.input, directory: join(directory, "cache"), signal, maxBytes: grant.maxInputBytes }) };
        ensure(input.file.sha256 === task.inputSha256, "Input acceptance failed");
      } else {
        input = await downloadArtifact({ connection, reference: task.input, directory: join(directory, "cache"), signal });
        ensure(input.bytes.length <= grant.maxInputBytes && input.manifest.sha256 === task.inputSha256, "Input acceptance failed");
      }
      if (task.adapter === "node-test-v1") ensure(grant.nodeTest && digest(grant.nodeTest.sha256)
        && sha256(readFileSync(grant.nodeTest.path)) === grant.nodeTest.sha256, "Local test adapter pin mismatch");
      if (task.adapter === "recipe-v1") validateRecipe(grant.recipes.find(value => value.id === task.recipeId));
      grant = readWorkerGrant(grantPath, connection); admit(grant, context.request, task);
    };
    const execute = async (prepared, { binding }) => {
      // Reject an edited opening task even if the preparatory read was valid.
      const opening = prepared.messages.find(item => item.message?.id === requestMessageId)?.message;
      ensure(opening && JSON.stringify(parseTask(opening.body)) === JSON.stringify(task), "Task changed during admission");
      const current = readWorkerGrant(grantPath, connection); admit(current, prepared.request, task);
      status("running");
      if (current.resourcePolicy) ensure(laptopBudget(observeLaptop(directory), current.resourcePolicy).available, "Local resources unavailable");
      const runDirectory = join(directory, binding.attemptId); privateDirectory(runDirectory);
      const result = await executeAdapter({ task, bytes: input.bytes, inputFile: input.file, grant: current, directory: runDirectory, signal: prepared.signal });
      const resultBytes = Buffer.from(JSON.stringify(result)), resultSha256 = sha256(resultBytes);
      const accepted = task.expectedResultSha256 !== null && task.expectedResultSha256 === resultSha256 && result.passed !== false;
      const record = { binding, task, result, resultSha256, accepted, requesterId: prepared.request.requesterId };
      savePrivate(join(directory, `${binding.attemptId}.json`), JSON.stringify(record));
      status("result_saved");
      // A private message is a stable attachment anchor. It is never reported
      // as task completion; that remains the request runner's checked reply.
      const body = await publishResult(record);
      status(accepted ? "verified" : "finished_unverified");
      return { body };
    };
    const result = await runRequestOnce({ connection, requestMessageId, db, execute, preflight, signal });
    status("delivered"); return result;
  } catch (error) { status("needs_attention"); throw error; }
  finally { db.close(); rmSync(lock, { recursive: true }); }
}

export async function watchNativeRequests({ connection, grantPath, directory, signal, emit = () => {}, intervalMs = 15000 }) {
  ensure(Number.isSafeInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 60000, "Invalid worker interval");
  privateDirectory(directory);
  const client = new RoomAgentClient(connection);
  while (!signal?.aborted) {
    try {
      const work = await client.agentWork({ signal });
      const publishAvailability = async state => {
        const grant = readWorkerGrant(grantPath, connection);
        const budget = grant.resourcePolicy ? laptopBudget(observeLaptop(directory), grant.resourcePolicy) : { available: true, slots: 1 };
        return advertiseLaptopWorker(connection, { version: 1, state: grant.paused ? "paused" : state,
          slots: state === "available" && budget.available && !grant.paused ? 1 : 0,
          maxInputBytes: grant.maxInputBytes, adapters: grant.adapters, recipes: grant.recipes?.map(recipe => recipe.id) ?? [], requesters: grant.requesters }, { signal });
      };
      for (const request of work.requests.slice(0, 50)) {
        if (Object.hasOwn(work.blockedBy ?? {}, request.id)) continue;
        const context = await client.replyContext(request.id, { limit: 50, signal });
        try { taskFromContext(context); } catch { continue; }
        if (work.runs[request.id]?.state === "needs_attention") continue;
        try { await publishAvailability("working"); emit(await runNativeRequest({ connection, requestMessageId: request.id, grantPath, directory, signal })); }
        catch { emit({ state: "needs_attention", requestMessageId: request.id }); }
      }
      if (!existsSync(join(directory, "admission.lock"))) {
        const grant = readWorkerGrant(grantPath, connection);
        savePrivate(join(directory, "presence.json"), JSON.stringify({ at: Date.now(), state: grant.paused ? "paused" : "available", adapters: grant.adapters }));
        await publishAvailability("available");
      }
    } catch { emit({ state: "connection_or_grant_unavailable" }); }
    await delay(intervalMs, undefined, { signal }).catch(() => {});
  }
}
