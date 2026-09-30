#!/usr/bin/env node
// Rank open listings for a seeker JSON. Does not claim.
// Usage: node scripts/matchmaking.mjs --seeker seeker.json --listings listings.json
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { matchListings } from "../client/matchmaking.mjs";

export function parseMatchArgs(argv) {
  const args = argv.slice(2);
  const out = { seeker: null, listings: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--seeker" && args[i + 1]) { out.seeker = args[++i]; continue; }
    if (args[i] === "--listings" && args[i + 1]) { out.listings = args[++i]; continue; }
    return null;
  }
  if (!out.seeker || !out.listings) return null;
  return out;
}

export function matchFromFiles(seekerText, listingsText) {
  const seeker = JSON.parse(seekerText);
  const listings = JSON.parse(listingsText);
  if (!Array.isArray(listings)) throw new Error("listings must be a JSON array");
  return matchListings(seeker, listings);
}

export async function main(argv = process.argv, io = { read: readFileSync, log: console.log, error: console.error }) {
  const parsed = parseMatchArgs(argv);
  if (!parsed) {
    io.error("Usage: node scripts/matchmaking.mjs --seeker seeker.json --listings listings.json");
    process.exitCode = 2;
    return;
  }
  try {
    io.log(JSON.stringify(matchFromFiles(io.read(parsed.seeker, "utf8"), io.read(parsed.listings, "utf8"))));
  } catch (error) {
    io.error(error.message || String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
