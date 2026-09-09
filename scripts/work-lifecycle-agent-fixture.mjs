// Synthetic same-room participation, never a hosted runner or external workspace.
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

export async function startWorkLifecycleFixture() {
  const directory = mkdtempSync(join(tmpdir(), "room-work-lifecycle-"));
  let store, server, closing;
  const close = () => closing ??= (async () => {
    try { if (server) { server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); } }
    finally { try { store?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } }
  })();
  try {
    store = new RoomStore(join(directory, "room.sqlite"));
    const seed = initialRoom(); seed[0].data.title = "Two agents, one room";
    seed[0].data.purpose = "Disposable local cooperation exercise. Fictional scope; no real repository, provider or human approval.";
    seed[1].data.displayName = "Test owner (not John)"; store.initialize(seed);
    const ownerToken = store.issueAccessKey("commons", "owner");
    const send = (type, data) => store.command(ownerToken, "commons", { id: randomUUID(), type, data });
    const scope = { repository: "fictional/agent-handoff", ref: "shared-draft", paths: ["notes/handoff.md"], expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const participants = ["agent-a", "agent-b"].map(memberId => ({ memberId, workItemId: `work-${memberId}`, configDirectory: join(directory, memberId) }));
    send(T.MESSAGE_POSTED, { messageId: "shared-brief", body: "Each agent writes an original, short onboarding artifact, coordinates the fictional shared scope, and reviews the other's exact text/hash. A writes a one-sentence welcome; B writes three brief contribution tips. Store the full artifact in the completion summary so it is readable in this room. Use a sha256: digest of its exact UTF-8 text as evidenceVersion. HTTPS example.invalid references are synthetic and must not be fetched. Preserve human approval as pending. Scope reservations coordinate this room only; no external execution is authorized." });
    const keys = new Map();
    for (const participant of participants) {
      send(T.MEMBER_ADDED, { memberId: participant.memberId, displayName: participant.memberId === "agent-a" ? "Welcome writer" : "Guide writer",
        kind: "agent", accountableHumanId: "owner", permissions: ["accept_work", "complete_work", "write_external", "verify"] });
      keys.set(participant.memberId, store.issueAccessKey("commons", participant.memberId));
    }
    for (const [index, participant] of participants.entries()) send(T.WORK_PROPOSED, {
      workItemId: participant.workItemId, title: index === 0 ? "Write a warm welcome" : "Write three contribution tips",
      definitionOfDone: index === 0 ? "One original welcoming sentence inviting a useful contribution, with no claims of automated execution or approval."
        : "Three concise, original tips helping a newcomer contribute useful work, coordinate ownership and ask for review.",
      accountableMemberId: participant.memberId, verifierMemberId: participants[1 - index].memberId,
      mode: "write", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner", sourceMessageId: "shared-brief"
    });
    server = createRoomServer({ store });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const origin = `http://127.0.0.1:${server.address().port}`, seedThrough = store.room("commons").sequence;
    for (const participant of participants) saveAgentConnection(participant.configDirectory, { version: 1, origin, roomId: "commons", memberId: participant.memberId, token: keys.get(participant.memberId) });
    const manifest = { origin, seedThrough, scope, participants, credentialKind: "operator-provisioned synthetic agents; not enrollment presets", boundary: "Same OS user, not secret-isolated runtimes. No external resources or execution. Human decision remains pending." };
    const manifestFile = join(directory, "exercise.json"), ownerFile = join(directory, "owner-private.json");
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    writeFileSync(ownerFile, JSON.stringify({ origin, token: ownerToken }), { flag: "wx", mode: 0o600 });
    const evidence = () => {
      const snapshot = store.snapshot(ownerToken, "commons");
      return { ...manifest, finalSequence: snapshot.sequence, workItems: snapshot.state.workItems,
        cursors: ["owner", ...participants.map(p => p.memberId)].map(memberId => ({ memberId, sequence: store.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get("commons", memberId)?.sequence ?? 0 })),
        participantEvents: store.eventsAfter(ownerToken, "commons", seedThrough, 100).events };
    };
    return { directory, store, origin, participants, manifest, manifestFile, ownerFile, evidence, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Provide one NEW evidence JSON path. This fixture never reads an existing room.");
  const evidenceFile = resolve(process.argv[2]), fixture = await startWorkLifecycleFixture(); let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    try { writeFileSync(evidenceFile, JSON.stringify(fixture.evidence(), null, 2), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify({ evidenceFile })); }
    finally { await fixture.close(); }
  };
  process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
  console.log(JSON.stringify({ manifestFile: fixture.manifestFile, ownerFile: fixture.ownerFile, origin: fixture.origin }));
}
