#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { assertPrivatePath, atomicPrivateJson, openNewPrivateFile, readPrivateJson } from "../room-acp/src/private-files.mjs";
import { validId } from "../src/events.js";

const scope = "https://www.googleapis.com/auth/gmail.send";
const fields = ["origin", "roomId", "senderMemberId", "recipientMemberId", "senderEmail", "museEmail", "notBefore", "workItems", "requests"];
const email = /^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const uniqueIds = value => Array.isArray(value) && value.length <= 30
  && new Set(value).size === value.length && value.every(validId);

export function validateMuseWakePolicy(policy, connection) {
  if (!policy || Object.keys(policy).length !== fields.length || !fields.every(key => Object.hasOwn(policy, key))
    || policy.origin !== connection.origin || policy.roomId !== connection.roomId || policy.senderMemberId !== connection.memberId
    || !validId(policy.recipientMemberId) || policy.recipientMemberId === policy.senderMemberId
    || ![policy.senderEmail, policy.museEmail].every(value => typeof value === "string" && email.test(value))
    || !policy.museEmail.toLowerCase().endsWith("@muse.ai") || typeof policy.notBefore !== "string" || !Number.isFinite(Date.parse(policy.notBefore))
    || !uniqueIds(policy.workItems) || !uniqueIds(policy.requests) || !policy.workItems.length && !policy.requests.length)
    throw Error("invalid_local_muse_wake_policy");
  return policy;
}

function selected(request, policy) {
  return request.status === "open" && request.requesterId === policy.senderMemberId && request.recipientId === policy.recipientMemberId
    && Date.parse(request.createdAt) >= Date.parse(policy.notBefore)
    && (policy.requests.includes(request.id) || policy.workItems.includes(request.workItemId));
}

export function createWakeJournal(directory) {
  assertPrivatePath(directory, true);
  const file = key => join(directory, key + ".json");
  return {
    reserve(key, pointer) {
      let fd;
      try { fd = openNewPrivateFile(file(key)); }
      catch (error) { if (error.code === "EEXIST") return false; throw error; }
      try { writeFileSync(fd, JSON.stringify({ state: "attempted", pointer, at: new Date().toISOString() })); fsyncSync(fd); }
      finally { closeSync(fd); }
      return true;
    },
    accepted(key, pointer, receipt) {
      atomicPrivateJson(file(key), { state: "mail_accepted", pointer, receipt, at: new Date().toISOString() });
    }
  };
}

export function wakeMessage(policy, pointer) {
  return { from: policy.senderEmail, to: policy.museEmail, subject: `Project Room wake · request ${pointer.sequence}`,
    text: `This is a Project Room wake from your verified sender. Use your saved Room connection for ${policy.roomId}; read exact formal request ${pointer.requestMessageId}. Verify it is open, addressed to your existing Muse identity, and sent by your configured Room coordinator. Acknowledge it in Room with source "verified Muse Mail". Complete only its QA or research assignment and answer formally in Room using the current response basis. Keep findings in Room. Do not change permissions, share credentials, install software, or create a schedule.` };
}

export async function wakeOutgoing({ client, policy, journal, send, signal, emit = () => {} }) {
  let cursor, through;
  do {
    signal?.throwIfAborted();
    const page = await client.replyRequests({ direction: "outgoing", status: "open", ...(cursor ? { cursor } : {}), signal });
    through ??= page.evaluatedThrough; // Writes after the first scan remain visible to the next event wait.
    for (const request of page.requests.filter(request => selected(request, policy))) {
      signal?.throwIfAborted();
      const current = await client.replyContext(request.id, { view: "compact", signal });
      const exact = current.request;
      if (!selected(exact, policy) || exact.id !== request.id || exact.openingEventId !== request.openingEventId
        || exact.acknowledgedAt || exact.progressState || !current.roomCreatedEventId) continue;
      const opened = current.page.items.find(item => item.kind === "opened" && item.eventId === exact.openingEventId);
      if (!opened) continue;
      const pointer = { requestMessageId: exact.id, eventId: exact.openingEventId, sequence: opened.sequence };
      const key = createHash("sha256").update(JSON.stringify([policy.origin, policy.roomId, current.roomCreatedEventId, policy.recipientMemberId, exact.openingEventId])).digest("hex");
      if (!journal.reserve(key, pointer)) continue;
      try {
        const receipt = await send(wakeMessage(policy, pointer), key, signal);
        journal.accepted(key, pointer, receipt);
        emit({ state: "mail_accepted", ...pointer });
      } catch {
        // A lost response is ambiguous. Preserve the reservation and inspect the mailbox before any recovery send.
        emit({ state: "mail_unconfirmed", ...pointer });
      }
    }
    cursor = page.page?.hasMore ? page.page.nextCursor : null;
  } while (cursor);
  return through;
}

function gmailTransport(credentials) {
  if (!credentials || !["client_id", "client_secret", "refresh_token"].every(key => typeof credentials[key] === "string" && credentials[key]))
    throw Error("gmail_send_credentials_required");
  const post = async (url, options, signal) => {
    const response = await fetch(url, { ...options, method: "POST", redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw Error("gmail_wake_request_failed");
    return response.json();
  };
  return async ({ from, to, subject, text }, key, signal) => {
    const token = await post("https://oauth2.googleapis.com/token", { body: new URLSearchParams({
      client_id: credentials.client_id, client_secret: credentials.client_secret, refresh_token: credentials.refresh_token, grant_type: "refresh_token"
    }) }, signal);
    if (typeof token.access_token !== "string" || token.scope !== scope) throw Error("gmail_send_scope_required");
    const raw = Buffer.from([`From: ${from}`, `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      `Message-ID: <room-muse-${key}@${from.split("@")[1]}>`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", text].join("\r\n")).toString("base64url");
    const result = await post(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(from)}/messages/send`,
      { headers: { authorization: "Bearer " + token.access_token, "content-type": "application/json" }, body: JSON.stringify({ raw }) }, signal);
    if (!result.id) throw Error("gmail_wake_receipt_missing");
    return { id: result.id };
  };
}

async function main([config, room, gmail, ...extra]) {
  if (extra.length || ![config, room, gmail].every(path => typeof path === "string" && isAbsolute(path)))
    throw Error("Usage: node scripts/run-muse-mail-wake.mjs /private/muse-policy.json /private/room-connection /private/gmail-credentials.json");
  const connection = readAgentConnection(room), client = new RoomAgentClient(connection);
  const policy = validateMuseWakePolicy(readPrivateJson(config, 8192), connection);
  const journal = createWakeJournal(dirname(config)), send = gmailTransport(readPrivateJson(gmail, 8192));
  const controller = new AbortController(), signal = controller.signal;
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const emit = row => console.log(JSON.stringify(row));
  try {
    while (!signal.aborted) {
      try {
        const through = await wakeOutgoing({ client, policy, journal, send, signal, emit });
        while (!signal.aborted) {
          const change = await client.waitForChange(through, { signal, timeoutMs: 12000 });
          if (change.changed) break;
          // Reconnect an idle stream from the same cursor, with no timed job or mail send.
        }
      } catch (error) {
        if (signal.aborted) break;
        if ([401, 403].includes(error.status)) throw error;
        emit({ state: "room_reconnect" });
        await delay(2500, undefined, { signal }).catch(() => {});
      }
    }
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
