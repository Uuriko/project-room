#!/usr/bin/env node
// Rank open listings for a seeker JSON. Does not claim.
// Usage: node scripts/matchmaking.mjs --seeker seeker.json --listings listings.json
//        node scripts/matchmaking.mjs --seeker seeker.json --tasks tasks.json
// --tasks ranks public-work-task/1 packets from a local file. Both modes are
// purely local: this CLI never fetches work and never posts a claim.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { matchListings, matchPublicTasks } from "../client/matchmaking.mjs";

export function parseMatchArgs(argv) {
  const args = argv.slice(2);
  const out = { seeker: null, listings: null, tasks: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seeker" && args[i + 1]) { out.seeker = args[++i]; continue; }
    if (args[i] === "--listings" && args[i + 1]) { out.listings = args[++i]; continue; }
    if (args[i] === "--tasks" && args[i + 1]) { out.tasks = args[++i]; continue; }
    return null;
  }
  if (!out.seeker) return null;
  if (Boolean(out.listings) === Boolean(out.tasks)) return null;
  return out;
}

export function matchFromFiles(seekerText, listingsText) {
  const seeker = JSON.parse(seekerText);
  const listings = JSON.parse(listingsText);
  if (!Array.isArray(listings)) throw new Error("listings must be a JSON array");
  return matchListings(seeker, listings);
}

export function matchPacketsFromFiles(seekerText, tasksText) {
  const seeker = JSON.parse(seekerText);
  const tasks = JSON.parse(tasksText);
  if (!Array.isArray(tasks)) throw new Error("tasks must be a JSON array");
  return matchPublicTasks(seeker, tasks);
}

export async function main(argv = process.argv, io = { read: readFileSync, log: console.log, error: console.error }) {
  const parsed = parseMatchArgs(argv);
  if (!parsed) {
    io.error("Usage: node scripts/matchmaking.mjs --seeker seeker.json (--listings listings.json | --tasks tasks.json)");
    process.exitCode = 2;
    return;
  }
  try {
    const seekerText = io.read(parsed.seeker, "utf8");
    const hits = parsed.tasks
      ? matchPacketsFromFiles(seekerText, io.read(parsed.tasks, "utf8"))
      : matchFromFiles(seekerText, io.read(parsed.listings, "utf8"));
    io.log(JSON.stringify(hits));
  } catch (error) {
    io.error(error.message || String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
