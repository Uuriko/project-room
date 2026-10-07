// API versioning + deprecation contract (audit lane F3).
//
// - Every REST JSON response carries `X-API-Version` (integer, starts at 1).
// - Deprecated routes carry RFC 8594 `Deprecation` (+ `Sunset` only when a
//   removal is actually scheduled) and a `Link: <successor>;
//   rel="successor-version"` header, so agents learn about deprecations
//   from the wire, not just from docs.
// - Deprecations are registered here, in one frozen registry, so the whole
//   deprecation surface is auditable in one place.
// Policy: docs/API-VERSIONING.md. Precedent: the MCP transport's
// legacyMcpHeaders() (server/mcp-http.mjs) already sends Deprecation for
// pri_ bearer tokens; this generalizes the contract to REST.

export const API_VERSION = "1";

export function versionHeaders() {
  return { "X-API-Version": API_VERSION };
}

// RFC 8594 deprecation instant for the land-queue compatibility routes:
// marked `deprecated: true` in docs/openapi.yaml by 48468c09c (2026-10-05).
const LAND_QUEUE_DEPRECATED_AT = "@1791158400";

const LAND_QUEUE_RE = /^\/api\/rooms\/([^/]{1,384})\/(add_land_item|list_land_queue)$/;

export const DEPRECATIONS = Object.freeze([
  Object.freeze({
    id: "land-queue-compat",
    notice:
      "add_land_item and list_land_queue are compatibility views over work claims of kind land. " +
      "Use the work-claims board instead (POST /api/rooms/{roomId}/work-claims with kind \"land\"). " +
      "The land_queue rows are kept; no removal is scheduled.",
    deprecation: LAND_QUEUE_DEPRECATED_AT,
    // No `sunset` here on purpose: the land_queue rows are kept and no
    // removal is scheduled. A Sunset header is only sent when a removal
    // date actually exists (see validateDeprecations); inventing one would
    // be a lie on the wire.
    test: (pathname) => LAND_QUEUE_RE.exec(pathname),
    successorFor: (match) => `/api/rooms/${match[1]}/work-claims`,
  }),
]);

// Headers for a request pathname, or null when nothing is deprecated there.
// `registry` is injectable so tests can cover entries with a Sunset.
export function deprecationHeadersFor(pathname, registry = DEPRECATIONS) {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  for (const entry of registry) {
    let match = null;
    try {
      match = entry.test(pathname);
    } catch {
      continue;
    }
    if (!match) continue;
    const headers = { Deprecation: entry.deprecation };
    if (entry.sunset) headers.Sunset = entry.sunset;
    let successor = null;
    try {
      successor = entry.successorFor(match);
    } catch {
      successor = null;
    }
    if (successor) headers.Link = `<${successor}>; rel="successor-version"`;
    return headers;
  }
  return null;
}

// Fail-closed policy check for the registry: every entry names what to do
// instead, every Sunset is a parseable HTTP-date at least 90 days after the
// deprecation instant and still in the future. Run in tests, not at import:
// a clock-skewed import must never take the server down.
export function validateDeprecations(registry = DEPRECATIONS, now = Date.now()) {
  const errors = [];
  for (const entry of registry) {
    const id = entry?.id ?? "?";
    if (!entry || typeof entry !== "object") {
      errors.push("entry is not an object");
      continue;
    }
    if (!/^[a-z0-9-]+$/.test(entry.id ?? "")) errors.push(`${id}: bad id`);
    if (typeof entry.notice !== "string" || entry.notice.length < 20)
      errors.push(`${id}: notice must tell agents what to do instead`);
    if (typeof entry.test !== "function") errors.push(`${id}: test must be a function`);
    if (typeof entry.successorFor !== "function") errors.push(`${id}: successorFor must be a function`);
    const depEpoch = /^@(\d+)$/.exec(entry.deprecation ?? "")?.[1];
    if (entry.deprecation !== "true" && !depEpoch)
      errors.push(`${id}: deprecation must be "true" or @epoch`);
    if (entry.sunset !== undefined) {
      const sunsetMs = Date.parse(entry.sunset);
      if (!Number.isFinite(sunsetMs)) {
        errors.push(`${id}: sunset is not a parseable HTTP-date`);
      } else {
        if (sunsetMs <= now) errors.push(`${id}: sunset is in the past`);
        if (depEpoch && sunsetMs - Number(depEpoch) * 1000 < 90 * 86400 * 1000)
          errors.push(`${id}: sunset must be at least 90 days after deprecation`);
      }
    }
  }
  if (errors.length) throw new Error(`invalid deprecation registry: ${errors.join("; ")}`);
}
