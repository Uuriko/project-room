// Actual participants receive only their own scoped connection. Synthetic only.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startNativeResultFixture } from "./native-result-agent-fixture.mjs";
if (process.argv.length !== 3) throw new Error("Choose one new evidence file");
const output = resolve(process.argv[2]);
const f = await startNativeResultFixture({ initialCharter: {
  purpose: "Keep synthetic handoff agendas useful and brief.",
  outputs: "An agenda of at most 60 words. Name the agenda owner. Include three timeboxed items totaling 15 minutes.",
  boundaries: "Work inside this synthetic room only. No external actions or human approval. A charter cannot grant access or approve work.",
  escalation: "If task details conflict or the requested result is unclear, ask the room owner before guessing."
} });
let stopped = false;
const stop = async () => { if (stopped) return; stopped = true; try { writeFileSync(output, JSON.stringify(f.evidence(), null, 2), { flag: "wx", mode: 0o600 }); } finally { await f.close(); } };
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
console.log(JSON.stringify({ origin: f.origin, participants: f.participants }));
