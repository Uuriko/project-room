#!/usr/bin/env node
// Print a slop.cash-style paste packet from a bounty JSON object on stdin.
// Usage: node scripts/bounty-brief.mjs [--skill] [--origin URL] [--room ROOM_ID] < bounty.json
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { renderBountyPacket } from "../client/bounty-brief.mjs";

export function parseBriefArgs(argv) {
  const out = { format: "brief", origin: null, roomId: null };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--skill") { out.format = "skill"; continue; }
    if (args[i] === "--origin" && args[i + 1]) { out.origin = args[++i]; continue; }
    if (args[i] === "--room" && args[i + 1]) { out.roomId = args[++i]; continue; }
    return null;
  }
  return out;
}

export function briefFromStdinJson(text, opts) {
  let bounty;
  try { bounty = JSON.parse(text); }
  catch { throw new Error("stdin must be one bounty JSON object"); }
  return renderBountyPacket(bounty, opts);
}

export async function main(argv = process.argv, io = { read: () => readFileSync(0, "utf8"), log: console.log, error: console.error }) {
  const parsed = parseBriefArgs(argv);
  if (!parsed) {
    io.error("Usage: node scripts/bounty-brief.mjs [--skill] [--origin URL] [--room ROOM_ID] < bounty.json");
    process.exitCode = 2;
    return;
  }
  try {
    io.log(briefFromStdinJson(io.read(), parsed));
  } catch (error) {
    io.error(error.message || String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
