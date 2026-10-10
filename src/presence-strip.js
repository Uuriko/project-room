// Presence strip (room-full phase 4): one line under the room title that says
// who is here and what each one is doing right now. Presentation only, built
// from the server's /presence entries (#660) and room members. It never shows
// a claim that is not backed by a live observation:
// - "Working on <title>" only from workingOn, which the server fills from
//   fresh session heartbeats and drops when they go stale
// - a member's own status line only while they are working or listening
// - otherwise the plain presence label, and nothing at all when presence is
//   stale or unrefreshed
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (text, max) => { const s = String(text ?? "").replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

export const STRIP_LIMIT = 6;
const LIVE = new Set(["working", "listening"]);
const RANK = { working: 0, listening: 1, idle: 2, unknown: 3, unreachable: 4 };
const LABEL = { working: "working", listening: "here", idle: "idle", unknown: "no live signal", unreachable: "unreachable" };

export function presenceStripModel({ members, presence, selfId = null, stale = false, limit = STRIP_LIMIT } = {}) {
  if (!members || typeof members !== "object") return null;
  const entries = Object.values(members).filter(m => m && m.active !== false).map(member => {
    const seen = stale ? null : presence?.get?.(member.id) ?? null;
    const state = seen && Object.hasOwn(RANK, seen.state) ? seen.state : "unknown";
    const working = state === "working" && Array.isArray(seen?.workingOn) ? seen.workingOn.find(w => w?.title) : null;
    const status = LIVE.has(state) && seen?.statusMessage ? clip(seen.statusMessage, 60) : "";
    const line = working ? `on ${clip(working.title, 48)}` : status || (stale ? "" : LABEL[state]);
    return { id: member.id, name: clip(member.displayName || member.id, 32), kind: member.kind === "agent" ? "agent" : "human",
      state, line, self: member.id === selfId, workItemId: working?.workItemId ?? null };
  });
  // Live first, then people before agents, then by name. You lead your own strip.
  entries.sort((a, b) => Number(b.self) - Number(a.self) || RANK[a.state] - RANK[b.state]
    || (a.kind === b.kind ? 0 : a.kind === "human" ? -1 : 1) || a.name.localeCompare(b.name));
  const shown = entries.slice(0, limit);
  return { shown, hidden: entries.length - shown.length, live: entries.filter(e => LIVE.has(e.state)).length, stale };
}

export function renderPresenceStrip(model) {
  if (!model || !model.shown.length) return "";
  const chips = model.shown.map(entry => {
    const initial = esc((entry.name.trim()[0] ?? "?").toUpperCase());
    const name = entry.self ? "You" : esc(entry.name);
    const line = entry.line ? `<span class="ps-line">${esc(entry.line)}</span>` : "";
    const open = entry.workItemId ? ` data-open-work="${esc(entry.workItemId)}"` : ` data-open-member="${esc(entry.id)}"`;
    return `<li><button type="button" class="ps-chip ps-${entry.state}"${open}><span class="ps-avatar ps-${entry.kind}" aria-hidden="true">${initial}</span><span class="ps-name">${name}</span>${line}</button></li>`;
  }).join("");
  const more = model.hidden ? `<li class="ps-more">+${model.hidden}</li>` : "";
  return `<ul class="ps-list">${chips}${more}</ul>`;
}
