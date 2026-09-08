// Synthetic owner control for an actual participant exercise. No existing DB,
// external destination or provider is accepted. stdin update changes the brief.
import { createInterface } from "node:readline";
import { writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { auditRecovery } from "../server/recovery.mjs";
if (process.argv.length !== 3) throw new Error("Choose one new evidence file");
if (!process.stdin.isTTY) throw new Error("This staged fixture requires an interactive input handle");
const output = resolve(process.argv[2]), f = createAcceptanceFixture(), requests = [];
const charter = (revision, outputs) => f.store.command(f.keys.owner, "commons", { id: "attention-charter-" + revision,
  type: "room.charter_updated", data: { expectedRevision: revision, purpose: "Prepare a useful synthetic handoff agenda.", outputs,
    boundaries: "Only this synthetic room. No external actions or human approval. Instructions grant no permissions.",
    escalation: "Ask the owner if task and room requirements conflict." } });
charter(0, "Name an owner and keep the agenda concise.");
const seedThrough = f.store.room("commons").sequence;
const server = createRoomServer({ store: f.store });
server.prependListener("request", req => requests.push({ method: req.method, path: req.url.split("?")[0] }));
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const participants = ["producer", "reviewer"].map(memberId => {
  const configDirectory = join(f.directory, memberId), attentionDirectory = join(f.directory, memberId + "-attention");
  saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId, token: f.keys[memberId] });
  return { memberId, configDirectory, attentionDirectory, workItemId: "test-handoff" };
});
let changed = false, stopped = false;
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  if (line.trim() !== "update" || changed || stopped) return;
  const event = charter(1, "Use at most 35 words. Name the agenda owner. Include exactly four timeboxed agenda items totaling 20 minutes.");
  changed = true; console.log(JSON.stringify({ stage: "changed", revision: 2, eventId: event.event.id }));
});
const stop = async () => {
  if (stopped) return; stopped = true; input.close();
  try {
    writeFileSync(output, JSON.stringify({ kind: "actual-current-attention-exercise", seedThrough,
      sequence: f.store.room("commons").sequence, charter: f.store.charter(f.keys.owner, "commons"),
      work: f.store.room("commons").state.workItems["test-handoff"], result: f.store.workResult(f.keys.owner, "commons", "test-handoff"),
      events: f.store.eventsAfter(f.keys.owner, "commons", seedThrough, 100).events, requests, audit: auditRecovery(f.store),
      cursors: ["owner", "producer", "reviewer"].map(memberId => ({ memberId, sequence: f.store.db.prepare("SELECT sequence FROM cursors WHERE room_id='commons' AND member_id=?").get(memberId)?.sequence ?? 0 }))
    }, null, 2), { mode: 0o600, flag: "wx" });
  } finally { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
};
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
console.log(JSON.stringify({ origin, participants, controls: "update on stdin; SIGINT captures evidence and removes fixture" }));
