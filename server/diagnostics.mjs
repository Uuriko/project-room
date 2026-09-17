// Bounded, room-scoped diagnostic records for support exports. Records carry
// only operation metadata: never credentials, request bodies, message text or
// member details. Routes are stored with the room id templated out.
export class DiagnosticsLog {
  constructor(capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) throw new Error("Diagnostics capacity must be an integer from 1 to 10000");
    this.capacity = capacity;
    this.records = new Map();
  }
  record({ operationId, at, status, code, category, route, roomId }) {
    if (typeof roomId !== "string" || !roomId) return;
    const entry = { operationId, at, status, code, category, route };
    let list = this.records.get(roomId);
    if (!list) { list = []; this.records.set(roomId, list); }
    list.push(entry);
    if (list.length > this.capacity) list.splice(0, list.length - this.capacity);
  }
  list(roomId) {
    return (this.records.get(roomId) ?? []).map(entry => ({ ...entry }));
  }
}

// Support-export bundle: a sanitized, downloadable snapshot an operator can
// hand to support. Only whitelisted scalar fields are emitted — never
// credentials, hashes, request bodies, message text, or member details.
// Records and version info are copied by value so callers cannot mutate the log.
export function supportExportBundle({ roomId, roomTitle, service, diagnostics }) {
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
  };
}
