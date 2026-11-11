#!/usr/bin/env node
// room-acp end-to-end check against a live Room. Creates a throwaway
// qa-acp-* room with the identity in ROOM_E2E_SECRET (never printed),
// mints one agent invite, joins it with room-acp, and drives the scripted
// fake ACP agent through: mention -> threaded reply -> follow-up in the same
// session -> owner-approved permission -> silence-denied permission.
//   ROOM_E2E_SECRET=pri_… node scripts/room-acp-e2e.mjs [origin]
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "../room-acp/src/join.mjs";
import { Bridge } from "../room-acp/src/bridge.mjs";
import { redact, registerSecret } from "../room-acp/src/redact.mjs";

const origin = process.argv[2] ?? "https://room.trydemigod.com";
const secret = process.env.ROOM_E2E_SECRET;
if (!secret) { console.error("set ROOM_E2E_SECRET to an identity secret"); process.exit(2); }
registerSecret(secret);
const FAKE = fileURLToPath(new URL("../room-acp/fixtures/fake-agent.mjs", import.meta.url));
const call = async (path, body) => {
  const response = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", origin }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${value?.error?.code ?? ""} ${value?.error?.message ?? ""}`);
  return value;
};
const waitFor = async (check, ms = 90000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 1000)); }
  throw new Error("timed out waiting");
};
const results = [];
const step = async (name, fn) => { const start = Date.now(); try { await fn(); results.push(`PASS ${name} (${Date.now() - start} ms)`); } catch (error) { results.push(`FAIL ${name}: ${redact(error.message)}`); throw error; } };

const roomId = `qa-acp-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6)}`;
const home = mkdtempSync(joinPath(tmpdir(), "room-acp-e2e-"));
const env = { ...process.env, ROOM_ACP_HOME: home, FAKE_ACP_MODE: "ask-permission" };
delete env.ROOM_E2E_SECRET;
let bridge, done;
const say = (body, replyToId) => call(`/api/rooms/${roomId}/commands`, { id: randomUUID(), type: "message.posted", data: { messageId: `e2e-${randomUUID()}`, body, ...(replyToId ? { replyToId } : {}) } }).then(() => null);
const thread = async id => (await call(`/api/rooms/${roomId}/messages/${id}/thread`)).thread;
const lastMessageId = async () => (await call(`/api/rooms/${roomId}/messages?limit=1`)).messages.at(-1).id;
try {
  await step("create qa room", () => call("/api/agent-rooms", { roomId, title: "QA room-acp end-to-end (throwaway)", purpose: "Throwaway QA room for the room-acp bridge end-to-end check. Synthetic messages only." }));
  let link;
  await step("mint agent invite", async () => { const invite = await call(`/api/rooms/${roomId}/agent-invites`, { profile: "contribute" }); registerSecret(invite.code); link = `${origin}/join/${invite.code}`; });
  let connection;
  await step("room-acp join", async () => { connection = await join({ link, displayName: "ACPCoder", env }); });
  await step("bridge leases the wake queue", async () => {
    bridge = new Bridge({ connection, candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE] }, env, permissionTimeoutMs: 20000, permissionPollMs: 1500 });
    done = bridge.run();
    await waitFor(() => bridge.fencingToken);
  });
  let rootId;
  await step("permission ask appears in the thread and owner allow selects allow", async () => {
    await say("@ACPCoder please clean the build");
    rootId = await lastMessageId();
    await waitFor(async () => (await thread(rootId)).replies?.some(reply => reply.body.startsWith("Permission needed:")));
    await say("allow", rootId);
    await waitFor(async () => (await thread(rootId)).replies?.some(reply => reply.body === "permission: allow_once"));
  });
  await step("silence denies after the timeout", async () => {
    await say("@ACPCoder once more", rootId);
    await waitFor(async () => (await thread(rootId)).replies?.some(reply => reply.body === "permission: reject_once"), 120000);
    if (bridge.host.sessions.size !== 1) throw new Error(`expected one session for the thread, got ${bridge.host.sessions.size}`);
  });
  await step("all wakes acked", () => waitFor(() => bridge.stats.acked >= 2));
} catch { /* recorded above */ } finally {
  bridge?.stop(); await done?.catch(() => {});
  rmSync(home, { recursive: true, force: true });
  console.log(`room ${roomId}\n${results.join("\n")}`);
  process.exitCode = results.some(line => line.startsWith("FAIL")) ? 1 : 0;
}
