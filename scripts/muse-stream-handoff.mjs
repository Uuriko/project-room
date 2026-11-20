#!/usr/bin/env node
import { on } from "node:events";
import { lstatSync, realpathSync, watch } from "node:fs";
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
const receiverReceiptNote = "Receiving runtime read and verified this exact request; model acceptance is separate.";
const fields = ["version", "origin", "roomId", "memberId", "requesters", "workItems", "requests", "bootstrapAfter", "windowSeconds"];

export function museHandoffPolicy(policy, connection) {
  if (!policy || !Object.keys(policy).every(field => fields.includes(field) || field === "allowStandaloneRequests")
    || !fields.every(field => Object.hasOwn(policy, field))
    || Object.hasOwn(policy, "allowStandaloneRequests") && typeof policy.allowStandaloneRequests !== "boolean"
    || policy.version !== 1 || ["origin", "roomId", "memberId"].some(field => policy[field] !== connection[field])
    || !ids(policy.requesters) || !policy.requesters.length || policy.requesters.includes(policy.memberId)
    || !ids(policy.workItems) || !ids(policy.requests)
    || !policy.workItems.length && !policy.requests.length && !policy.allowStandaloneRequests
    || !integer(policy.bootstrapAfter) || !integer(policy.windowSeconds) || policy.windowSeconds < 1 || policy.windowSeconds > 600)
    throw Error("invalid_muse_handoff_policy");
  return policy;
}

function matches(request, policy) {
  return request?.status === "open" && request.recipientId === policy.memberId && policy.requesters.includes(request.requesterId)
    && (policy.requests.includes(request.id) || policy.workItems.includes(request.workItemId)
      || policy.allowStandaloneRequests === true && request.workItemId === null);
}

export function museSeenAction(handoff, roomId) {
  return { tool: "room_progress_request", arguments: {
    roomId,
    requestId: `muse-seen-${handoff.openingEventId}`,
    requestMessageId: handoff.requestMessageId,
    expectedRequestRevision: handoff.requestRevision,
    progress: "acknowledged"
  } };
}

function pointer(context, candidate, policy, after, receiverAck = false) {
  const current = context.request;
  const alreadySeen = current?.acknowledgedAt || current?.progressState;
  const receiverSeen = receiverAck && current?.progressState === "acknowledged" && current.progressNote === receiverReceiptNote;
  if (context.roomId !== policy.roomId || context.viewerId !== policy.memberId || !validId(context.roomCreatedEventId)
    || !matches(current, policy) || current.id !== candidate.id || current.openingEventId !== candidate.openingEventId
    || alreadySeen && !receiverSeen || !integer(current.revision) || receiverAck && !validId(current.contextEventId)) return null;
  const opened = context.page.items.find(item => item.kind === "opened" && item.eventId === current.openingEventId);
  if (!opened || !integer(opened.sequence) || opened.sequence <= after) return null;
  return { requestMessageId: current.id, requesterId: current.requesterId, recipientId: current.recipientId,
    roomCreatedEventId: context.roomCreatedEventId, openingEventId: current.openingEventId, openingSequence: opened.sequence,
    requestRevision: current.revision, ...(receiverAck ? { contextEventId: current.contextEventId, receiverSeen } : {}) };
}

async function inspect(client, policy, after, signal, receiverAck = false) {
  let cursor, through, next;
  do {
    const page = await client.replyRequests({ direction: "incoming", status: "open", ...(cursor ? { cursor } : {}), signal });
    through ??= page.evaluatedThrough;
    for (const candidate of page.requests.filter(request => matches(request, policy) && !request.progress)) {
      const context = await client.replyContext(candidate.id, { view: "compact", signal });
      const found = pointer(context, candidate, policy, after, receiverAck);
      if (found && (!next || found.openingSequence < next.openingSequence)) next = found;
    }
    cursor = page.page?.hasMore ? page.page.nextCursor : null;
  } while (cursor);
  return { next, through };
}

export async function holdMuseHandoff({ client, policy, checkpoint, save, signal, wait = true, resumeStream = false, receiverAck = false, setWaiting = () => {} }) {
  let state = checkpoint;
  const remember = (after, inFlight = null) => { state = { after, inFlight }; save(state); };
  const offer = async handoff => {
    if (!receiverAck) return handoff;
    const ackStartedAt = new Date().toISOString();
    const { arguments: { roomId, requestId, ...data } } = museSeenAction(handoff, policy.roomId);
    // Server compare-and-set: refused unless the request is still open, unacknowledged
    // and at the exact context this receiver inspected (server/store.mjs first-ack door).
    const { contextEventId, receiverSeen, ...offered } = handoff;
    const receipt = await client.command({ id: requestId, type: "reply_request.progressed",
      data: { ...data, note: receiverReceiptNote, ifUnacknowledgedContextEventId: contextEventId } }, { signal });
    if (!validId(receipt?.event?.id) || !integer(receipt.sequence))
      throw Object.assign(Error("Unconfirmed receiver acknowledgment"), { status: 503 });
    return { ...offered, receiverAcknowledgment: { sequence: receipt.sequence, duplicate: receipt.duplicate === true,
      startedAt: ackStartedAt, confirmedAt: new Date().toISOString() } };
  };
  // A process may stop after saving the pointer and before delivering stdout.
  // Read back the same request before replaying that exact pointer.
  if (state.inFlight) {
    const saved = state.inFlight;
    const current = await client.replyContext(saved.requestMessageId, { view: "compact", signal });
    if (current.roomCreatedEventId !== saved.roomCreatedEventId || current.request.openingEventId !== saved.openingEventId)
      throw Error("muse_handoff_identity_changed");
    const recovered = pointer(current, { id: saved.requestMessageId, openingEventId: saved.openingEventId }, policy, saved.openingSequence - 1, receiverAck);
    if (recovered) {
      // Replay our own recorded acknowledgment with its original inspected context.
      if (recovered.receiverSeen && validId(saved.contextEventId)) recovered.contextEventId = saved.contextEventId;
      // Checkpoint a changed revision or exact inspected context before writing,
      // so a later restart replays this write instead of a stale saved context.
      if (recovered.requestRevision !== saved.requestRevision || recovered.contextEventId !== saved.contextEventId) {
        remember(state.after, recovered);
      }
      return offer({ status: "handoff", replay: true, after: state.after, ...recovered });
    }
    remember(state.after);
  }
  let catchUp = !resumeStream || Boolean(checkpoint.inFlight);
  for (;;) {
    signal.throwIfAborted();
    if (catchUp) {
      setWaiting(false);
      const { next, through } = await inspect(client, policy, state.after, signal, receiverAck);
      if (next) {
        remember(next.openingSequence, next);
        return offer({ status: "handoff", replay: false, after: state.after, source: "catch_up", ...next });
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
        const exact = pointer(context, hint, policy, state.after, receiverAck);
        if (!exact || exact.openingSequence !== change.sequence) break;
        remember(exact.openingSequence, exact);
        return offer({ status: "handoff", replay: false, after: state.after, source: "stream_pointer",
          streamObservedAt: hint.observedAt, pointerSavedAt: new Date().toISOString(), ...exact });
      }
      remember(change.sequence);
    }
  }
}

function loadCheckpoint(file, policy) {
  const binding = [policy.origin, policy.roomId, policy.memberId, policy.requesters, policy.workItems, policy.requests, policy.bootstrapAfter];
  // Existing configurations retain their saved cursor. Enabling a new
  // class of requests requires an explicit starting cursor in a new scope.
  if (policy.allowStandaloneRequests === true) binding.push("standalone");
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

// The host registers this process separately so it survives delivery of the
// primary helper's stdout. It has no Room stream and no recurring timer.
function sameRecoveryOffer(first, second) {
  return second && ["requestMessageId", "roomCreatedEventId", "openingEventId", "openingSequence", "requestRevision", "offeredAt"]
    .every(key => first[key] === second[key])
    && first.receiverAcknowledgment?.sequence === second.receiverAcknowledgment?.sequence;
}

export async function recoverMuseHandoff({ client, policy, signal, offers, currentOffer, record,
  graceMs = 6500, now = Date.now, delay = pause }) {
  for await (const offer of offers) {
    if (!offer) continue;
    await delay(Math.max(0, Date.parse(offer.offeredAt) + graceMs - now()), undefined, { signal });
    const pending = currentOffer();
    if (!sameRecoveryOffer(offer, pending)) continue;
    const context = await client.replyContextForHint(pending.requestMessageId, { signal });
    if (context.roomCreatedEventId !== pending.roomCreatedEventId) throw Error("muse_handoff_identity_changed");
    const receipt = pending.receiverAcknowledgment;
    const receiverAck = integer(receipt?.sequence) && receipt.sequence > pending.openingSequence;
    const exact = pointer(context, { id: pending.requestMessageId, openingEventId: pending.openingEventId },
      policy, pending.openingSequence - 1, receiverAck);
    if (!exact || exact.openingSequence !== pending.openingSequence || receiverAck && !exact.receiverSeen) continue;
    const { contextEventId, receiverSeen, ...handoff } = exact;
    if (!sameRecoveryOffer(pending, currentOffer())) continue;
    record(handoff);
    return { status: "handoff", source: "interrupted_delivery", replay: true,
      after: exact.openingSequence, originalOfferedAt: pending.offeredAt, ...handoff,
      ...(receiverAck ? { receiverAcknowledgment: receipt } : {}) };
  }
}

function readOptionalPrivate(file) {
  try { return readPrivateJson(file, 8192); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function runRecovery({ client, directory, file, policy, statusFile, signal }) {
  const receiptFile = join(directory, "recovery-receipt.json");
  const currentOffer = () => {
    const status = readOptionalPrivate(statusFile);
    if (status?.status !== "handoff" || !Number.isFinite(Date.parse(status.offeredAt))) return null;
    const pending = loadCheckpoint(file, policy).checkpoint.inFlight;
    if (!pending || pending.openingEventId !== status.openingEventId
      || pending.requestMessageId !== status.requestMessageId || pending.openingSequence !== status.openingSequence
      || readOptionalPrivate(receiptFile)?.openingEventId === pending.openingEventId) return null;
    return { ...pending, offeredAt: status.offeredAt, receiverAcknowledgment: status.receiverAcknowledgment };
  };
  const watcher = watch(directory);
  const changes = on(watcher, "change", { signal });
  try {
    const offers = (async function* () {
      yield currentOffer();
      for await (const [, name] of changes) {
        if (name === null || name === "receiver-status.json") yield currentOffer();
      }
    })();
    atomicPrivateJson(join(directory, "recovery-status.json"), { pid: process.pid, armedAt: new Date().toISOString() });
    return await recoverMuseHandoff({ client, policy, signal, offers, currentOffer,
      record: exact => atomicPrivateJson(receiptFile, { openingEventId: exact.openingEventId, retriedAt: new Date().toISOString() }) });
  } finally { await changes.return(); watcher.close(); }
}

async function main([configFile, connectionDirectory, mode, ...extra]) {
  const receiverAck = extra.length === 1 && extra[0] === "--receiver-ack" && mode === "--stay-armed";
  if (extra.length && !receiverAck || mode !== undefined && !["--once", "--stay-armed", "--recover"].includes(mode) || !isAbsolute(configFile ?? "")
    || connectionDirectory !== "-" && !isAbsolute(connectionDirectory ?? ""))
    throw Error("Usage: node scripts/muse-stream-handoff.mjs /private/handoff.json [/private/room-connection | -] [--once | --stay-armed [--receiver-ack] | --recover]");
  const directory = dirname(realpathSync(configFile));
  const connection = connectionDirectory === "-" ? await readConnectionInput() : readAgentConnection(connectionDirectory);
  assertPrivatePath(directory, true);
  const policy = museHandoffPolicy(readPrivateJson(configFile, 8192), connection);
  const owner = new WatchJournal(join(directory, mode === "--recover" ? "recovery-watch" : "watch"));
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const file = join(directory, "stream-checkpoint.json"), client = new RoomAgentClient(connection);
    const statusFile = join(directory, "receiver-status.json");
    const result = mode === "--recover"
      ? await runRecovery({ client, directory, file, policy, statusFile, signal: stop.signal })
      : await runMuseHandoff({ mode, windowMs: policy.windowSeconds * 1000, stop: stop.signal,
        onRollover: facts => atomicPrivateJson(statusFile, { status: "rolled_over", pid: process.pid, ...facts }),
        run: (signal, progress) => holdMuseHandoff({ client, policy, ...loadCheckpoint(file, policy), ...progress,
          signal, receiverAck, wait: mode !== "--once" }) });
    if (mode === "--stay-armed") {
      if (result.status === "handoff") result.offeredAt = new Date().toISOString();
      atomicPrivateJson(statusFile, { pid: process.pid, ...result });
    }
    if (result.status === "handoff" && !result.receiverAcknowledgment) result.seenAction = museSeenAction(result, policy.roomId);
    console.log(JSON.stringify(result));
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); owner.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error.handoffStage ? `${error.handoffStage}: ${error.code ?? error.name}` : error.code ?? error.message);
    process.exitCode = 1;
  });
