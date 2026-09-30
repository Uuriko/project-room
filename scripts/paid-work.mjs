#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PAID_WORK_OFFERS, preparePaidWork } from "../src/paid-work-offers.js";

import { prepareContributionBrief, contributionMarkdown } from "../src/contribution-brief.js";

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "catalog") return PAID_WORK_OFFERS;
  if (!["prepare", "command", "markdown", "skill"].includes(args[0]) || ![2, 4].includes(args.length) || args.length === 4 && args[2] !== "--context") throw new Error("Usage: node scripts/paid-work.mjs catalog | prepare|command|markdown|skill brief.json [--context context.json]");
  const bytes = readFileSync(args[1]);
  if (bytes.length > 32768) throw new Error("Brief exceeds 32 KiB");
  const input = JSON.parse(bytes.toString("utf8"));
  let context;
  if (args.length === 4) {
    const contextBytes = readFileSync(args[3]);
    if (contextBytes.length > 262144) throw new Error("Context exceeds 256 KiB");
    context = JSON.parse(contextBytes.toString("utf8"));
  }
  const prepared = input.reward ? prepareContributionBrief(input, { context }) : preparePaidWork(input, { context });
  if (args[0] === "markdown" || args[0] === "skill") return contributionMarkdown(prepared, { skill: args[0] === "skill" });
  // Only this view is for submission. The full prepare view includes PRIVATE costs.
  return args[0] === "command" ? prepared.command : prepared;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const output = main(); console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2)); }
  catch (error) {
    // Syntax errors may quote confidential input. Do not echo them.
    console.error(error instanceof SyntaxError ? "Invalid JSON brief" : error.code ? "Could not read brief file" : error.message);
    process.exitCode = 1;
  }
}
