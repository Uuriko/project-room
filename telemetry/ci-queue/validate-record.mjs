// Zero-dep validator for ci.queue_depth_sample records (FIX-22c).
// Checks the record against telemetry/ci-queue/queue-depth-schema.json
// without any external schema library.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, "queue-depth-schema.json");

let schema = null;
export function loadSchema() {
  if (!schema) schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  return schema;
}

function checkType(value, prop) {
  if (Array.isArray(prop.type)) {
    return prop.type.some((t) => checkType(value, { ...prop, type: t }));
  }
  switch (prop.type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

export function validateRecord(record, schemaOverride = null) {
  const errors = [];
  const s = schemaOverride || loadSchema();
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["record must be a JSON object"] };
  }
  for (const field of s.required || []) {
    if (!(field in record)) errors.push(`missing required field: ${field}`);
  }
  for (const [name, prop] of Object.entries(s.properties || {})) {
    if (!(name in record)) continue;
    const value = record[name];
    if (!checkType(value, prop)) {
      errors.push(`field ${name}: expected ${JSON.stringify(prop.type)}, got ${value === null ? "null" : typeof value}`);
      continue;
    }
    if (prop.const !== undefined && value !== prop.const) {
      errors.push(`field ${name}: expected const ${JSON.stringify(prop.const)}`);
    }
    if (typeof value === "number" && prop.minimum !== undefined && value < prop.minimum) {
      errors.push(`field ${name}: ${value} below minimum ${prop.minimum}`);
    }
    if (prop.format === "date-time" && Number.isNaN(Date.parse(value))) {
      errors.push(`field ${name}: not a valid date-time`);
    }
  }
  return { ok: errors.length === 0, errors };
}
