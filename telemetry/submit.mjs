#!/usr/bin/env node
// telemetry-bus submission CLI: builds a finding record and appends it to telemetry/findings.jsonl
// Usage: node telemetry/submit.mjs --guild <g> --claim "<c>" --evidence "<e>" --numbers '{"k":1}'
//        [--category <correctness|performance|security|dx|protocol|onboarding|other>]
//        [--confidence <high|medium|low>] [--agent <name>] [--room-seq N]
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CATEGORIES = ['correctness', 'performance', 'security', 'dx', 'protocol', 'onboarding', 'other'];
const CONFIDENCES = ['high', 'medium', 'low'];
const ID_RE = /^[a-z0-9-]+$/;

function fail(reason) {
  console.error(`telemetry/submit: ${reason}`);
  process.exit(1);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected positional argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) fail(`missing value for --${key}`);
    out[key] = next;
    i++;
  }
  return out;
}

function main() {
  const a = args(process.argv.slice(2));

  if (!a.guild || !a.guild.trim()) fail('--guild is required (non-empty)');
  if (!a.claim || a.claim.length < 10) fail('--claim is required and must be >= 10 chars');
  if (!a.evidence || a.evidence.length < 10) fail('--evidence is required and must be >= 10 chars');

  let numbers;
  if (a.numbers === undefined) {
    numbers = {};
  } else {
    try {
      numbers = JSON.parse(a.numbers);
    } catch {
      fail('--numbers must be valid JSON');
    }
    if (typeof numbers !== 'object' || numbers === null || Array.isArray(numbers)) {
      fail('--numbers must parse to a JSON object (got ' + (Array.isArray(numbers) ? 'array' : typeof numbers) + ')');
    }
  }

  if (a.category !== undefined && !CATEGORIES.includes(a.category)) {
    fail(`--category must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (a.confidence !== undefined && !CONFIDENCES.includes(a.confidence)) {
    fail(`--confidence must be one of: ${CONFIDENCES.join(', ')}`);
  }

  let roomSeq;
  if (a['room-seq'] !== undefined) {
    roomSeq = Number(a['room-seq']);
    if (!Number.isInteger(roomSeq)) fail('--room-seq must be an integer');
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  const id = `tb-${ts}-${hex}`;
  if (!ID_RE.test(id)) fail('internal: generated id failed id pattern (impossible)');

  const record = {
    id,
    guild: a.guild,
    claim: a.claim,
    evidence: a.evidence,
    numbers,
    timestamp: now.toISOString(),
  };
  if (a.category !== undefined) record.category = a.category;
  if (a.confidence !== undefined) record.confidence = a.confidence;
  if (a.agent !== undefined) record.agent = a.agent;
  if (roomSeq !== undefined) record.roomSeq = roomSeq;
  if (a.source !== undefined) record.source = a.source;

  const path = join(process.cwd(), 'telemetry', 'findings.jsonl');
  appendFileSync(path, JSON.stringify(record) + '\n');
  console.log(id);
}

main();
