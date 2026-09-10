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
