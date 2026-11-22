// Bounded, room-scoped diagnostic records for support exports. Records carry
// only operation metadata: never credentials, request bodies, message text or
// member details. Routes are stored with the room id templated out.
//
// Two bounds: `capacity` caps entries per room (oldest-first FIFO window);
// `maxRooms` caps the number of room keys with a least-recently-used
// eviction, so a long-lived process cannot grow the room map without bound.
import { setupMilestones } from "./setup-milestones.mjs";

export class DiagnosticsLog {
  constructor(capacity = 200, { maxRooms = 1000 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new Error("Diagnostics capacity must be an integer from 1 to 10000");
    if (!Number.isInteger(maxRooms) || maxRooms < 1 || maxRooms > 100000) throw new Error("Diagnostics maxRooms must be an integer from 1 to 100000");
    this.capacity = capacity;
    this.maxRooms = maxRooms;
    this.records = new Map();
  }
  record({ operationId, at, status, code, category, route, roomId }) {
    if (typeof roomId !== "string" || !roomId) return;
    const entry = { operationId, at, status, code, category, route };
    let list = this.records.get(roomId);
    if (!list) { list = []; this.records.set(roomId, list); }
    else { this.records.delete(roomId); this.records.set(roomId, list); } // mark most-recently-used
    list.push(entry);
    if (list.length > this.capacity) list.splice(0, list.length - this.capacity);
    while (this.records.size > this.maxRooms) this.records.delete(this.records.keys().next().value); // evict least-recently-used room
  }
  list(roomId) {
    return (this.records.get(roomId) ?? []).map(entry => ({ ...entry }));
  }
}

// Support-export bundle: a sanitized, downloadable snapshot an operator can
// hand to support. Only whitelisted scalar fields are emitted — never
// credentials, hashes, request bodies, message text, or member details.
// Records and version info are copied by value so callers cannot mutate the log.
// When setup evidence for one agent is supplied, the bundle also carries its
// setup milestones, so support starts from the last step that really happened.
export function supportExportBundle({ roomId, roomTitle, service, diagnostics, setup }) {
  const safeString = value => typeof value === "string" ? value : "";
  const records = Array.isArray(diagnostics) ? diagnostics : [];
  return {
    format: "project-room-support-export-v1",
    exportedAt: new Date().toISOString(),
    service: {
      sourceRevision: safeString(service?.sourceRevision),
      buildId: safeString(service?.buildId),
      mode: safeString(service?.mode),
    },
    room: { id: safeString(roomId), title: safeString(roomTitle) },
    diagnostics: records.map(entry => ({
      operationId: safeString(entry.operationId),
      at: safeString(entry.at),
      status: Number.isSafeInteger(entry.status) ? entry.status : 0,
      code: safeString(entry.code),
      category: safeString(entry.category),
      route: safeString(entry.route),
    })),
    ...(setup && typeof setup.agentId === "string" ? { setup: setupSummary(setup) } : {}),
  };
}

// nextStep can quote the agent's own limitation text; bound and flatten it
// like the other fields in this bundle.
const flat = (value, max) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[^\P{C}]/gu, "").trim().slice(0, max);

function setupSummary({ agentId, events, setupReport, heartbeats }) {
  const state = setupMilestones(events, { agentId, setupReport, heartbeats });
  const step = name => ({ done: state[name].done, at: state[name].at });
  return {
    agentId,
    connected: step("connected"),
    firstExchange: step("firstExchange"),
    backgroundRun: step("backgroundRun"),
    scheduleSaved: state.scheduleSaved,
    nextStep: state.next.text === null ? null : flat(state.next.text, 400),
  };
}
