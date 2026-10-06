// Tasks › Board › "What needs me": the viewer's own slice of the Board, computed
// from the claims the Board already loaded (no extra request, no polling).
// One object (a claim with an owner, a partner and a lease), one inbox:
//   - leases you are about to lose (owned, open, under an hour left or ended)
//   - reviews you owe (tagged rev-<you> on open work you have not reviewed)
//   - your claims gone quiet (owned, open, no update for two hours)
//   - the rest of what you own, and what you are partnered on (rev-/build- tags), behind More
// Partner tags accept a member id, or a display-name slug (rev-codexqa) when that
// slug belongs to exactly one member. Reviews owed are tag-derived and say so.
// Presentation only: the panel itself writes nothing. Renew and Hand off are the
// Board's existing renew and release actions (data-claim-action), the same calls
// the claim card's own buttons make.

export const LEASE_SOON_MS = 60 * 60 * 1000;
export const QUIET_MS = 2 * 60 * 60 * 1000;
const OPEN = new Set(["claimed", "in_progress", "blocked"]);

const esc = text => String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const slug = text => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function lastTouch(item) {
  const history = Array.isArray(item?.history) ? item.history : [];
  const stamps = [item?.updatedAt, item?.claimedAt, ...history.map(entry => entry?.at)].map(at => Date.parse(at ?? "")).filter(Number.isFinite);
  return stamps.length ? Math.max(...stamps) : NaN;
}

function tagged(item, prefix, viewerId, viewerSlug) {
  return (Array.isArray(item?.tags) ? item.tags : []).some(tag => {
    if (typeof tag !== "string" || !tag.startsWith(prefix)) return false;
    const who = tag.slice(prefix.length);
    return who === viewerId || (viewerSlug && slug(who) === viewerSlug);
  });
}

// A display-name slug counts only when exactly one member has it, so two members
// whose names collapse to the same letters never see each other's rows.
function uniqueSlug(members, viewerId) {
  const mine = slug(members?.[viewerId]?.displayName ?? members?.[viewerId]?.name ?? "");
  if (!mine) return "";
  const holders = Object.entries(members ?? {}).filter(([id, member]) => id !== viewerId && slug(member?.displayName ?? member?.name ?? "") === mine);
  return holders.length ? "" : mine;
}

export function myBoardWork(items, viewerId, members = {}, now = Date.now()) {
  const out = { expiring: [], reviews: [], quiet: [], owned: [], partnered: [] };
  if (!viewerId) return out;
  const viewerSlug = uniqueSlug(members, viewerId);
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || !item.id) continue;
    const open = OPEN.has(item.state);
    if (item.owner === viewerId && open) {
      const left = Date.parse(item.leaseExpiresAt ?? "") - now;
      const quietFor = now - lastTouch(item);
      if (item.state !== "blocked" && Number.isFinite(left) && left < LEASE_SOON_MS) out.expiring.push({ item, left });
      else if (item.state !== "blocked" && Number.isFinite(quietFor) && quietFor >= QUIET_MS) out.quiet.push({ item, quietFor });
      else out.owned.push({ item });
      continue;
    }
    if (item.owner === viewerId) continue;
    const reviewer = tagged(item, "rev-", viewerId, viewerSlug);
    const reviewed = (Array.isArray(item.reviews) ? item.reviews : []).some(review => review?.memberId === viewerId);
    const reviewable = open || Boolean(item.pullRequest?.url && !item.pullRequest.outcome);
    if (reviewer && reviewable && item.owner && !reviewed) { out.reviews.push({ item }); continue; }
    if ((reviewer || tagged(item, "build-", viewerId, viewerSlug)) && (open || item.state === "unclaimed")) out.partnered.push({ item });
  }
  out.expiring.sort((a, b) => a.left - b.left);
  out.quiet.sort((a, b) => b.quietFor - a.quietFor);
  return out;
}

function span(ms) {
  if (ms <= 0) return "ended";
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function nameOf(members, id) {
  const member = members?.[id];
  const name = String(member?.displayName ?? member?.name ?? id ?? "").trim() || String(id ?? "");
  return member?.kind === "agent" && !name.startsWith("@") ? `@${name}` : name;
}

export const NEEDS_ME_LIMIT = 3;

// Most urgent first, at most three rows, one primary action each. Nothing urgent
// and nothing owned renders nothing; the rest of the viewer's work sits behind More.
export function needsMeHtml(items, viewer, members = {}, now = Date.now()) {
  if (!viewer?.id) return "";
  const work = myBoardWork(items, viewer.id, members, now);
  const canWrite = viewer.write !== false;
  const claimButton = (action, label, item) => canWrite
    ? `<button type="button" class="button secondary needs-me-act" data-claim-action="${action}" data-claim-id="${esc(item.id)}" data-focus-key="needs-me-${action}:${esc(item.id)}">${label}</button>` : "";
  const openButton = (label, item) => `<button type="button" class="button secondary needs-me-act" data-needs-me-open="${esc(item.id)}">${label}</button>`;
  const urgent = [
    ...work.expiring.map(({ item, left }) => ({ item, note: left <= 0 ? "Your lease ended" : `Your lease ends in ${span(left)}`, act: claimButton("renew", "Renew", item) })),
    ...work.reviews.map(({ item }) => ({ item, note: `You are tagged to review · ${nameOf(members, item.owner)}`, act: openButton("Review", item) })),
    ...work.quiet.map(({ item, quietFor }) => ({ item, note: `No update for ${span(quietFor)}`, act: claimButton("release", "Hand off", item) }))
  ];
  const shown = urgent.slice(0, NEEDS_ME_LIMIT), waiting = urgent.slice(NEEDS_ME_LIMIT);
  const rest = [...waiting.map(({ item, note }) => [note, item]), ...work.owned.map(({ item }) => ["Yours", item]), ...work.partnered.map(({ item }) => ["Partner", item])];
  if (!shown.length && !rest.length) return "";
  const row = ({ item, note, act }) => `<li class="needs-me-row"><button type="button" class="needs-me-open" data-needs-me-open="${esc(item.id)}"><span class="needs-me-title">${esc(item.title || item.id)}</span><span class="needs-me-note">${esc(note)}</span></button>${act}</li>`;
  const more = rest.length
    ? `<details class="needs-me-more"><summary>More · ${rest.length}</summary><ul>${rest.map(([note, item]) => `<li><button type="button" class="needs-me-open" data-needs-me-open="${esc(item.id)}"><span class="needs-me-title">${esc(item.title || item.id)}</span><span class="needs-me-note">${esc(note)}</span></button></li>`).join("")}</ul></details>`
    : "";
  const heading = shown.length ? `${urgent.length} need${urgent.length === 1 ? "s" : ""} you` : "Nothing needs you";
  return `<section class="needs-me" aria-labelledby="needs-me-heading"><h3 id="needs-me-heading">${heading}</h3>${shown.length ? `<ul class="needs-me-list">${shown.map(row).join("")}</ul>` : ""}${more}</section>`;
}
