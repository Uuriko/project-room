#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { openRequestJournal, runRequestQueue } from "../client/request-runner.mjs";
import { WatchJournal } from "../client/watch-journal.mjs";
import { assertPrivatePath, readPrivateJson } from "../room-acp/src/private-files.mjs";
import { validId } from "../src/events.js";
import { collectAffectedEvidence } from "./desktop-affected.mjs";

const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const fields = ["version", "origin", "roomId", "memberId", "worktree", "workItemId", "head", "base", "requesters"];
const refusals = new Set(["worktree_mismatch", "checkout_not_pinned_clean_head", "baseline_not_ancestor"]);

export function affectedRequestHost(policy) {
  if (!policy || Object.keys(policy).length !== fields.length || !fields.every(key => Object.hasOwn(policy, key))
    || policy.version !== 1 || !validId(policy.roomId) || !validId(policy.memberId) || !validId(policy.workItemId)
    || !sha(policy.head) || !sha(policy.base) || typeof policy.worktree !== "string" || !isAbsolute(policy.worktree)
    || !Array.isArray(policy.requesters) || !policy.requesters.length || policy.requesters.length > 20
    || new Set(policy.requesters).size !== policy.requesters.length || !policy.requesters.every(validId))
    throw Error("invalid_local_affected_policy");
  const worktree = realpathSync(policy.worktree);
  const allowRequest = request => request.recipientId === policy.memberId && policy.requesters.includes(request.requesterId);
  const selectRequest = request => request.workItemId === policy.workItemId;
  const body = `mac affected ${policy.head}`;
  const execute = async ({ request, messages, preparation, signal }) => {
    const opened = messages.find(item => item.kind === "opened" && item.eventId === request.openingEventId);
    if (!allowRequest(request) || !selectRequest(request) || request.contextEventId !== request.openingEventId
      || opened?.message?.authorId !== request.requesterId || opened.message?.body !== body
      || preparation.work?.id !== policy.workItemId || !Number.isSafeInteger(preparation.work.revision)) {
      return { body: JSON.stringify({ kind: "desktop_affected_tests", status: "refused", reason: "expected_exact_opening_command" }) };
    }
    try {
      const result = await collectAffectedEvidence({ worktree, base: policy.base, expectedHead: policy.head,
        workRevision: preparation.work.revision, signal });
      return { body: JSON.stringify(result) };
    } catch (error) {
      signal.throwIfAborted();
      return { body: JSON.stringify({ kind: "desktop_affected_tests", status: "refused",
        reason: refusals.has(error.message) ? error.message : "local_check_unavailable" }) };
    }
  };
  return { allowRequest, selectRequest, execute };
}

async function main([path, connectionDirectory, ...extra]) {
  if (extra.length || !isAbsolute(path ?? "") || !isAbsolute(connectionDirectory ?? ""))
    throw Error("Usage: node scripts/run-desktop-affected-room.mjs /absolute/private/affected.json /absolute/connection-directory");
  const directory = dirname(realpathSync(path));
  assertPrivatePath(directory, true);
  const policy = readPrivateJson(path, 8192);
  const connection = readAgentConnection(connectionDirectory);
  if (["origin", "roomId", "memberId"].some(key => policy[key] !== connection[key])) throw Error("room_connection_changed");
  const host = affectedRequestHost(policy);
  const owner = new WatchJournal(join(directory, "watch"));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let db;
  try {
    const journal = join(directory, "requests.sqlite");
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { assertPrivatePath(journal + suffix); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    db = openRequestJournal(journal);
    let ready = false;
    await runRequestQueue({ connection, db, ...host, signal: controller.signal, intervalMs: 2000,
      onPoll: () => {
        if (!ready) console.log(JSON.stringify({ status: "watching", workItemId: policy.workItemId, head: policy.head }));
        ready = true;
      },
      emit: event => console.log(JSON.stringify({ status: event.status, requestId: event.requestId,
        requestMessageId: event.receipt?.requestMessageId ?? event.requestMessageId,
        sequence: event.receipt?.sequence, hostExecuted: event.hostExecuted })),
    });
  } finally {
    db?.close(); owner.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
