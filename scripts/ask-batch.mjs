#!/usr/bin/env node
// ask-batch.mjs — validate + format a worker ASK block (docs/ASK-BATCHING.md).
//
// An ASK block batches a worker's questions (max 5, each <=140 chars, tagged
// blocking|advisory) so the coordinator answers them all in ONE round-trip.
// This tool validates the block and renders it for the room log or for the
// worker receipt's openQuestions field (docs/RECEIPT-SCHEMA.md v1).
//
// Usage:
//   node scripts/ask-batch.mjs --block <path.json | -> [--format room|receipt]
//        [--max-questions <n>] [--max-chars <n>]
//        -  : read the block JSON from stdin
//
// Exit 0: block valid; formatted output on stdout.
// Exit 2: bad arguments or validation failure (reasons on stderr).
//
// Node stdlib only.

import { readFileSync } from "node:fs";
import { stdin, argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_QUESTIONS = 5;
const DEFAULT_MAX_CHARS = 140;
const TAGS = new Set(["blocking", "advisory"]);
// Receipt openQuestions cap (docs/RECEIPT-SCHEMA.md v1): 3 entries x 140 chars.
const RECEIPT_MAX_ITEMS = 3;
const RECEIPT_MAX_CHARS = 140;
const KNOWN_BLOCK_FIELDS = new Set(["v", "workerId", "waveId", "ts", "questions"]);
const KNOWN_Q_FIELDS = new Set(["id", "tag", "text"]);

function normText(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

// validateAskBlock(block, opts) -> { errors: string[], warnings: string[] }
export function validateAskBlock(block, opts = {}) {
  const maxQ = opts.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const maxC = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);

  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    err("block: expected a JSON object");
    return { errors, warnings };
  }
  for (const k of Object.keys(block)) {
    if (!KNOWN_BLOCK_FIELDS.has(k)) warnings.push(`block: unknown field ${JSON.stringify(k)} (ignored)`);
  }
  if (block.v !== SCHEMA_VERSION) err(`v: expected ${SCHEMA_VERSION}, got ${JSON.stringify(block.v)}`);
  if (typeof block.workerId !== "string" || block.workerId.length < 1 || block.workerId.length > 64)
    err(`workerId: expected 1-64 char string, got ${JSON.stringify(block.workerId)}`);
  if (typeof block.waveId !== "string" || block.waveId.length < 1 || block.waveId.length > 64)
    err(`waveId: expected 1-64 char string, got ${JSON.stringify(block.waveId)}`);

  const qs = block.questions;
  if (!Array.isArray(qs)) {
    err(`questions: expected array, got ${typeof qs}`);
    return { errors, warnings };
  }
  if (qs.length < 1) err(`questions: need at least 1, got 0`);
  if (qs.length > maxQ) err(`questions: ${qs.length} exceeds max ${maxQ}`);

  const seenIds = new Set();
  const seenTexts = new Set();
  qs.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (q === null || typeof q !== "object" || Array.isArray(q)) {
      err(`${at}: expected object`); return;
    }
    for (const k of Object.keys(q)) {
      if (!KNOWN_Q_FIELDS.has(k)) warnings.push(`${at}: unknown field ${JSON.stringify(k)} (ignored)`);
    }
    if (typeof q.id !== "string" || q.id.length < 1 || q.id.length > 32) {
      err(`${at}.id: expected 1-32 char string, got ${JSON.stringify(q.id)}`);
    } else if (seenIds.has(q.id)) {
      err(`${at}.id: duplicate id ${JSON.stringify(q.id)}`);
    } else {
      seenIds.add(q.id);
    }
    if (!TAGS.has(q.tag)) {
      err(`${at}.tag: expected "blocking"|"advisory", got ${JSON.stringify(q.tag)}`);
    }
    if (typeof q.text !== "string" || q.text.length < 1) {
      err(`${at}.text: expected non-empty string`);
    } else {
      if (q.text.length > maxC) err(`${at}.text: ${q.text.length} chars exceeds max ${maxC}`);
      const n = normText(q.text);
      if (seenTexts.has(n)) err(`${at}.text: duplicate of an earlier question (normalized match)`);
      else seenTexts.add(n);
    }
  });

  return { errors, warnings };
}

// formatRoom(block) -> multi-line room-log block.
export function formatRoom(block) {
  const qs = block.questions;
  const nBlocking = qs.filter((q) => q.tag === "blocking").length;
  const nAdvisory = qs.length - nBlocking;
  const lines = [
    `ASK [${block.workerId}] ${block.waveId} — ${nBlocking} blocking · ${nAdvisory} advisory (1 block = 1 round-trip)`,
  ];
  for (const q of qs) lines.push(`[${q.tag}] ${q.id}: ${q.text}`);
  return lines.join("\n") + "\n";
}

// formatReceipt(block) -> JSON array pasteable into receipt openQuestions:
// blocking first, at most RECEIPT_MAX_ITEMS entries, each "[tag] text"
// truncated to RECEIPT_MAX_CHARS.
export function formatReceipt(block) {
  const sorted = [...block.questions].sort((a, b) =>
    (a.tag === "blocking" ? 0 : 1) - (b.tag === "blocking" ? 0 : 1)
  );
  const items = sorted.slice(0, RECEIPT_MAX_ITEMS).map((q) => {
    const prefix = `[${q.tag}] `;
    const budget = RECEIPT_MAX_CHARS - prefix.length;
    const text = q.text.length > budget ? q.text.slice(0, budget - 1) + "…" : q.text;
    return prefix + text;
  });
  return JSON.stringify(items);
}

function readInput(path) {
  if (path === "-") return readFileSync(0, "utf8");
  return readFileSync(path, "utf8");
}

function usage() {
  return [
    "usage: node scripts/ask-batch.mjs --block <path.json | -> [--format room|receipt]",
    "       [--max-questions <n>] [--max-chars <n>]",
    "",
    "Validates an ASK block (docs/ASK-BATCHING.md) and formats it for the",
    "room log (default) or the worker receipt openQuestions field.",
    "Exit 0: valid, formatted output on stdout. Exit 2: invalid (reasons on stderr).",
  ].join("\n");
}

function main() {
  const args = argv.slice(2);
  let blockPath = null;
  let format = "room";
  let maxQuestions = DEFAULT_MAX_QUESTIONS;
  let maxChars = DEFAULT_MAX_CHARS;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--block") blockPath = args[++i];
    else if (a === "--format") format = args[++i];
    else if (a === "--max-questions") maxQuestions = Number(args[++i]);
    else if (a === "--max-chars") maxChars = Number(args[++i]);
    else if (a === "-h" || a === "--help") { console.log(usage()); exit(0); }
    else { console.error(`unknown argument: ${a}\n${usage()}`); exit(2); }
  }
  if (!blockPath) { console.error(`missing --block\n${usage()}`); exit(2); }
  if (format !== "room" && format !== "receipt") {
    console.error(`--format must be room|receipt, got ${JSON.stringify(format)}`); exit(2);
  }
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1) {
    console.error(`--max-questions must be a positive int`); exit(2);
  }
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    console.error(`--max-chars must be a positive int`); exit(2);
  }

  let raw;
  try { raw = readInput(blockPath); }
  catch (e) { console.error(`cannot read block: ${e.message}`); exit(2); }
  let block;
  try { block = JSON.parse(raw); }
  catch (e) { console.error(`block is not valid JSON: ${e.message}`); exit(2); }

  const { errors, warnings } = validateAskBlock(block, { maxQuestions, maxChars });
  for (const w of warnings) console.error(`warning: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    exit(2);
  }
  process.stdout.write(format === "receipt" ? formatReceipt(block) + "\n" : formatRoom(block));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
