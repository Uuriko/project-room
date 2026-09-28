#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PAID_WORK_OFFERS, preparePaidWork } from "../src/paid-work-offers.js";

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "catalog") return PAID_WORK_OFFERS;
  if (!["prepare", "command"].includes(args[0]) || args.length !== 2) throw new Error("Usage: node scripts/paid-work.mjs catalog | prepare brief.json | command brief.json");
  const bytes = readFileSync(args[1]);
  if (bytes.length > 32768) throw new Error("Brief exceeds 32 KiB");
  const prepared = preparePaidWork(JSON.parse(bytes.toString("utf8")));
  // Only this view is for submission. The full prepare view includes PRIVATE costs.
  return args[0] === "command" ? prepared.command : prepared;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(main(), null, 2)); }
  catch (error) {
    // Syntax errors may quote confidential input. Do not echo them.
    console.error(error instanceof SyntaxError ? "Invalid JSON brief" : error.code ? "Could not read brief file" : error.message);
    process.exitCode = 1;
  }
}
