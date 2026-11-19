#!/usr/bin/env node
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readAgentConnection, readConnectionInput } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { assertPrivatePath, atomicPrivateJson, readPrivateJson } from "../room-acp/src/private-files.mjs";
import { validId } from "../src/events.js";

const integer = value => Number.isSafeInteger(value) && value >= 0;
const ids = value => Array.isArray(value) && value.length <= 20 && new Set(value).size === value.length && value.every(validId);
const fields = ["version", "origin", "roomId", "memberId", "requesters", "workItems", "requests", "bootstrapAfter", "windowSeconds"];

export function museHandoffPolicy(policy, connection) {
  if (!policy || Object.keys(policy).length !== fields.length || !fields.every(field => Object.hasOwn(policy, field))
    || policy.version !== 1 || ["origin", "roomId", "memberId"].some(field => policy[field] !== connection[field])
    || !ids(policy.requesters) || !policy.requesters.length || policy.requesters.includes(policy.memberId)
    || !ids(policy.workItems) || !ids(policy.requests) || !policy.workItems.length && !policy.requests.length
    || !integer(policy.bootstrapAfter) || !integer(policy.windowSeconds) || policy.windowSeconds < 1 || policy.windowSeconds > 600)
    throw Error("invalid_muse_handoff_policy");
  return policy;
}

function matches(request, policy) {
  return request?.status === "open" && request.recipientId === policy.memberId && policy.requesters.includes(request.requesterId)
    && (policy.requests.includes(request.id) || policy.workItems.includes(request.workItemId));
}

function pointer(context, candidate, policy, after) {
  const current = context.request;
  if (context.roomId !== policy.roomId || context.viewerId !== policy.memberId || !validId(context.roomCreatedEventId)
    || !matches(current, policy) || current.id !== candidate.id || current.openingEventId !== candidate.openingEventId
    || current.acknowledgedAt || current.progressState || !integer(current.revision)) return null;
  const opened = context.page.items.find(item => item.kind === "opened" && item.eventId === current.openingEventId);
  if (!opened || !integer(opened.sequence) || opened.sequence <= after) return null;
  return { requestMessageId: current.id, requesterId: current.requesterId, recipientId: current.recipientId,
    roomCreatedEventId: context.roomCreatedEventId, openingEventId: current.openingEventId, openingSequence: opened.sequence,
    requestRevision: current.revision };
}

async function inspect(client, policy, after, signal) {
  let cursor, through, next;
  do {
    const page = await client.replyRequests({ direction: "incoming", status: "open", ...(cursor ? { cursor } : {}), signal });
    through ??= page.evaluatedThrough;
    for (const candidate of page.requests.filter(request => matches(request, policy) && !request.progress)) {
      const context = await client.replyContext(candidate.id, { view: "compact", signal });
      const found = pointer(context, candidate, policy, after);
      if (found && (!next || found.openingSequence < next.openingSequence)) next = found;
    }
    cursor = page.page?.hasMore ? page.page.nextCursor : null;
  } while (cursor);
  return { next, through };
}

export async function holdMuseHandoff({ client, policy, checkpoint, save, signal, wait = true, resumeStream = false, setWaiting = () => {} }) {
  let state = checkpoint;
  const remember = (after, inFlight = null) => { state = { after, inFlight }; save(state); };
  // A process may stop after saving the pointer and before delivering stdout.
  // Read back the same request before replaying that exact pointer.
  if (state.inFlight) {
    const saved = state.inFlight;
    const current = await client.replyContext(saved.requestMessageId, { view: "compact", signal });
    if (current.roomCreatedEventId !== saved.roomCreatedEventId || current.request.openingEventId !== saved.openingEventId)
      throw Error("muse_handoff_identity_changed");
    const recovered = pointer(current, { id: saved.requestMessageId, openingEventId: saved.openingEventId }, policy, saved.openingSequence - 1);
    if (recovered) {
      if (recovered.requestRevision !== saved.requestRevision) {
        remember(state.after, recovered);
      }
      return { status: "handoff", replay: true, after: state.after, ...recovered };
    }
    remember(state.after);
  }
  let catchUp = !resumeStream || Boolean(checkpoint.inFlight);
  for (;;) {
    signal.throwIfAborted();
    if (catchUp) {
      setWaiting(false);
      const { next, through } = await inspect(client, policy, state.after, signal);
      if (next) {
        remember(next.openingSequence, next);
        return { status: "handoff", replay: false, after: state.after, source: "catch_up", ...next };
      }
      if (integer(through) && through > state.after) remember(through);
    }
    if (!wait) return { status: "no_work", after: state.after };
    catchUp = true;
    setWaiting(true);
    for (;;) {
      signal.throwIfAborted();
      let change;
      try { change = await client.waitForChange(state.after, { timeoutMs: 12000, requestHints: true, signal }); }
      catch (error) { throw Object.assign(error, { handoffStage: "room_stream" }); }
      if (!change.changed) {
        if (integer(change.through) && change.through > state.after) remember(change.through);
        continue;
      }
      const hint = change.requestHint;
      if (!hint) break; // Older, incomplete or lagging streams use the scoped catch-up read.
      if (matches({ ...hint, status: "open" }, policy)) {
        setWaiting(false);
        const context = await client.replyContextForHint(hint.id, { signal });
        const exact = pointer(context, hint, policy, state.after);
        if (!exact || exact.openingSequence !== change.sequence) break;
        remember(exact.openingSequence, exact);
        return { status: "handoff", replay: false, after: state.after, source: "stream_pointer",
          streamObservedAt: hint.observedAt, pointerSavedAt: new Date().toISOString(), ...exact };
      }
      remember(change.sequence);
    }
  }
}

function loadCheckpoint(file, policy) {
  const binding = [policy.origin, policy.roomId, policy.memberId, policy.requesters, policy.workItems, policy.requests, policy.bootstrapAfter];
  let value;
  try { lstatSync(file); value = readPrivateJson(file, 8192); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    value = { version: 1, binding, after: policy.bootstrapAfter, inFlight: null };
  }
  if (!value || Array.isArray(value)) throw Error("invalid_muse_handoff_checkpoint");
  const p = value.inFlight;
  if (value.version !== 1 || JSON.stringify(value.binding) !== JSON.stringify(binding) || !integer(value.after)
    || p !== null && (!p || p.openingSequence !== value.after || !integer(p.requestRevision)
      || ![p.requestMessageId, p.requesterId, p.recipientId, p.openingEventId, p.roomCreatedEventId].every(validId)))
    throw Error("invalid_muse_handoff_checkpoint");
  return { checkpoint: { after: value.after, inFlight: p },
    save: state => atomicPrivateJson(file, { version: 1, binding, ...state }) };
}

export async function runMuseHandoff({ mode, windowMs, stop, run, onRollover = () => {}, makeWindow = AbortSignal.timeout }) {
  const startedAt = new Date().toISOString();
  let quietWindows = 0, lastQuietAt = null, resumeStream = false;
  const facts = () => ({ startedAt, quietWindows, lastQuietAt });
  for (;;) {
    const window = makeWindow(windowMs), signal = AbortSignal.any([stop, window]);
    for (;;) {
      let waiting = false;
      try {
        const result = await run(signal, { resumeStream, setWaiting(value) { waiting = value; } });
        return { ...result, ...facts() };
      } catch (error) {
        if (stop.aborted) return { status: "stopped", ...facts() };
        if (window.aborted) {
          quietWindows++;
          lastQuietAt = new Date().toISOString();
          if (mode !== "--stay-armed") return { status: "quiet_expired", ...facts() };
          resumeStream = waiting;
          onRollover(facts());
          break; // Keep the same process and lock. No host completion wakes a model here.
        }
        if (!(error instanceof TypeError) && error.name !== "TimeoutError" && ![429, 500, 502, 503, 504].includes(error.status)) throw error;
        resumeStream = false;
        await pause(1000, undefined, { signal }).catch(() => {});
      }
    }
  }
}

async function main([configFile, connectionDirectory, mode, ...extra]) {
  if (extra.length || mode !== undefined && !["--once", "--stay-armed"].includes(mode) || !isAbsolute(configFile ?? "")
    || connectionDirectory !== "-" && !isAbsolute(connectionDirectory ?? ""))
    throw Error("Usage: node scripts/muse-stream-handoff.mjs /private/handoff.json [/private/room-connection | -] [--once | --stay-armed]");
  const directory = dirname(realpathSync(configFile));
  const connection = connectionDirectory === "-" ? await readConnectionInput() : readAgentConnection(connectionDirectory);
  assertPrivatePath(directory, true);
  const policy = museHandoffPolicy(readPrivateJson(configFile, 8192), connection);
  const owner = new WatchJournal(join(directory, "watch"));
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const file = join(directory, "stream-checkpoint.json"), client = new RoomAgentClient(connection);
    const statusFile = join(directory, "receiver-status.json");
    const result = await runMuseHandoff({ mode, windowMs: policy.windowSeconds * 1000, stop: stop.signal,
      onRollover: facts => atomicPrivateJson(statusFile, { status: "rolled_over", pid: process.pid, ...facts }),
      run: (signal, progress) => holdMuseHandoff({ client, policy, ...loadCheckpoint(file, policy), ...progress,
        signal, wait: mode !== "--once" }) });
    if (mode === "--stay-armed") atomicPrivateJson(statusFile, { pid: process.pid, ...result });
    if (result.status === "handoff") {
      result.seenAction = { tool: "room_progress_request", arguments: {
        roomId: policy.roomId,
        requestId: `muse-seen-${result.openingEventId}`,
        requestMessageId: result.requestMessageId,
        expectedRequestRevision: result.requestRevision,
        progress: "acknowledged"
      } };
    }
    console.log(JSON.stringify(result));
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); owner.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error.handoffStage ? `${error.handoffStage}: ${error.code ?? error.name}` : error.code ?? error.message);
    process.exitCode = 1;
  });
