// Track C slice C11 — Growth collector persistence.
//
// Snapshot/restore for the C2 collector, so growth analytics survive server
// restarts. The snapshot is its own JSON file on disk — it never touches the
// room store schema (no STORE_SCHEMA_VERSION change, no migration).
//
// This module owns the JSON envelope format and the collector re-creation
// invariants; server code only calls loadFromFile/saveToFile at boot and
// shutdown. All I/O failures at the file layer are either returned as
// "not restored" (missing file) or thrown as clear Errors for the caller to
// catch — persistence failures must never crash the room path.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { createCollector } from "./growth-collector.js";
import { validateEvent } from "./growth-events.js";

export const GROWTH_SNAPSHOT_VERSION = 1;

const isPlainObject = value =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireCollector = collector => {
  if (!isPlainObject(collector) || typeof collector.query !== "function" || typeof collector.stats !== "function") {
    throw new TypeError("snapshot: collector must be a C2 collector (query/stats)");
  }
  return collector;
};

// Serialize a collector to a JSON string. Uses only the collector's public
// API (stats + query), never its internals. Events are stored oldest-first so
// a restore replays them in natural order.
export function snapshot(collector) {
  const c = requireCollector(collector);
  const stats = c.stats();
  const events = [...c.query({ limit: stats.capacity })].reverse();
  return JSON.stringify({
    version: GROWTH_SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    capacity: stats.capacity,
    events
  });
}

// Parse and validate a snapshot string. Fail-closed: any corrupt input throws
// a clear Error and no partial state is ever returned.
export function restore(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("restore: snapshot is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("restore: snapshot must be a JSON object");
  if (parsed.version !== GROWTH_SNAPSHOT_VERSION) {
    throw new Error(`restore: unsupported snapshot version ${JSON.stringify(parsed.version)} (expected ${GROWTH_SNAPSHOT_VERSION})`);
  }
  const capacity = parsed.capacity;
  if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1) {
    throw new Error("restore: snapshot capacity must be a positive integer");
  }
  if (!Array.isArray(parsed.events)) throw new Error("restore: snapshot events must be an array");
  // Re-validate every envelope against the C1 contract as-is: version drift,
  // unknown types, sensitive fields, or bad actors fail closed.
  const events = parsed.events.map((event, index) => {
    try {
      return validateEvent(event);
    } catch (err) {
      throw new Error(`restore: event at index ${index} failed validation: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // Bounded: a snapshot larger than its capacity keeps the newest events and
  // counts what was dropped, mirroring the collector's ring-buffer semantics.
  const droppedOldest = Math.max(0, events.length - capacity);
  const kept = droppedOldest === 0 ? events : events.slice(events.length - capacity);
  const exportedAt = typeof parsed.exportedAt === "string" ? parsed.exportedAt : null;
  return Object.freeze({
    version: GROWTH_SNAPSHOT_VERSION,
    exportedAt,
    capacity,
    events: Object.freeze(kept),
    droppedOldest
  });
}

// Build a live collector from a snapshot string. Re-records every validated
// envelope through the normal record path so counters and drop invariants
// hold exactly as they would for live traffic.
export function loadCollector(json) {
  return loadCollectorWithMeta(json).collector;
}

function loadCollectorWithMeta(json) {
  const restored = restore(json);
  const collector = createCollector({ maxEvents: restored.capacity });
  for (const event of restored.events) {
    const result = collector.record(event);
    if (!result.ok) throw new Error(`loadCollector: re-record failed: ${result.reason}`);
  }
  return { collector, exportedAt: restored.exportedAt };
}

// Read a snapshot file. A missing file is normal on first boot: it returns an
// empty collector with restored=false. Corrupt content throws — the caller
// (server boot) must catch it and continue with an empty collector.
export function loadFromFile(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { restored: false, collector: createCollector(), exportedAt: null, warning: null };
    }
    throw new Error(`loadFromFile: cannot read ${filePath}: ${error?.message ?? error}`);
  }
  const { collector, exportedAt } = loadCollectorWithMeta(text);
  return { restored: true, collector, exportedAt, warning: null };
};

// Write the collector's snapshot to a file, creating parent directories.
// The write is atomic: the snapshot is staged to a unique temp file in the
// same directory and then renamed over the target. A crash or SIGKILL
// mid-write can only orphan the temp file — the previous snapshot is never
// torn, so the next boot still restores cleanly. Throws on failure — the
// caller (server shutdown) must catch and log.
export function saveToFile(filePath, collector) {
  requireCollector(collector);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, snapshot(collector), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* best effort: never mask the real error */ }
    throw error;
  }
  return filePath;
}
