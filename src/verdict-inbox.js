// COMP-DEEP #1 (CD-01) — the human-door verdict inbox.
//
// A sectioned, server-ordered surface on the account home, rendering Lane
// C's verdict-inbox read (Contract V): the four server-defined sections
// Needs your verdict / Returned to you / Waiting on worker / Recently
// decided, plus the follow block (followed-claim changes + mentions, CD-06
// totals) in the same neighbourhood, per CONVO CV-1. This cures #3741: a
// pending review in the reviewer's own room emitted no signal on any
// surface — the only address was room More → Offers → Results.
//
// Discipline, mirroring src/owner-cockpit.js (#3342/#3340):
//   - The server defines the sections and their order; rows render in the
//     server's order (waiting, oldest first). No client-side re-sorting, no
//     user-built views. The per-type filters only change which sections are
//     visible — never their order, their rows' order, or any count.
//   - Every count shown is an API total taken verbatim (the badge is
//     totals.needsYourVerdict, never a rows length — the server may cap
//     rows). No client arithmetic produces a count.
//   - Every row shows why (reason) and when (waiting time from
//     waitingSeconds, with `since` as the fallback source).

export const VERDICT_INBOX_PATH = "/api/needs-me/verdicts";

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const VERDICT_SECTIONS = Object.freeze([
  Object.freeze({ key: "needsYourVerdict", title: "Needs your verdict", empty: "Nothing needs your verdict." }),
  Object.freeze({ key: "returnedToYou", title: "Returned to you", empty: "Nothing has been returned to you." }),
  Object.freeze({ key: "waitingOnWorker", title: "Waiting on worker", empty: "Nothing is waiting on a worker." }),
  Object.freeze({ key: "recentlyDecided", title: "Recently decided", empty: "Nothing decided recently." }),
]);

// Per-type filters (CV-1). A filter names a subset of the server-defined
// sections (and, for following/mentions, a subset of the follow block). It
// never re-sorts or recounts anything.
export const VERDICT_FILTERS = Object.freeze([
  Object.freeze({ key: "all", label: "All" }),
  Object.freeze({ key: "verdicts", label: "Needs your verdict" }),
  Object.freeze({ key: "returned", label: "Returned to you" }),
  Object.freeze({ key: "waiting", label: "Waiting on worker" }),
  Object.freeze({ key: "decided", label: "Recently decided" }),
  Object.freeze({ key: "following", label: "Following" }),
  Object.freeze({ key: "mentions", label: "Mentions" }),
]);

const FILTER_SECTIONS = Object.freeze({
  all: Object.freeze(["needsYourVerdict", "returnedToYou", "waitingOnWorker", "recentlyDecided"]),
  verdicts: Object.freeze(["needsYourVerdict"]),
  returned: Object.freeze(["returnedToYou"]),
  waiting: Object.freeze(["waitingOnWorker"]),
  decided: Object.freeze(["recentlyDecided"]),
  following: Object.freeze([]),
  mentions: Object.freeze([]),
});

export function visibleSectionKeys(filter) {
  return FILTER_SECTIONS[filter] ?? FILTER_SECTIONS.all;
}

function followBlockVisible(filter) {
  return filter === "all" || filter === "following" || filter === "mentions";
}

// The badge count is the API total for verdicts owed, taken verbatim. It is
// never derived from the rows array (which the server may cap).
export function verdictBadgeCount(doc) {
  const total = doc?.totals?.needsYourVerdict;
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

function totalOf(doc, key) {
  const total = doc?.totals?.[key];
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

export function isVerdictInboxDoc(doc) {
  return Boolean(doc) && typeof doc === "object"
    && doc.sections !== null && typeof doc.sections === "object"
    && doc.totals !== null && typeof doc.totals === "object";
}

export function formatWaiting(waitingSeconds) {
  if (typeof waitingSeconds !== "number" || !Number.isFinite(waitingSeconds) || waitingSeconds < 0) return "";
  const minutes = Math.floor(waitingSeconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// When for one row: waitingSeconds verbatim when the server sent it, else
// derived from the row's `since` timestamp (display only — never a count).
export function rowAge(row, now = Date.now()) {
  if (typeof row?.waitingSeconds === "number" && Number.isFinite(row.waitingSeconds)) {
    return formatWaiting(row.waitingSeconds);
  }
  const since = Date.parse(row?.since ?? "");
  if (!Number.isFinite(since)) return "";
  return formatWaiting(Math.max(0, (now - since) / 1000));
}

// The row's address: enter the room at the claim's record — the same
// "./?room=" entry the cockpit's "Review in room" uses, plus the
// "#pr-record/work/<claimId>" record route board-ui and the needs-attention
// card already route to (#3849's board-native record path included).
export function verdictRowHref(row) {
  return `./?room=${encodeURIComponent(row?.roomId ?? "")}#pr-record/work/${encodeURIComponent(row?.claimId ?? "")}`;
}

export function verdictRowHtml(row, { decided = false, now = Date.now() } = {}) {
  const age = rowAge(row, now);
  const when = age ? (decided ? `${age} ago` : `waiting ${age}`) : "";
  const where = row.roomName ?? row.roomId;
  const meta = [row.reason, where, when].filter(value => typeof value === "string" && value.length > 0);
  return `<article class="verdict-row" data-claim-id="${esc(row.claimId)}" data-room-id="${esc(row.roomId)}">
      <header><a href="${esc(verdictRowHref(row))}">${esc(row.title || row.claimId)}</a></header>
      ${meta.length ? `<p class="form-hint">${meta.map(esc).join(" · ")}</p>` : ""}
    </article>`;
}

export function verdictSectionHtml(doc, def, { now = Date.now() } = {}) {
  const rows = Array.isArray(doc?.sections?.[def.key]) ? doc.sections[def.key] : [];
  const total = totalOf(doc, def.key);
  const decided = def.key === "recentlyDecided";
  const body = rows.length
    ? rows.map(row => verdictRowHtml(row, { decided, now })).join("")
    : `<p class="form-hint">${esc(def.empty)}</p>`;
  const capped = total > rows.length
    ? `<p class="form-hint">Showing the ${rows.length} longest-waiting, of ${total} total.</p>`
    : "";
  return `<section class="verdict-section" data-verdict-section="${esc(def.key)}" aria-label="${esc(def.title)}">
      <h4>${esc(def.title)}${total > 0 ? ` <span class="count-chip">${total}</span>` : ""}</h4>
      ${body}${capped}
    </section>`;
}

export function verdictSectionsHtml(doc, filter = "all", { now = Date.now() } = {}) {
  const keys = visibleSectionKeys(filter);
  return VERDICT_SECTIONS.filter(def => keys.includes(def.key))
    .map(def => verdictSectionHtml(doc, def, { now })).join("");
}

function followRows(doc, filter) {
  const rows = Array.isArray(doc?.following) ? doc.following : [];
  if (filter === "following") return rows.filter(row => row?.type !== "mention");
  if (filter === "mentions") return rows.filter(row => row?.type === "mention");
  return rows;
}

// The follow block is a sibling inside the same needs-me neighbourhood —
// not a separate notifications surface. It renders only when the read
// carries follow rows; its heading counts are the API follow totals.
export function verdictFollowingHtml(doc, filter = "all", { now = Date.now() } = {}) {
  if (!followBlockVisible(filter)) return "";
  const rows = followRows(doc, filter);
  if (!rows.length && filter === "all") return "";
  const changed = totalOf(doc, "followedChanges");
  const mentions = totalOf(doc, "mentions");
  const counts = [
    changed > 0 ? `${changed} followed ${changed === 1 ? "change" : "changes"}` : "",
    mentions > 0 ? `${mentions} ${mentions === 1 ? "mention" : "mentions"}` : "",
  ].filter(Boolean).join(" · ");
  const body = rows.length
    ? rows.map(row => verdictRowHtml(row, { now })).join("")
    : `<p class="form-hint">Nothing new on work you follow.</p>`;
  return `<section class="verdict-section" data-verdict-section="following" aria-label="Following">
      <h4>Following${counts ? ` <span class="form-hint">${esc(counts)}</span>` : ""}</h4>
      ${body}
    </section>`;
}

export function verdictFiltersHtml(active = "all") {
  return VERDICT_FILTERS.map(filter =>
    `<button type="button" class="button ghost verdict-filter" data-verdict-filter="${esc(filter.key)}" aria-pressed="${filter.key === active ? "true" : "false"}">${esc(filter.label)}</button>`).join("");
}

export function verdictSummaryText(doc) {
  const parts = [];
  const verdicts = totalOf(doc, "needsYourVerdict");
  parts.push(verdicts > 0 ? (verdicts === 1 ? "1 needs your verdict" : `${verdicts} need your verdict`) : "Nothing needs your verdict");
  const returned = totalOf(doc, "returnedToYou");
  if (returned > 0) parts.push(`${returned} returned to you`);
  const waiting = totalOf(doc, "waitingOnWorker");
  if (waiting > 0) parts.push(`${waiting} waiting on worker`);
  return parts.join(" · ");
}

function isZeroDoc(doc) {
  return VERDICT_SECTIONS.every(def => totalOf(doc, def.key) === 0)
    && (!Array.isArray(doc?.following) || doc.following.length === 0);
}

export function createVerdictInbox({ load, section }) {
  const badge = section.querySelector("#verdict-inbox-badge");
  const summary = section.querySelector("#verdict-inbox-summary");
  const filtersBox = section.querySelector("#verdict-inbox-filters");
  const sectionsBox = section.querySelector("#verdict-inbox-sections");
  const followingBox = section.querySelector("#verdict-inbox-following");
  let epoch = 0;
  let currentDoc = null;
  let activeFilter = "all";

  function renderBadge(doc) {
    if (!badge) return;
    const count = doc ? verdictBadgeCount(doc) : 0;
    badge.textContent = count > 0 ? String(count) : "";
    badge.hidden = count === 0;
    if (typeof badge.setAttribute === "function") {
      badge.setAttribute("aria-label", count > 0 ? `Needs your verdict: ${count} waiting` : "Needs your verdict");
    }
  }

  function render(doc) {
    section.hidden = false;
    renderBadge(doc);
    if (isZeroDoc(doc)) {
      summary.textContent = "Inbox zero — nothing needs your verdict.";
      filtersBox.innerHTML = "";
      sectionsBox.innerHTML = "";
      followingBox.innerHTML = "";
      return;
    }
    summary.textContent = verdictSummaryText(doc);
    filtersBox.innerHTML = verdictFiltersHtml(activeFilter);
    sectionsBox.innerHTML = verdictSectionsHtml(doc, activeFilter);
    followingBox.innerHTML = verdictFollowingHtml(doc, activeFilter);
    if (typeof filtersBox.querySelectorAll === "function") {
      for (const button of filtersBox.querySelectorAll("[data-verdict-filter]")) {
        button.addEventListener("click", () => {
          const next = button.dataset?.verdictFilter;
          if (!next || next === activeFilter || !currentDoc) return;
          activeFilter = next;
          render(currentDoc);
        });
      }
    }
  }

  async function refresh() {
    const mine = ++epoch;
    let doc;
    try { doc = await load(); }
    catch (error) {
      if (mine !== epoch) return;
      // A signed-out or not-yet-entitled account simply has no verdict
      // inbox; the room list below is still their home (cockpit pattern).
      section.hidden = error?.status === 401 || error?.status === 403
        || error?.code === "account_session_required" || error?.code === "session_binding_changed";
      if (!section.hidden) {
        section.hidden = false;
        renderBadge(null);
        summary.textContent = "Couldn't load your verdict inbox. Refresh to retry.";
        filtersBox.innerHTML = "";
        sectionsBox.innerHTML = "";
        followingBox.innerHTML = "";
      }
      return;
    }
    if (mine !== epoch || !isVerdictInboxDoc(doc)) return;
    currentDoc = doc;
    render(doc);
  }

  return Object.freeze({ refresh });
}
