// A fresh synthetic room for actual agent participation, never a hosted runner.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

export async function startDiscussionFixture() {
  const directory = mkdtempSync(join(tmpdir(), "room-discussion-")); let store, server, closing;
  const close = () => closing ??= (async () => {
    try { if (server) { server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); } }
    finally { try { store?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } }
  })();
  try {
    store = new RoomStore(join(directory, "room.sqlite"));
    const seed = initialRoom(); seed[0].data.title = "A clearer welcome";
    seed[0].data.purpose = "Synthetic agent clarification exercise; no real users or external actions.";
    seed[1].data.displayName = "Test owner (not John)"; store.initialize(seed);
    const ownerToken = store.issueAccessKey("commons", "owner"), memberId = "welcome-writer", workItemId = "welcome-copy";
    const send = (type, data) => store.command(ownerToken, "commons", { id: randomUUID(), type, data });
    send(T.MEMBER_ADDED, { memberId, displayName: "Welcome writer", kind: "agent", accountableHumanId: "owner", permissions: [] });
    const token = store.issueAccessKey("commons", memberId);
    send(T.MESSAGE_POSTED, { messageId: "welcome-request", body: "Draft a three-step checklist welcoming a first-time visitor to Project Room. Help them start a useful contribution. This is draft copy for review, not a request to change any service." });
    send(T.WORK_PROPOSED, { workItemId, title: "Write a welcoming first step", definitionOfDone: "A concise, useful welcome that follows the latest discussion clarification; remain a draft for owner review.",
      accountableMemberId: memberId, sourceMessageId: "welcome-request", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
    const beforeClarification = store.room("commons").sequence;
    send(T.MESSAGE_POSTED, { messageId: "side-topic", body: "Unrelated planning: the imaginary picnic has five courses." });
    send(T.MESSAGE_POSTED, { messageId: "welcome-clarification", replyToId: "welcome-request", toMemberId: memberId,
      body: "Change of direction: no checklist. Write exactly two short sentences, 30 words total or fewer. The first should invite one question or idea; the second should say a person reviews the work before it is approved. Use ordinary, friendly language without technical setup instructions." });
    server = createRoomServer({ store });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const origin = `http://127.0.0.1:${server.address().port}`, configDirectory = join(directory, "writer"), seedThrough = store.room("commons").sequence;
    saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId, token });
    const manifest = { origin, configDirectory, memberId, workItemId, beforeClarification, seedThrough,
      credentialKind: "synthetic operator-provisioned agent, draft-only", boundary: "Same OS user; not secret-isolated or native-host acceptance. No external actions. No human approval." };
    const manifestFile = join(directory, "exercise.json");
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    writeFileSync(join(directory, "owner-private.json"), JSON.stringify({ origin, token: ownerToken }), { flag: "wx", mode: 0o600 });
    const evidence = () => {
      const snapshot = store.snapshot(ownerToken, "commons");
      return { ...manifest, finalSequence: snapshot.sequence, work: snapshot.state.workItems[workItemId],
        discussion: store.workDiscussion(ownerToken, "commons", workItemId),
        participantEvents: store.eventsAfter(ownerToken, "commons", seedThrough, 100).events,
        cursors: ["owner", memberId].map(id => ({ memberId: id, sequence: store.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get("commons", id)?.sequence ?? 0 })) };
    };
    return { directory, origin, manifestFile, evidence, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Provide one NEW evidence JSON path; existing rooms are never opened.");
  const evidenceFile = resolve(process.argv[2]), fixture = await startDiscussionFixture(); let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    try { writeFileSync(evidenceFile, JSON.stringify(fixture.evidence(), null, 2), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify({ evidenceFile })); }
    finally { await fixture.close(); }
  };
  process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
  console.log(JSON.stringify({ manifestFile: fixture.manifestFile, origin: fixture.origin }));
}
