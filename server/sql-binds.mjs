// Durable Object SQL (the Worker's room database) rejects a statement with
// more than 100 bound parameters: "too many SQL variables". Node's SQLite
// allows far more, so a list that grows with input passes the Node suite and
// fails on prod. Bind such lists in chunks of SQL_BIND_CHUNK, which leaves
// room for the handful of fixed binds (room_id, agent_id, ...) around them.
export const DO_SQL_BIND_LIMIT = 100;
export const SQL_BIND_CHUNK = 90;

export function* sqlChunks(values, size = SQL_BIND_CHUNK) {
  for (let at = 0; at < values.length; at += size) yield values.slice(at, at + size);
}

export const sqlPlaceholders = values => values.map(() => "?").join(",");
