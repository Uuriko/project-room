// Disposable actual-agent exercise, with no caller database or provider access.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { createHash, randomBytes } from "node:crypto";

const directory = mkdtempSync(join(tmpdir(), "room-connection-exercise-"));
const store = new RoomStore(join(directory, "fixture.sqlite"));
store.initialize(initialRoom());
const owner = store.issueAccessKey("commons", "owner");
const send = (type, data) => store.command(owner, "commons", { id: crypto.randomUUID(), type, data });
const ownerSession = store.createSession(owner), token = randomBytes(32).toString("base64url");
store.agentConnections.apply(ownerSession.token, "commons", { action: "create", requestId: "exercise-enrollment", memberId: "connection-writer",
  displayName: "Connection test agent", access: "chat", keyHash: createHash("sha256").update(token).digest("hex"),
  expiresAt: Date.now() + 3600000, expectedOwnerRevision: 0 }, ownerSession.session.sessionBinding);
send(T.WORK_PROPOSED, { workItemId: "welcome-draft", title: "Write a short welcome", mode: "read", accountableMemberId: "owner",
  definitionOfDone: "Draft one welcoming sentence for a new Project Room member. Invite one small contribution. Do not claim that AI is online, that work has started, or that private content is public. Post a draft for human review, not completed work." });
const before = store.snapshot(token, "commons");
const server = createRoomServer({ store });
let closing = false;
function stop() {
  if (closing) return; closing = true;
  server.closeStreams(); server.closeAllConnections();
  server.close(() => {
    const after = store.snapshot(token, "commons");
    console.log(JSON.stringify({ type: "exercise_result", beforeSequence: before.sequence, afterSequence: after.sequence,
      cursor: after.cursor, workUnchanged: JSON.stringify(after.state.workItems) === JSON.stringify(before.state.workItems),
      messages: after.state.messages.map(({ id, authorId, body, proposal }) => ({ id, authorId, body, proposal })) }));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
}
process.on("SIGINT", stop); process.on("SIGTERM", stop);
server.listen(0, "127.0.0.1", async () => {
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const config = { version: 1, origin, roomId: "commons", memberId: "connection-writer", token };
    await new RoomAgentClient(config).checkConnection();
    const configDirectory = join(directory, "agent"); saveAgentConnection(configDirectory, config);
    const ownerPath = join(directory, "owner-private.json");
    writeFileSync(ownerPath, JSON.stringify({ origin, token: owner }), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ type: "exercise_ready", directory, configDirectory, ownerPath, origin, workItemId: "welcome-draft", beforeSequence: before.sequence }));
  } catch { console.error("Connection fixture failed to prepare."); process.exitCode = 1; stop(); }
});
