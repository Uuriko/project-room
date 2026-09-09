// Operator-started local acceptance fixture. Seeds context, never an agent answer.
import { mkdtempSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";

export async function startHelperAgentExercise() {
  const directory = mkdtempSync(join(tmpdir(), "room-helper-exercise-"));
  let store, server, closing;
  const close = () => closing ??= (async () => {
    try {
      if (server) { server.closeStreams(); server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve)); }
    } finally { try { store?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } }
  })();
  try {
    store = new RoomStore(join(directory, "room.sqlite"));
    const seed = initialRoom(); seed[0].data.title = "Small contributions — local exercise";
    seed[0].data.purpose = "Fictional accounts. One actual coordinator-agent, simulated owner interaction. No external actions or independent-review claim.";
    seed[1].data.displayName = "Simulated owner (not John)"; store.initialize(seed);
    const owner = store.issueAccessKey("commons", "owner");
    const send = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
    send("member.added", { memberId: "reviewer", displayName: "Reviewer — not connected", kind: "agent",
      accountableHumanId: "owner", permissions: ["verify"] });
    const slot = store.createSession(owner), token = randomBytes(32).toString("base64url");
    store.agentConnections.apply(slot.token, "commons", { action: "create", requestId: randomUUID(), memberId: "helper",
      displayName: "Acceptance helper", access: "chat", keyHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, slot.session.sessionBinding);
    send("message.posted", { messageId: "welcome-brief", body: "Our room should feel welcoming even when someone only wants to talk. Write a short welcome inviting a question, an idea, or a small draft. Do not require a task, an AI agent, payment, or a completed project. Avoid claims about automation or privacy features. Submit your own wording for review; do not publish it or approve your own result." });
    const workItemId = "welcome-card";
    send("work.proposed", { workItemId, title: "A welcome for people who just want to begin",
      definitionOfDone: "One or two natural sentences, no more than 35 whitespace-separated words. Invite conversation or a small contribution without requiring work, agents or payment. Original text, reviewed before use.",
      accountableMemberId: "owner", verifierMemberId: "reviewer", independentVerificationRequired: true,
      ownerDecisionRequired: true, humanDecisionMakerId: "owner", sourceMessageId: "welcome-brief", mode: "read" });
    send("work.accepted", { workItemId, expectedRevision: 0 });
    send("work.help_updated", { workItemId, expectedRevision: 1, expectedHelpRevision: 0, status: "open",
      scope: "Offer and draft the short welcome only. Selection is not assignment or publication permission.", expiresAt: new Date(Date.now() + 3600000).toISOString() });
    server = createRoomServer({ store, streamInterval: 50 });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const origin = "http://127.0.0.1:" + server.address().port, configDirectory = join(directory, "helper"), ownerPath = join(directory, "owner-private.json");
    saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId: "helper", token });
    writeFileSync(ownerPath, JSON.stringify({ fixture: "room-helper-exercise-v1", origin, token: owner, workItemId }), { flag: "wx", mode: 0o600 });
    const seedThrough = store.room("commons").sequence;
    const manifest = { fixture: "room-helper-exercise-v1", origin, workItemId, configDirectory, ownerPath, seedThrough,
      boundary: "Synthetic room; participant must supply its own text; scripted owner; independent review pending; same OS user, not secret-isolated." };
    const evidence = () => {
      const snapshot = store.snapshot(owner, "commons");
      return { ...manifest, finalSequence: snapshot.sequence, work: snapshot.state.workItems[workItemId],
        offers: snapshot.state.helpOffers, messages: snapshot.state.messages,
        participantEvents: store.eventsAfter(owner, "commons", seedThrough, 100).events,
        cursors: ["owner", "helper", "reviewer"].map(memberId => ({ memberId,
          sequence: store.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get("commons", memberId)?.sequence ?? 0 })),
        audit: auditRecovery(store) };
    };
    return { directory, store, manifest, evidence, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Supply one new evidence file; this fixture never opens an existing room.");
  const evidenceFile = resolve(process.argv[2]), fd = openSync(evidenceFile, "wx", 0o600);
  let fixture, closing = false;
  try {
    fixture = await startHelperAgentExercise();
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const stop = async () => {
      if (closing) return; closing = true;
      try { writeFileSync(fd, JSON.stringify({ sourceCommit: commit, ...fixture.evidence() }, null, 2)); }
      finally { closeSync(fd); await fixture.close(); }
      console.log(JSON.stringify({ evidenceFile, closed: true }));
    };
    process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
    console.log(JSON.stringify(fixture.manifest));
  } catch (error) { closeSync(fd); await fixture?.close(); throw error; }
}
