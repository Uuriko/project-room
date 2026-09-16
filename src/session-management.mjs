// F017 — session management UI: list + revoke sessions.
//
// Pairs with F018 (TOTP 2FA, src/totp-2fa.mjs): once an owner enables 2FA,
// the account settings page lists their active sessions and lets them
// revoke one session ("sign out this device") or every session except the
// current one ("sign out everywhere else").
//
// Pure logic, no store/schema/network/timer changes. All functions take an
// explicit session list and an injectable `now`, so tests and wiring can
// drive them deterministically. Revoke helpers never mutate their input:
// they return a new list when something was removed, and the unchanged list
// (same reference) when nothing was removed, so the wiring slice can tell
// whether there is anything to persist. Suggested wiring (follow-up
// slice): sessions read from the account store, revoke calls mapped onto
// the store's revocation event, renders dropped into the settings page.
//
// Session shape (anything extra on the object is ignored):
//   { id, deviceLabel, ip, createdAt, lastSeenAt }
// Times are epoch-ms numbers; renderers also accept any Date-parseable
// value and degrade gracefully for malformed rows, per the F004 renderer
// conventions (no throws on rows we do not fully understand).

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "`": "&#96;" };
export const esc = value => String(value ?? "").replace(/[&<>"'`]/g, c => ESCAPES[c]);
const attr = esc;

const asList = sessions => (Array.isArray(sessions) ? sessions : []);
const hasUsableId = session => session != null && typeof session.id === "string" && session.id.length > 0;

// Human age of a session ("3 days ago") from a millisecond delta. Non-finite
// or non-positive deltas (clock skew, unknown timestamps) render as
// "just now" rather than throwing or producing negative ages.
export function formatSessionAge(ageMs) {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

// Absolute timestamp in the room's UTC "YYYY-MM-DD HH:MM:SS UTC" style
// (matches formatAuditTime in F004). Unparseable values render as-is,
// never throw.
export function formatSessionTime(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? String(at ?? "")
    : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

// Enrich raw sessions for display. Options: { now = Date.now(),
// currentId } — `currentId` names the session making the request, which is
// flagged with current: true ("This device"). Rows without a usable string
// id are dropped (there is nothing to revoke by); the result objects are
// new, so callers may freely mutate them without touching the input list.
export function listSessions(sessions, { now = Date.now(), currentId } = {}) {
  const current = typeof currentId === "string" && currentId.length > 0 ? currentId : null;
  const nowMs = Number(now);
  return asList(sessions).filter(hasUsableId).map(session => {
    const lastMs = Number(session.lastSeenAt);
    const ageMs = Number.isFinite(lastMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - lastMs) : 0;
    return {
      id: session.id,
      deviceLabel: typeof session.deviceLabel === "string" && session.deviceLabel.length > 0
        ? session.deviceLabel
        : "Unknown device",
      ip: typeof session.ip === "string" && session.ip.length > 0 ? session.ip : "—",
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      current: current !== null && session.id === current,
      ageMs,
      age: formatSessionAge(ageMs),
    };
  });
}

// Remove one session by id. Returns a new list when a session was removed;
// returns the input list itself (same reference) when the id is unknown or
// invalid, so wiring can distinguish "revoked" from "no-op".
export function revokeSession(sessions, sessionId) {
  const list = asList(sessions);
  if (typeof sessionId !== "string" || !list.some(session => session?.id === sessionId)) return list;
  return list.filter(session => session?.id !== sessionId);
}

// Keep exactly one session (the current one), revoke everything else.
// Returns a new list; an unknown or invalid keepId revokes nothing and
// returns the input list itself, since revoking all sessions — including
// the current one — must be an explicit choice, not an accident.
export function revokeAllExcept(sessions, keepId) {
  const list = asList(sessions);
  if (typeof keepId !== "string" || keepId.length === 0 || !list.some(session => session?.id === keepId)) return list;
  return list.filter(session => session?.id === keepId);
}

// One session as a table row. Takes an enriched descriptor from
// listSessions (a raw session is tolerated: fields are best-effort).
// Renderer rules follow F004: esc() for content, attr() for attributes, no
// links/hrefs/scripts/inline handlers/style attributes, ids as <code>.
// The current session renders "Current session" instead of a revoke button
// (you do not revoke yourself from this view); other rows carry a plain
// button with a data attribute the wiring slice can hook up — no handler
// here, so nothing executable reaches the document.
export function renderSessionRow(descriptor, { revokeButtonText = "Revoke" } = {}) {
  const row = descriptor && typeof descriptor === "object" ? descriptor : {};
  const id = typeof row.id === "string" && row.id.length > 0 ? row.id : "";
  const deviceLabel = typeof row.deviceLabel === "string" && row.deviceLabel.length > 0 ? row.deviceLabel : "Unknown device";
  const ip = typeof row.ip === "string" && row.ip.length > 0 ? row.ip : "—";
  const seen = new Date(row.lastSeenAt);
  const seenValid = !Number.isNaN(seen.getTime());
  const when = formatSessionTime(row.lastSeenAt);
  const age = typeof row.age === "string" ? row.age : formatSessionAge(Date.now() - seen.getTime());
  const current = row.current === true;
  const whenHtml = seenValid
    ? `<time datetime="${attr(seen.toISOString())}">${esc(when)}</time>`
    : esc(when);
  const idAttr = id !== "" ? ` data-session-id="${attr(id)}"` : "";
  const action = current
    ? `<span class="session-current-label">Current session</span>`
    : `<button type="button" class="session-revoke"${idAttr}>${esc(revokeButtonText)}</button>`;
  return `<tr class="session-row"${current ? ` aria-current="true"` : ""}>`
    + `<td class="session-device">${esc(deviceLabel)}</td>`
    + `<td class="session-ip"><code>${esc(ip)}</code></td>`
    + `<td class="session-seen">${whenHtml}<span class="session-age"> (${esc(age)})</span></td>`
    + `<td class="session-action">${action}</td></tr>`;
}

// The full session list: heading, summary, and table. Accepts raw sessions
// (enriched internally via listSessions) so the wiring slice has one call
// to make. Options: { now, currentId, title, emptyText, revokeButtonText }.
// Empty and non-list inputs render the empty state — never a throw.
export function renderSessionList(sessions, { now = Date.now(), currentId, title = "Active sessions", emptyText = "No active sessions.", revokeButtonText } = {}) {
  const descriptors = listSessions(sessions, { now, currentId });
  const out = [];
  out.push(`<section class="session-list" aria-label="${attr(title)}">`, `<h2 class="session-heading">${esc(title)}</h2>`);
  if (!descriptors.length) {
    out.push(`<p class="session-empty">${esc(emptyText)}</p>`, "</section>");
    return out.join("\n");
  }
  out.push(`<p class="session-summary">${descriptors.length} active ${descriptors.length === 1 ? "session" : "sessions"}.</p>`);
  out.push(`<table class="session-table"><thead><tr><th scope="col">Device</th><th scope="col">IP</th><th scope="col">Last seen</th><th scope="col">Action</th></tr></thead><tbody>`);
  const rowOptions = revokeButtonText === undefined ? {} : { revokeButtonText };
  for (const descriptor of descriptors) out.push(renderSessionRow(descriptor, rowOptions));
  out.push("</tbody></table>", "</section>");
  return out.join("\n");
}
