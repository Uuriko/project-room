// Explicit synthetic native-host exercise. Never opens an existing Room database.
import { createInterface } from "node:readline";
import { writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { auditRecovery } from "../server/recovery.mjs";

if (process.argv.length !== 3 || !process.stdin.isTTY) throw new Error("Choose a new evidence file and interactive control handle");
const output = resolve(process.argv[2]), f = createAcceptanceFixture(), traffic = [];
const send = (id, type, data) => f.store.command(f.keys.owner, "commons", { id, type, data });
send("host-charter", "room.charter_updated", { expectedRevision: 0,
  purpose: "Prepare a concise agenda for welcoming collaborators to a project room.",
  outputs: "Name the agenda owner. Ask the requester for the time budget before drafting.",
  boundaries: "Synthetic local room only. No outside actions, spending or publication. Human approval remains separate.",
  escalation: "Ask the requester for missing constraints." });
send("host-question", "message.posted", { messageId: "native-question", requestKind: "reply", toMemberId: "producer", workItemId: "test-handoff",
  body: "Please write a welcoming agenda for our first project-room session. Ask me about the time budget before drafting. Name the agenda owner and make it easy for newcomers to contribute." });
const seedThrough = f.store.room("commons").sequence, server = createRoomServer({ store: f.store });
server.prependListener("request", req => traffic.push({ method: req.method, path: req.url.split("?")[0] }));
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const participants = ["producer", "reviewer"].map(memberId => {
  const configDirectory = join(f.directory, memberId), attentionDirectory = join(f.directory, memberId + "-v3");
  saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId, token: f.keys[memberId] });
  return { memberId, configDirectory, attentionDirectory, workItemId: "test-handoff" };
});
const metadata = join(f.directory, "host-fixture.json");
writeFileSync(metadata, JSON.stringify({ origin, participants, directory: f.directory }), { flag: "wx", mode: 0o600 });
const evidence = () => ({ kind: "native-host-request-exercise", scope: "Synthetic local Room; host transcripts required for model attribution",
  seedThrough, sequence: f.store.room("commons").sequence, work: f.store.room("commons").state.workItems["test-handoff"],
  request: f.store.room("commons").state.replyRequests["native-question"], result: f.store.workResult(f.keys.owner, "commons", "test-handoff"),
  events: f.store.eventsAfter(f.keys.owner, "commons", seedThrough, 100).events, traffic, audit: auditRecovery(f.store),
  cursors: ["owner", "producer", "reviewer"].map(memberId => ({ memberId,
    sequence: f.store.db.prepare("SELECT sequence FROM cursors WHERE room_id='commons' AND member_id=?").get(memberId)?.sequence ?? 0 })) });
let clarified = false, stopped = false;
const input = createInterface({ input: process.stdin });
const status = () => {
  const e = evidence();
  console.log(JSON.stringify({ stage: "status", sequence: e.sequence, request: e.request.status, work: e.work.status,
    verification: e.work.verification ?? null, decision: e.work.decision ?? null,
    messages: e.events.filter(row => row.event.type === "message.posted").map(row => ({ actor: row.event.actorId, ...row.event.data })) }));
};
const stop = async () => {
  if (stopped) return; stopped = true; input.close();
  try { writeFileSync(output, JSON.stringify(evidence(), null, 2), { flag: "wx", mode: 0o600 }); }
  finally {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ stage: "stopped", evidence: output, removed: "Only this disposable fixture and its credentials" }));
};
input.on("line", line => {
  const action = line.trim();
  if (action === "status") status();
  else if (action === "clarify" && !clarified) {
    const question = f.store.room("commons").state.messages.find(m => m.authorId === "producer" && m.replyToId === "native-question" && !m.responseToRequestId);
    if (!question) { console.log(JSON.stringify({ stage: "refused", reason: "Await an actual producer clarification" })); return; }
    send("human-clarification", "message.posted", { messageId: "native-clarification", replyToId: "native-question", workItemId: "test-handoff",
      body: "Twenty minutes total, exactly four timeboxed items, at most 45 words. Name Room owner as the agenda owner. Include a chance for every newcomer to contribute and finish with a concrete next step." });
    clarified = true; console.log(JSON.stringify({ stage: "human-clarified", simulatedHuman: true }));
  } else if (action === "finish") void stop();
});
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
console.log(JSON.stringify({ origin, metadata, controls: "status / clarify / finish; no existing preview is changed" }));
