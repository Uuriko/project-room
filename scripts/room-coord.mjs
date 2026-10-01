#!/usr/bin/env node
// room-coord: claim, renew, hand off and land work through the room's typed
// work-claim registry instead of chat prose or GitHub comments.
// See docs/ROOM-COORDINATION.md. Output is JSON unless --md is given.
import { pathToFileURL } from "node:url";
import { agentConnectionFromEnvironment, connectionDiagnostic } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomLandClient } from "../client/room-land.mjs";
import { CoordError, claimAndVerify, coordStatus, digest, handoff, land, renewWithProgress, verifyClaim } from "../client/room-coord.mjs";

export const USAGE = `Usage: room-coord <command> [options]
  status [--md] [--expiring-min N]       live claims, mine, expiring, overlaps, land queue
  claim <id> --files a,b [--title T] [--lease-hours N] [--note T] [--allow-overlap]
  renew <id> --progress "what moved" [--lease-hours N]
  handoff <id> --to <memberId> --summary "done so far" [--next "next step"] [--handle name]
  release <id> [--note T]
  done <id> [--note T]
  land --repo owner/name --pr N
  digest [--after SEQ] [--limit N]       markdown digest; every line cites a seq or claim id
Connection: ROOM_AGENT_CONFIG=<dir> or ROOM_AGENT_ORIGIN/ROOM/MEMBER/TOKEN.`;

const FLAGS = new Set(["md", "allow-overlap"]);

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (FLAGS.has(key)) { options[key] = true; continue; }
    const value = inline ?? argv[i + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new CoordError("usage_error", `--${key} needs a value`);
    if (inline === undefined) i += 1;
    options[key] = value;
  }
  return { command: positional[0], positional: positional.slice(1), options };
}

const integer = (value, label, fallback) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new CoordError("usage_error", `${label} must be a whole number`);
  return n;
};
const list = value => (value === undefined ? undefined : String(value).split(",").map(item => item.trim()).filter(Boolean));
const required = (value, label) => {
  if (value === undefined || value === "") throw new CoordError("usage_error", `${label} is required`);
  return value;
};

export async function run(argv, { client, lander, memberId, now } = {}) {
  const { command, positional, options } = parseArgs(argv);
  const id = positional[0];
  switch (command) {
    case "status": {
      const status = await coordStatus(client, { lander, memberId, now, expiringWithinMs: integer(options["expiring-min"], "--expiring-min", 60) * 60_000 });
      return options.md ? digest({ status }) : status;
    }
    case "claim":
      return claimAndVerify(client, required(id, "Claim id"), { memberId, now, files: list(options.files), title: options.title,
        note: options.note, leaseHours: integer(options["lease-hours"], "--lease-hours", undefined), allowOverlap: Boolean(options["allow-overlap"]) });
    case "renew":
      return renewWithProgress(client, required(id, "Claim id"), required(options.progress, "--progress"),
        { memberId, now, leaseHours: integer(options["lease-hours"], "--lease-hours", undefined) });
    case "handoff":
      return handoff(client, required(id, "Claim id"), { to: required(options.to, "--to"), toHandle: options.handle,
        summary: required(options.summary, "--summary"), next: options.next, now });
    case "release":
      await client.releaseWorkItem(required(id, "Claim id"), { note: options.note });
      return client.workClaimGet(id);
    case "done":
      await client.workComplete(required(id, "Claim id"), { note: options.note });
      return client.workClaimGet(id);
    case "verify":
      return verifyClaim(await client.workClaimGet(required(id, "Claim id")), { memberId, now });
    case "land":
      return land(lander, { repo: required(options.repo, "--repo"), prNumber: integer(required(options.pr, "--pr"), "--pr") });
    case "digest": {
      const after = integer(options.after, "--after", 0);
      const page = await client.changes(after, integer(options.limit, "--limit", 100));
      const status = await coordStatus(client, { lander, memberId, now });
      return digest({ events: page?.events ?? [], status });
    }
    default:
      throw new CoordError("usage_error", USAGE);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return; }
  let config;
  try { config = agentConnectionFromEnvironment(); }
  catch (error) { console.error(JSON.stringify(connectionDiagnostic(error))); process.exitCode = 3; return; }
  const client = new RoomAgentClient(config);
  const lander = new RoomLandClient(config);
  try {
    const result = await run(argv, { client, lander, memberId: config.memberId });
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof CoordError) {
      console.error(JSON.stringify({ code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, null, 2));
      process.exitCode = error.code === "usage_error" ? 2 : 1;
      return;
    }
    console.error(JSON.stringify(connectionDiagnostic(error)));
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
