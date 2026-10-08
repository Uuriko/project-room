#!/usr/bin/env node
/**
 * register-intent.mjs — register a probing intent into the guild load-calendar registry.
 *
 * Usage: node register-intent.mjs --intent <intent.json> --registry <registry.json>
 *
 * - Validates the intent against intent.schema.json (hand-rolled draft-07 subset validator).
 * - Enforces the convention's hard rules:
 *     * kind in {write, flood, mint} REQUIRES scratch_only === true AND target starting with "scratch:"
 *     * ramp === "burst" REQUIRES target starting with "scratch:"
 *     * window_end must be after window_start
 *     * intent_id must not already exist in the registry
 * - Appends the intent (with registered_at timestamp) to the registry JSON array.
 * - Exit 0 on success, printing the intent_id. Exit non-zero with the exact reason on failure.
 *
 * Stdlib only. Never probes anything; this file only touches local files.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, 'intent.schema.json');
const SCRATCH_KINDS = new Set(['write', 'flood', 'mint', 'claim-update']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(reason) {
  process.stderr.write(`register-intent: ${reason}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--intent' || a === '--registry') && i + 1 < argv.length) {
      out[a.slice(2)] = argv[++i];
    } else {
      fail(`unknown or incomplete argument: ${a} (expected --intent <file> --registry <file>)`);
    }
  }
  if (!out.intent) fail('missing required argument --intent <file>');
  if (!out.registry) fail('missing required argument --registry <file>');
  return out;
}

function isDateTime(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function checkType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && !Number.isNaN(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    default: return false;
  }
}

/** Minimal draft-07 subset validator driven by the schema file's own constraints. */
function validate(obj, schema, path = '') {
  const errors = [];
  const label = (p) => (p ? `at '${p}'` : 'at root');

  if (!checkType(obj, schema.type)) {
    errors.push(`${label(path)}: expected type '${schema.type}'`);
    return errors; // no point checking sub-keywords on a type mismatch
  }
  if (schema.type !== 'object') return errors;

  for (const key of schema.required || []) {
    if (!(key in obj)) errors.push(`${label(path)}: missing required field '${key}'`);
  }

  for (const key of Object.keys(obj)) {
    const sub = (schema.properties || {})[key];
    const p = path ? `${path}.${key}` : key;
    if (!sub) {
      if (schema.additionalProperties === false) {
        errors.push(`${label(path)}: unexpected field '${key}' (schema allows no additional properties)`);
      }
      continue;
    }
    const v = obj[key];
    if (!checkType(v, sub.type)) {
      errors.push(`at '${p}': expected type '${sub.type}'`);
      continue;
    }
    if (sub.enum && !sub.enum.includes(v)) {
      errors.push(`at '${p}': '${v}' is not one of [${sub.enum.join(', ')}]`);
    }
    if (typeof v === 'string') {
      if (sub.minLength != null && v.length < sub.minLength) {
        errors.push(`at '${p}': must not be empty`);
      }
      if (sub.format === 'uuid' && !UUID_RE.test(v)) {
        errors.push(`at '${p}': '${v}' is not a valid uuid`);
      }
      if (sub.format === 'date-time' && !isDateTime(v)) {
        errors.push(`at '${p}': '${v}' is not a valid date-time`);
      }
    }
    if (typeof v === 'number') {
      if (sub.minimum != null && v < sub.minimum) {
        errors.push(`at '${p}': ${v} is below minimum ${sub.minimum}`);
      }
      if (sub.exclusiveMinimum != null && !(v > sub.exclusiveMinimum)) {
        errors.push(`at '${p}': ${v} must be > ${sub.exclusiveMinimum}`);
      }
    }
  }
  return errors;
}

function enforceHardRules(intent) {
  const reasons = [];

  if (SCRATCH_KINDS.has(intent.kind)) {
    if (intent.scratch_only !== true) {
      reasons.push(
        `kind '${intent.kind}' REQUIRES scratch_only=true (got ${intent.scratch_only})`
      );
    }
    if (!intent.target.startsWith('scratch:')) {
      reasons.push(
        `kind '${intent.kind}' REQUIRES a scratch: target (got '${intent.target}')`
      );
    }
  }

  if (intent.ramp === 'burst' && !intent.target.startsWith('scratch:')) {
    reasons.push(`ramp 'burst' is only legal on scratch: targets (got '${intent.target}')`);
  }

  const start = Date.parse(intent.window_start);
  const end = Date.parse(intent.window_end);
  if (!(end > start)) {
    reasons.push(
      `window_end must be after window_start (got start='${intent.window_start}' end='${intent.window_end}')`
    );
  }

  return reasons;
}

function loadRegistry(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) fail(`registry '${path}' is not a JSON array`);
    return data;
  } catch (err) {
    if (err && err.code === 'ENOENT') return []; // registry is created on first registration
    if (err instanceof SyntaxError) fail(`registry '${path}' is not valid JSON`);
    throw err;
  }
}

function main() {
  const { intent: intentPath, registry: registryPath } = parseArgs(process.argv.slice(2));

  let schema;
  try {
    schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  } catch (err) {
    fail(`cannot load schema at ${SCHEMA_PATH}: ${err.message}`);
  }

  let intent;
  try {
    intent = JSON.parse(readFileSync(resolve(intentPath), 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') fail(`intent file not found: ${intentPath}`);
    fail(`intent file is not valid JSON: ${err.message}`);
  }

  const schemaErrors = validate(intent, schema);
  if (schemaErrors.length > 0) {
    fail(`schema validation failed:\n  - ${schemaErrors.join('\n  - ')}`);
  }

  const ruleErrors = enforceHardRules(intent);
  if (ruleErrors.length > 0) {
    fail(`hard rule violation:\n  - ${ruleErrors.join('\n  - ')}`);
  }

  const registry = loadRegistry(resolve(registryPath));
  if (registry.some((r) => r && r.intent_id === intent.intent_id)) {
    fail(`duplicate intent_id '${intent.intent_id}' already registered in '${registryPath}'`);
  }

  const entry = { ...intent, registered_at: new Date().toISOString() };
  registry.push(entry);
  writeFileSync(resolve(registryPath), JSON.stringify(registry, null, 2) + '\n', 'utf8');

  process.stdout.write(`${intent.intent_id}\n`);
  process.exit(0);
}

main();
