// Disposable actual-agent exercise. No production paths or existing database accepted.
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const fixture = createAcceptanceFixture();
const send = (type, data) => fixture.store.command(fixture.keys.owner, "commons", { id: crypto.randomUUID(), type, data });
send(T.MEMBER_ADDED, { memberId: "repeat-planner", displayName: "Test repeat planner", kind: "agent", accountableHumanId: "owner", permissions: ["steer"] });
send(T.WORK_PROPOSED, { workItemId: "repeat-source", title: "Prepare the weekly collaboration agenda",
  definitionOfDone: "List the week's outcomes, name one owner for each unresolved item, and provide three discussion questions. This is a draft agenda, not approval to act.",
  accountableMemberId: "owner", mode: "read", independentVerificationRequired: false, ownerDecisionRequired: false });
send(T.WORK_ACCEPTED, { workItemId: "repeat-source", expectedRevision: 0 });
send(T.WORK_COMPLETED, { workItemId: "repeat-source", expectedRevision: 1, summary: "Seeded prior agenda for this synthetic exercise.",
  evidenceUrl: "https://example.invalid/seeded-agenda", evidenceVersion: "fixture-v1", producerId: "owner", nextAction: "Use as context, not a claim of real prior work." });
const server = createRoomServer({ store: fixture.store });
server.listen(0, "127.0.0.1", () => {
  const configPath = join(fixture.directory, "reuse-agent.json");
  writeFileSync(configPath, JSON.stringify({
    origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons",
    token: fixture.store.issueAccessKey("commons", "repeat-planner"), sourceId: "repeat-source",
    assigneeId: "producer", reviewerId: "reviewer", decisionMakerId: "owner"
  }), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ configPath, directory: fixture.directory, origin: `http://127.0.0.1:${server.address().port}` }));
});
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  server.closeStreams(); server.closeAllConnections();
  server.close(() => { fixture.store.close(); rmSync(fixture.directory, { recursive: true, force: true }); });
}
process.on("SIGINT", stop); process.on("SIGTERM", stop);
