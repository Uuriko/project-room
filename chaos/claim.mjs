// Work-claim lifecycle for the room-native board (production muse-room).
// Usage: node claim.mjs get|progress|done [--note "..."]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import https from "node:https";

const ORIGIN = "https://room.trydemigod.com";
const ROOM = "muse-room";
const CLAIM = "qa2-perf-jill";
const identity = JSON.parse(readFileSync(join(homedir(), ".config", "jill-room", "identity.json"), "utf8"));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(`${ORIGIN}${path}`, { method,
      headers: { Authorization: "Bearer " + identity.secret, "Content-Type": "application/json", "User-Agent": "jill-plugin/1.0" },
      timeout: 30000 },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
    r.on("error", reject);
    r.end(data);
  });
}

const [cmd, ...rest] = process.argv.slice(2);
const noteIdx = rest.indexOf("--note");
const note = noteIdx >= 0 ? rest.slice(noteIdx + 1).join(" ") : "";

if (cmd === "get") {
  const out = await req("GET", `/api/rooms/${ROOM}/work-claims/${CLAIM}`);
  console.log(out.status);
  const d = JSON.parse(out.body);
  console.log(JSON.stringify({ id: d.id ?? d.taskId, state: d.state, status: d.status, owner: d.owner ?? d.ownerId, leaseExpiresAt: d.leaseExpiresAt }, null, 1));
} else if (cmd === "progress" || cmd === "done") {
  const body = cmd === "done"
    ? { state: "done", deliveryMode: "result", note: note || "QA2-PERF+CHAOS complete; findings posted to room thread and group-qa-2026-10-04/qa2-perf-chaos.md", tags: ["qa2", "perf", "chaos"] }
    : { state: "in_progress", note: note || "probes complete, writing findings" };
  const out = await req("POST", `/api/rooms/${ROOM}/work-claims/${CLAIM}/update`, body);
  console.log(out.status, out.body.slice(0, 400));
} else {
  console.error("usage: claim.mjs get|progress|done [--note ...]");
  process.exit(2);
}
