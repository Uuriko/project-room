// Advance only the synthetic fixture through producer/reviewer API exchanges.
// Human-role approval is deliberately left to the browser test.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const [filename, phase] = process.argv.slice(2);
if (!filename || !["first-review", "correction"].includes(phase)) throw new Error("Usage: node scripts/acceptance-handoff.mjs TEST-CREDENTIALS.json first-review|correction");
const { origin, keys } = JSON.parse(readFileSync(filename, "utf8"));
const url = new URL(origin);
if (url.hostname !== "localhost" || url.protocol !== "http:" || url.origin !== origin) throw new Error("Only the isolated localhost fixture is allowed");
const producer = new RoomAgentClient({ origin, roomId: "commons", token: keys.producer });
const reviewer = new RoomAgentClient({ origin, roomId: "commons", token: keys.reviewer });
const snapshot = await producer.snapshot();
if (snapshot.state.room.title !== "Project Room — Disposable Test" || !snapshot.state.workItems["test-handoff"]) throw new Error("Not the disposable acceptance fixture");
const item = async () => (await producer.orient()).work.find(work => work.id === "test-handoff");
const change = async (actor, id, type, data = {}) => actor.command({ id: `acceptance-${id}`, type, data: { workItemId: "test-handoff", expectedRevision: (await item()).revision, ...data } });
if (phase === "first-review") {
  if ((await item()).next.action !== "accept") throw new Error("First review requires a fresh proposed fixture");
  await change(producer, "accept", T.WORK_ACCEPTED);
} else {
  if ((await item()).next.action !== "revise") throw new Error("Correction requires the failed-review fixture");
  await change(producer, "resolve", T.WORK_BLOCKER_RESOLVED, { resolution: "Add the missing owner." });
}
await change(producer, `${phase}-start`, T.WORK_STARTED);
const summary = phase === "first-review" ? "Agenda: discuss the proposal." : "Owner: Room owner. Agenda: discuss the proposal and record the decision.";
const evidenceVersion = `sha256:${createHash("sha256").update(summary).digest("hex")}`;
await change(producer, `${phase}-complete`, T.WORK_COMPLETED, { summary, evidenceVersion, producerId: "producer", evidenceUrl: "https://example.invalid/synthetic-agenda", nextAction: "Review the inline text; this is not a live external artifact." });
const receipt = (await item()).receipt;
await change(reviewer, `${phase}-review`, T.VERIFICATION_RECORDED, { result: phase === "first-review" ? "fail" : "pass", completionEventId: receipt.eventId, evidenceVersion, summary: phase === "first-review" ? "Missing owner; add one." : "Synthetic reviewer: exact text hash checked and owner is named.", ...(phase === "first-review" ? { nextAction: "Add the owner to the agenda." } : {}) });
console.log(JSON.stringify({ phase, next: (await item()).next, evidenceVersion }));
