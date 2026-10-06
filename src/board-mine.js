// Tasks › Board › "What needs me": the viewer's own slice of the Board, computed
// from the claims the Board already loaded (no extra request, no polling).
// One object (a claim with an owner, a partner and a lease), one inbox:
//   - leases you are about to lose (owned, open, under an hour left or ended)
//   - reviews you owe (tagged rev-<you> on open work you have not reviewed)
//   - your claims gone quiet (owned, open, no update for two hours)
//   - the rest of what you own, and what you are partnered on (rev-/build- tags)
// Partner tags accept a member id or a display-name slug (rev-codexqa).
// Presentation only: it never writes claim state; the Renew button reuses the
// Board's existing data-claim-action="renew" handler.

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

export function myBoardWork(items, viewerId, members = {}, now = Date.now()) {
  const out = { expiring: [], reviews: [], quiet: [], owned: [], partnered: [] };
  if (!viewerId) return out;
  const viewerSlug = slug(members?.[viewerId]?.displayName ?? members?.[viewerId]?.name ?? "");
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

export function needsMeHtml(items, viewer, members = {}, now = Date.now()) {
  if (!viewer?.id) return "";
  const work = myBoardWork(items, viewer.id, members, now);
  const urgent = work.expiring.length + work.reviews.length + work.quiet.length;
  const row = (kind, label, item, note, action = "") => `<li class="needs-me-row needs-me-${kind}"><span class="needs-me-kind">${label}</span><button type="button" class="needs-me-open" data-needs-me-open="${esc(item.id)}"><span class="needs-me-title">${esc(item.title || item.id)}</span><span class="needs-me-note">${esc(note)}</span></button>${action}</li>`;
  const renew = item => `<button type="button" class="button secondary" data-claim-action="renew" data-claim-id="${esc(item.id)}" data-focus-key="needs-me-renew:${esc(item.id)}">Renew</button>`;
  const rows = [
    ...work.expiring.map(({ item, left }) => row("lease", "Lease", item, left <= 0 ? "Your lease ended" : `${span(left)} left on your lease`, viewer.write === false ? "" : renew(item))),
    ...work.reviews.map(({ item }) => row("review", "Review", item, `${nameOf(members, item.owner)} is waiting on your review`)),
    ...work.quiet.map(({ item, quietFor }) => row("quiet", "Quiet", item, `No update for ${span(quietFor)}: post progress or hand it off`))
  ].join("");
  const summary = [
    work.owned.length + urgent ? `${work.owned.length + work.expiring.length + work.quiet.length} yours` : "",
    work.partnered.length ? `${work.partnered.length} partnered` : ""
  ].filter(Boolean).join(" · ");
  const calm = urgent ? "" : `<p class="needs-me-calm">Nothing needs you right now.${summary ? ` ${esc(summary)}.` : ""}</p>`;
  const rest = [...work.owned.map(({ item }) => ["Yours", item]), ...work.partnered.map(({ item }) => ["Partner", item])];
  const restList = rest.length && urgent
    ? `<details class="needs-me-rest"><summary>${esc(summary)}</summary><ul>${rest.map(([label, item]) => `<li><span class="needs-me-kind">${label}</span><button type="button" class="needs-me-open" data-needs-me-open="${esc(item.id)}"><span class="needs-me-title">${esc(item.title || item.id)}</span></button></li>`).join("")}</ul></details>`
    : "";
  return `<section class="needs-me" aria-labelledby="needs-me-heading"><h3 id="needs-me-heading">What needs me${urgent ? ` <span class="needs-me-count">${urgent}</span>` : ""}</h3>${urgent ? `<ul class="needs-me-list">${rows}</ul>` : calm}${restList}</section>`;
}
