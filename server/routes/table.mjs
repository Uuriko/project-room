// Declarative HTTP route table (batch RT).
//
// Every route that has left the legacy chain in server/http.mjs is one frozen
// row. The table starts empty: dispatch falls through and behaviour is unchanged.
// Batch C fills `capability`. SPLIT reads `scope`. Both columns are required now.

export const AUTH_CLASSES = Object.freeze(["none", "room", "account", "bearer", "roomToken", "door", "mcp"]);
export const ROUTE_SCOPES = Object.freeze(["worker", "public", "directory", "room"]);
export const ROUTE_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// Frozen and empty until an extraction PR adds rows. Do not push; replace the array.
export const ROUTES = Object.freeze([]);

export function assertRouteRow(row) {
  const problems = [];
  if (!row || typeof row !== "object") return ["row"];
  if (typeof row.id !== "string" || row.id.length === 0) problems.push("id");
  if (!ROUTE_METHODS.includes(row.method)) problems.push("method");
  if (typeof row.path !== "string" || !row.path.startsWith("/")) problems.push("path");
  if (!AUTH_CLASSES.includes(row.auth)) problems.push("auth");
  if (!(row.capability === null || typeof row.capability === "string")) problems.push("capability");
  if (typeof row.handler !== "function") problems.push("handler");
  if (!row.schema || typeof row.schema !== "object" || Array.isArray(row.schema)) problems.push("schema");
  else if (!["params", "query", "body", "response"].some(key => row.schema[key] && typeof row.schema[key] === "object")) problems.push("schema");
  if (!Array.isArray(row.events)) problems.push("events");
  if (!ROUTE_SCOPES.includes(row.scope)) problems.push("scope");
  if (row.rate !== undefined && (typeof row.rate !== "object" || typeof row.rate.key !== "string" || !Number.isInteger(row.rate.max))) problems.push("rate");
  if (row.bodyLimit !== undefined && (!Number.isInteger(row.bodyLimit) || row.bodyLimit < 1)) problems.push("bodyLimit");
  return problems;
}

export function assertRouteTable(routes = ROUTES) {
  const seen = new Set();
  const failures = [];
  for (const row of routes) {
    const problems = assertRouteRow(row);
    if (problems.length) failures.push(`${row?.id ?? "(missing id)"}: ${problems.join(", ")}`);
    else if (seen.has(row.id)) failures.push(`${row.id}: duplicate id`);
    else seen.add(row.id);
  }
  if (failures.length) throw new Error(`route table rejected:\n${failures.map(line => `  ${line}`).join("\n")}`);
  return routes;
}
