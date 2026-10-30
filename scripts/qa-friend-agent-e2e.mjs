#!/usr/bin/env node
// Friend's-agent journey, end to end (MVP build list step 6):
//   owner mints an agent invite -> the friend's room-acp joins with it ->
//   owner mentions the agent in chat -> threaded reply ->
//   owner assigns a Board claim -> reply lands in the claim thread ->
//   owner sees both.
// The friend's agent is the scripted fake ACP agent, so no model is used.
//
//   node scripts/qa-friend-agent-e2e.mjs --local
//       in-process Room (CI, no network)
//   ROOM_QA_ORIGIN=https://room.trydemigod.com ROOM_QA_ROOM=qa-... ROOM_QA_OWNER_KEY=... \
//     node scripts/qa-friend-agent-e2e.mjs
//       a real throwaway qa- room. Refuses any room id not starting with qa-.
// Never prints the owner key, invite codes or the agent credential.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "../room-acp/src/join.mjs";
import { Bridge } from "../room-acp/src/bridge.mjs";

const FAKE_AGENT = fileURLToPath(new URL("../room-acp/fixtures/fake-agent.mjs", import.meta.url));
const step = (name, ok, detail = "") => { console.log(`${ok ? "ok" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`); if (!ok) process.exitCode = 1; return ok; };

async function waitFor(check, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 500)); }
  return null;
}

async function startLocal() {
  const { createAcceptanceFixture } = await import("./acceptance-fixture.mjs");
  const { createRoomServer } = await import("../server/http.mjs");
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", ownerKey: f.store.issueAccessKey("commons", "owner"),
    close: async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); },
  };
}

export async function runJourney({ origin, roomId, ownerKey, log = () => {} }) {
  const api = async (path, body) => {
    const res = await fetch(origin + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  const room = `/api/rooms/${encodeURIComponent(roomId)}`;
  const home = mkdtempSync(joinPath(tmpdir(), "qa-friend-agent-"));
  const name = `QAFriend${randomUUID().slice(0, 6)}`;
  let bridge, done;
  try {
    const minted = await api(`${room}/agent-invites`, { profile: "member", displayName: name });
    if (!step("1 owner mints a Member agent invite", minted.status < 300 && typeof minted.json.code === "string", `status ${minted.status}`)) return;
    const link = `${origin}/join/${minted.json.code}`;

    const connection = await join({ link, displayName: name, env: { ...process.env, ROOM_ACP_HOME: home } });
    step("2 friend's room-acp joins with the link", Boolean(connection?.memberId));

    bridge = new Bridge({ connection, candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE_AGENT] }, env: { ...process.env, ROOM_ACP_HOME: home, FAKE_ACP_MODE: "echo" }, respondTo: "owner", waitMs: 10000, cadenceSeconds: 30, log });
    done = bridge.run();
    step("2b bridge holds the wake queue", Boolean(await waitFor(() => bridge.fencingToken, 30000)));

    const messageId = `qa-${randomUUID()}`;
    const handle = name;
    await api(`${room}/commands`, { id: randomUUID(), type: "message.posted", data: { messageId, body: `@${handle} say hello` } });
    const reply = await waitFor(async () => {
      const read = await api(`${room}/messages/${encodeURIComponent(messageId)}/thread`);
      return (read.json.thread?.replies ?? []).find(entry => entry.authorId === connection.memberId);
    });
    step("3 chat mention gets a threaded reply the owner can read", Boolean(reply));

    const claimId = `qa-claim-${randomUUID().slice(0, 8)}`;
    const created = await api(`${room}/work-claims`, { id: claimId, title: "QA: friend's agent claim", note: "Reply with a one-line result.", assignee: connection.memberId });
    step("4 owner assigns a Board claim to the agent", created.status === 201, `status ${created.status}`);
    const noted = await waitFor(async () => {
      const thread = await api(`${room}/work-claims/${encodeURIComponent(claimId)}/thread`);
      return (thread.json.entries ?? []).find(entry => entry.kind === "note" && entry.actorId === connection.memberId);
    });
    step("5 agent's result shows in the claim thread", Boolean(noted));
  } catch (error) {
    step("journey", false, error?.code ?? error?.message ?? "error");
  } finally {
    bridge?.stop(); await done?.catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const local = process.argv.includes("--local");
  const target = local ? await startLocal() : {
    origin: process.env.ROOM_QA_ORIGIN ?? "https://room.trydemigod.com", roomId: process.env.ROOM_QA_ROOM ?? "", ownerKey: process.env.ROOM_QA_OWNER_KEY ?? "", close: async () => {},
  };
  if (!local && (!/^qa-/.test(target.roomId) || !target.ownerKey)) {
    console.error("Set ROOM_QA_ROOM to a throwaway qa- room and ROOM_QA_OWNER_KEY to its owner key, or pass --local.");
    process.exit(2);
  }
  await runJourney({ ...target, log: process.env.QA_DEBUG ? (...a) => console.error("[bridge]", ...a) : () => {} });
  await target.close();
  process.exit(process.exitCode ?? 0);
}
