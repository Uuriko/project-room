// Weekly and manual entry for the fresh-agent probe.
// The gate report is written beside the result. This process exits 0 so a
// slow week is visible without failing the job. gate.mjs is what exits 1.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeFetch } from "./lib.mjs";
import { runAgentDocs } from "./agent-docs.mjs";
import { runAgentMcp } from "./agent-mcp.mjs";
import { runAgentCode } from "./agent-code.mjs";
import { runHumanHome } from "./human-home.mjs";
import { runHumanInvite } from "./human-invite.mjs";
import { cleanupAll, createdIds } from "./cleanup.mjs";
import { buildResult, currentPaths, renderTable, writeResult } from "./report.mjs";
import { classifyReady } from "./gate.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function sampleReady(origin) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const response = await probeFetch(`${origin}/api/ready`);
    samples.push(response.ms);
  }
  samples.sort((a, b) => a - b);
  return samples[2];
}

async function safe(run) {
  try { return await run(); }
  catch {
    return { status: "not_available", steps: [], firstPost: null, firstClose: null, closeReachable: false, confusions: ["This path stopped with an error."] };
  }
}

async function postOps(origin, table) {
  const token = process.env.ROOM_OPS_POST_TOKEN;
  const roomId = process.env.ROOM_OPS_ROOM_ID;
  if (!token) {
    console.log("not posted: no ops token");
    return;
  }
  if (!roomId) {
    console.log("not posted: no ops room");
    return;
  }
  const body = `${table}\nonboarding_probe_run`;
  try {
    const response = await probeFetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/commands`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body } }),
    });
    console.log(response.status < 300 ? "posted onboarding_probe_run" : "not posted: ops room rejected the update");
  } catch {
    console.log("not posted: ops room rejected the update");
  }
}

const target = arg("--target", "https://room.trydemigod.com");
const runsN = Number(arg("--runs", "5")) || 5;
const outDir = arg("--out", "probe-out");
const origin = target.replace(/\/$/, "");
mkdirSync(outDir, { recursive: true });
const created = { rooms: [], identities: [] };
const baseline = JSON.parse(readFileSync(new URL("../../docs/onboarding-probe/baseline.json", import.meta.url), "utf8"));

let readyMedian = await sampleReady(origin);
let readyState = classifyReady(readyMedian, baseline);
if (readyState.retry) {
  readyMedian = await sampleReady(origin);
  readyState = classifyReady(readyMedian, baseline, { retried: true });
}

const runs = [];
try {
  for (let i = 0; i < runsN; i++) {
    const round = `${process.env.PROBE_ROUND || "run"}r${i}`;
    const [agentDocs, agentMcp, agentCode] = await Promise.all([
      safe(() => runAgentDocs({ target: origin, created, round })),
      safe(() => runAgentMcp({ target: origin })),
      safe(() => runAgentCode({ target: origin, created, round })),
    ]);
    runs.push({ paths: { agentDocs, agentMcp, agentCode } });
  }
  const humanRound = `${process.env.PROBE_ROUND || "run"}h`;
  const humanHome = await safe(() => runHumanHome({ target: origin, outDir, created, round: humanRound }));
  const humanInvite = await safe(() => runHumanInvite({ target: origin, outDir, created, round: `${humanRound}i` }));
  for (const run of runs) {
    run.paths.humanHome = humanHome;
    run.paths.humanInvite = humanInvite;
  }
  const version = await probeFetch(`${origin}/api/version`);
  const paths = currentPaths(runs);
  const table = renderTable(paths, baseline);
  const result = buildResult({
    target: origin,
    sourceRevision: version.json?.sourceRevision ?? null,
    ready: { medianMs: readyMedian, inconclusive: readyState.inconclusive },
    runs,
    paths,
  });
  writeResult(join(outDir, "probe-result.json"), result);
  writeFileSync(join(outDir, "table.md"), table);
  writeFileSync(join(outDir, "created.json"), `${JSON.stringify(createdIds(created), null, 2)}\n`);
  console.log(table);
  await postOps(origin, table);
} finally {
  await cleanupAll(origin, created);
}
