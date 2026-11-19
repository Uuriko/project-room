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

export async function holdMuseHandoff({ client, policy, checkpoint, save, signal, wait = true }) {
  let state = checkpoint;
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
        state = { after: state.after, inFlight: recovered };
        save(state);
      }
      return { status: "handoff", replay: true, after: state.after, ...recovered };
    }
    state = { after: state.after, inFlight: null };
    save(state);
  }
  for (;;) {
    signal.throwIfAborted();
    const { next, through } = await inspect(client, policy, state.after, signal);
    if (next) {
      state = { after: next.openingSequence, inFlight: next };
      save(state);
      return { status: "handoff", replay: false, after: state.after, ...next };
    }
    if (integer(through) && through > state.after) {
      state = { after: through, inFlight: null };
      save(state);
    }
    if (!wait) return { status: "no_work", after: state.after };
    for (;;) {
      signal.throwIfAborted();
      let change;
      try { change = await client.waitForChange(state.after, { timeoutMs: 12000, signal }); }
      catch (error) { throw Object.assign(error, { handoffStage: "room_stream" }); }
      if (change.changed) break; // The stream is a hint. Reread the scoped formal list.
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

async function main([configFile, connectionDirectory, mode, ...extra]) {
  if (extra.length || mode !== undefined && mode !== "--once" || !isAbsolute(configFile ?? "")
    || connectionDirectory !== "-" && !isAbsolute(connectionDirectory ?? ""))
    throw Error("Usage: node scripts/muse-stream-handoff.mjs /private/handoff.json [/private/room-connection | -] [--once]");
  const directory = dirname(realpathSync(configFile));
  const connection = connectionDirectory === "-" ? await readConnectionInput() : readAgentConnection(connectionDirectory);
  assertPrivatePath(directory, true);
  const policy = museHandoffPolicy(readPrivateJson(configFile, 8192), connection);
  const owner = new WatchJournal(join(directory, "watch"));
  const stop = new AbortController(), window = AbortSignal.timeout(policy.windowSeconds * 1000);
  const signal = AbortSignal.any([stop.signal, window]);
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const file = join(directory, "stream-checkpoint.json"), client = new RoomAgentClient(connection);
    for (;;) {
      try {
        const result = await holdMuseHandoff({ client, policy, ...loadCheckpoint(file, policy), signal, wait: mode !== "--once" });
        console.log(JSON.stringify(result));
        return;
      } catch (error) {
        if (signal.aborted) {
          console.log(JSON.stringify({ status: window.aborted ? "quiet_expired" : "stopped" }));
          return;
        }
        if (!(error instanceof TypeError) && error.name !== "TimeoutError" && ![429, 500, 502, 503, 504].includes(error.status)) throw error;
        await pause(1000, undefined, { signal }).catch(() => {});
      }
    }
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); owner.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error.handoffStage ? `${error.handoffStage}: ${error.code ?? error.name}` : error.code ?? error.message);
    process.exitCode = 1;
  });
