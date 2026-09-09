// Two actual participants, one synthetic local task. No provider calls or deployment.
import { writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { auditRecovery } from "../server/recovery.mjs";

export async function startNativeResultFixture({ initialCharter = null } = {}) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store }); let closing;
  if (initialCharter) f.store.command(f.keys.owner, "commons", { id: "exercise-charter", type: "room.charter_updated", data: { expectedRevision: 0, ...initialCharter } });
  const close = () => closing ??= (async () => {
    try { server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
    finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
  })();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const origin = `http://127.0.0.1:${server.address().port}`, seedThrough = f.store.room("commons").sequence;
    const participants = ["producer", "reviewer"].map(memberId => {
      const configDirectory = join(f.directory, memberId);
      saveAgentConnection(configDirectory, { version: 1, origin, roomId: "commons", memberId, token: f.keys[memberId] });
      return { memberId, configDirectory, workItemId: "test-handoff" };
    });
    return { origin, participants, close, evidence: () => ({ kind: "actual-agent-exercise", scope: "synthetic local room; same OS; not native vendor acceptance or human testing",
      seedThrough, sequence: f.store.room("commons").sequence, charter: f.store.charter(f.keys.owner, "commons"), work: f.store.room("commons").state.workItems["test-handoff"],
      result: f.store.workResult(f.keys.owner, "commons", "test-handoff"),
      events: f.store.eventsAfter(f.keys.owner, "commons", seedThrough, 100).events, audit: auditRecovery(f.store),
      cursors: ["owner", "producer", "reviewer"].map(memberId => ({ memberId, sequence: f.store.db.prepare("SELECT sequence FROM cursors WHERE room_id='commons' AND member_id=?").get(memberId)?.sequence ?? 0 })) }) };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Choose one new local evidence file");
  const output = resolve(process.argv[2]), f = await startNativeResultFixture(); let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; try { writeFileSync(output, JSON.stringify(f.evidence(), null, 2), { flag: "wx", mode: 0o600 }); }
    finally { await f.close(); } };
  process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
  console.log(JSON.stringify({ origin: f.origin, participants: f.participants }));
}
