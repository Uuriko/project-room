// Tasks › Board. Claims come from GET /work-claims. Live updates follow
// work_claim.updated on the room snapshot the client already applies.
// This module does not open its own stream and does not poll.

const TEN_MINUTES = 10 * 60 * 1000;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const COLUMNS = Object.freeze([
  ["ready", "Ready"],
  ["claimed", "Claimed / In progress"],
  ["blocked", "Blocked"],
  ["review", "In review"],
  ["landed", "Landed"]
]);

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[char]));
}

function updatedAt(item) {
  const history = Array.isArray(item?.history) ? item.history : [];
  const stamped = history.length && typeof history[history.length - 1]?.at === "string" ? history[history.length - 1].at : "";
  const stored = typeof item?.updatedAt === "string" ? item.updatedAt : "";
  return stamped > stored ? stamped : (stored || stamped);
}

function openPull(item) {
  return Boolean(item?.pullRequest?.url) && !item.pullRequest.outcome;
}

function pullNumber(url) {
  const match = /\/pull\/([1-9]\d{0,9})$/.exec(String(url ?? ""));
  return match ? match[1] : "";
}

function dependenciesMet(item, byId) {
  const deps = Array.isArray(item?.dependsOn) ? item.dependsOn : [];
  return deps.every(id => byId.get(id)?.state === "done");
}

export function columnOf(item, byId, now) {
  if (!item) return null;
  if (item.state === "done") {
    const at = Date.parse(updatedAt(item));
    return Number.isFinite(at) && now - at <= WEEK ? "landed" : null;
  }
  if (openPull(item)) return "review";
  if (item.state === "blocked") return "blocked";
  if (item.state === "claimed" || item.state === "in_progress") return "claimed";
  if (item.state === "unclaimed" && !item.owner && dependenciesMet(item, byId)) return "ready";
  return null;
}

export function placeClaims(items, now = Date.now()) {
  const list = Array.isArray(items) ? items : [];
  const byId = new Map(list.map(item => [item.id, item]));
  const columns = Object.fromEntries(COLUMNS.map(([id]) => [id, []]));
  for (const item of list) {
    const column = columnOf(item, byId, now);
    if (column) columns[column].push(item);
  }
  for (const rows of Object.values(columns)) rows.sort((a, b) => String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)));
  return columns;
}

function memberName(members, id) {
  if (!id) return "";
  const member = members?.[id];
  const name = String(member?.displayName ?? id).trim() || id;
  if (member?.kind === "agent" && !name.startsWith("@")) return `@${name}`;
  return name;
}

function initials(name) {
  const parts = String(name).replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  const letters = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`;
  return (letters || "?").toUpperCase();
}

function leasePhrase(event) {
  const exp = Date.parse(event?.data?.leaseExpiresAt ?? "");
  const at = Date.parse(event?.at ?? "");
  if (!Number.isFinite(exp) || !Number.isFinite(at) || exp <= at) return "";
  const hours = Math.max(1, Math.round((exp - at) / 3600000));
  return `lease ${hours}h`;
}

function countdown(iso, now) {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "Lease ended";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours >= 48) return `Lease ${Math.round(hours / 24)}d`;
  if (hours >= 1) return `Lease ${hours}h ${minutes}m`;
  return `Lease ${Math.max(1, minutes)}m`;
}

export function claimUpdateText(event, members) {
  const data = event?.data ?? {};
  const name = memberName(members, event?.actorId) || "Someone";
  const title = String(data.title || data.workClaim || "a claim");
  if (data.reason === "ci_changed" || data.action === "ci_changed") {
    const word = { success: "passed", failure: "failed", pending: "is pending", neutral: "finished" }[data.ciState] ?? "changed";
    return `CI ${word} on ${title}`;
  }
  if (data.verdict === "approve" || (data.action === "reviewed" && data.reason === "reviewed" && data.verdict === "approve")) return `${name} approved`;
  if (data.verdict === "changes_requested") return `${name} requested changes`;
  if (data.verdict === "comment") return `${name} commented`;
  if (data.action === "reviewed" && data.reason === "reviewed") return `${name} reviewed ${title}`;
  const paths = Array.isArray(data.paths) ? data.paths : [];
  if (data.action === "claimed") {
    const bits = [`${name} claimed ${title}`];
    if (paths.length) bits.push(`${paths.length} file${paths.length === 1 ? "" : "s"}`);
    const lease = leasePhrase(event);
    if (lease) bits.push(lease);
    return bits.join(" · ");
  }
  if (data.action === "created") return `${name} opened ${title}`;
  if (data.action === "released" || data.action === "lease_expired") return `${name} released ${title}`;
  if (data.action === "renewed") return `${name} renewed ${title}`;
  if (data.action === "reassigned") return `${name} reassigned ${title}`;
  if (data.action === "pr_merged") return `${name} merged ${title}`;
  if (data.action === "pr_closed") return `${name} closed the pull request on ${title}`;
  if (data.action === "state_changed") return `${name} marked ${title} ${String(data.claimState ?? "").replaceAll("_", " ")}`;
  return `${name} updated ${title}`;
}

export function collapseClaimUpdates(events) {
  const rows = (Array.isArray(events) ? events : [])
    .filter(event => event?.type === "work_claim.updated" && event.data?.workClaim)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  const groups = [];
  for (const event of rows) {
    const at = Date.parse(event.at);
    const last = groups[groups.length - 1];
    const same = last && last.claimId === event.data.workClaim && Number.isFinite(at) && at - last.start < TEN_MINUTES;
    if (same) last.event = event;
    else groups.push({ claimId: event.data.workClaim, event, start: Number.isFinite(at) ? at : 0 });
  }
  return groups;
}

export function paintClaimChat(state, list) {
  if (!list) return;
  list.querySelectorAll("[data-claim-update]").forEach(node => node.remove());
  if (!state) return;
  const groups = collapseClaimUpdates(state.eventLog);
  const stamps = [...list.querySelectorAll(":scope > .message")].map(node => {
    const id = node.dataset.messageRecordId;
    const message = (state.messages ?? []).find(item => item.id === id);
    return { node, at: message?.createdAt ?? "" };
  });
  for (const group of groups) {
    const line = document.createElement("li");
    line.className = "claim-update";
    line.dataset.claimUpdate = group.claimId;
    line.textContent = claimUpdateText(group.event, state.members);
    const after = stamps.find(entry => entry.at > (group.event.at ?? ""));
    list.insertBefore(line, after?.node ?? null);
  }
}

function liveLabel(status) {
  if (!status) return "Live vs main";
  if (status.behind === 0) return "Live vs main · matches";
  if (typeof status.behind === "number") return `Live vs main · ${status.behind} behind`;
  return "Live vs main · not compared";
}

function viewerOf(state, session) {
  const id = session?.member?.id ?? null;
  const member = id ? state?.members?.[id] : null;
  const manage = Boolean(id && (state?.room?.ownerId === id || (member?.permissions ?? []).includes("manage_claims")));
  return { id, manage, owner: Boolean(id && state?.room?.ownerId === id) };
}

function cardHtml(item, viewer, members, now) {
  const ownerId = item.owner;
  const owner = ownerId ? memberName(members, ownerId) : "Unclaimed";
  const mine = Boolean(viewer.id && ownerId === viewer.id);
  const files = Array.isArray(item.files) ? item.files : [];
  const blocks = item.fileBlocks && typeof item.fileBlocks === "object" ? item.fileBlocks : {};
  const fileLabel = file => blocks[file] ? `${file} (${blocks[file]})` : file;
  const fileBlock = files.length
    ? `<details class="claim-files"><summary>${files.length} file${files.length === 1 ? "" : "s"}</summary><ul>${files.map(file => `<li>${escapeHtml(fileLabel(file))}</li>`).join("")}</ul></details>`
    : "";
  const lease = countdown(item.leaseExpiresAt, now);
  const pulls = Array.isArray(item.pullRequests) && item.pullRequests.length ? item.pullRequests : (item.pullRequest?.url ? [item.pullRequest] : []);
  const pr = pulls.map(pull => {
    const number = pullNumber(pull.url);
    const outcome = pull.outcome ? ` · ${pull.outcome}` : "";
    return `<p class="claim-pr"><a href="${escapeHtml(pull.url)}">PR ${number ? `#${escapeHtml(number)}` : "link"}</a>${escapeHtml(outcome)}</p>`;
  }).join("");
  const place = item.repo || item.branch
    ? `<p class="claim-repo">${escapeHtml([item.repo, item.branch].filter(Boolean).join("@"))}</p>`
    : "";
  const chain = Array.isArray(item.chain) ? item.chain : [];
  const links = chain.map(link => `<li>${escapeHtml(link.kind)} → ${escapeHtml(link.targetId)}${link.note ? ` · ${escapeHtml(link.note)}` : ""}</li>`).join("");
  const reviews = Array.isArray(item.reviews) && item.reviews.length
    ? `<ul class="claim-reviews">${item.reviews.map(review => `<li>${escapeHtml(memberName(members, review.memberId) || review.memberId)} ${escapeHtml(String(review.verdict ?? "").replaceAll("_", " "))}</li>`).join("")}</ul>`
    : "";
  const deps = (item.dependsOn ?? []).map(id => `<li>lands after #${escapeHtml(id)}</li>`).join("");
  const actions = [];
  if (item.state === "unclaimed") actions.push(`<button type="button" data-claim-action="claim" data-claim-id="${escapeHtml(item.id)}" data-focus-key="claim:${escapeHtml(item.id)}">Claim</button>`);
  if (mine && ["claimed", "in_progress", "blocked"].includes(item.state)) actions.push(`<button type="button" data-claim-action="renew" data-claim-id="${escapeHtml(item.id)}" data-focus-key="renew:${escapeHtml(item.id)}">Renew</button>`);
  if (mine && (item.state === "claimed" || item.state === "blocked")) actions.push(`<button type="button" data-claim-action="progress" data-claim-id="${escapeHtml(item.id)}" data-focus-key="progress:${escapeHtml(item.id)}">Mark in progress</button>`);
  if (mine && item.state === "in_progress") actions.push(`<button type="button" data-claim-action="done" data-claim-id="${escapeHtml(item.id)}" data-focus-key="done:${escapeHtml(item.id)}">Done</button>`);
  if (viewer.manage && ownerId && item.state !== "done" && item.state !== "unclaimed") {
    actions.push(`<button type="button" data-claim-action="release" data-claim-id="${escapeHtml(item.id)}" data-focus-key="release:${escapeHtml(item.id)}">Release</button>`);
    const options = Object.values(members ?? {}).filter(member => member && member.active !== false && member.id !== ownerId)
      .map(member => `<option value="${escapeHtml(member.id)}">${escapeHtml(memberName(members, member.id))}</option>`).join("");
    if (options) actions.push(`<form data-claim-reassign="${escapeHtml(item.id)}"><label>Reassign <select name="newOwner" aria-label="Reassign ${escapeHtml(item.title)}">${options}</select></label><button type="submit">Move</button></form>`);
  }
  return `<article class="claim-card" data-claim-id="${escapeHtml(item.id)}"><h4>${escapeHtml(item.title || item.id)}</h4><p class="claim-owner">${ownerId ? `<span class="member-avatar" aria-hidden="true">${escapeHtml(initials(owner))}</span> ` : ""}<span>${escapeHtml(owner)}</span></p>${place}${fileBlock}${lease ? `<p class="claim-lease">${escapeHtml(lease)}</p>` : ""}${pr}${reviews}${deps ? `<ul class="claim-deps">${deps}</ul>` : ""}${links ? `<ul class="claim-chain">${links}</ul>` : ""}<div class="claim-actions">${actions.join("")}</div></article>`;
}

function boardHtml(items, status, viewer, members, now, cap) {
  const columns = placeClaims(items, now);
  const sweep = viewer.manage ? `<button type="button" id="board-close-stale" data-claim-action="sweep">Close stale</button>` : "";
  const capForm = viewer.owner ? `<form data-claim-cap><label>Claims per member <input name="maxMemberOpenClaims" type="number" min="1" max="10000" value="${escapeHtml(String(cap ?? 20))}" aria-label="Open claims per member"></label><button type="submit">Save cap</button></form>` : "";
  const body = items.length
    ? `<div class="board-columns">${COLUMNS.map(([id, label]) => `<section aria-labelledby="board-col-${id}"><h3 id="board-col-${id}">${label}</h3>${columns[id].map(item => cardHtml(item, viewer, members, now)).join("") || `<p class="form-hint">Nothing here.</p>`}</section>`).join("")}</div>`
    : `<p class="board-empty">Claim work so others don't collide. Agents can do this over MCP.</p>`;
  return `<div class="board-head"><p class="live-chip">${escapeHtml(liveLabel(status))}</p>${sweep}${capForm}</div><p id="board-status" class="form-hint" role="status"></p>${body}`;
}

async function readClaims(client) {
  const claims = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const body = await client.request(client.path(`/work-claims?${query}`));
    claims.push(...(body.claims ?? []));
    if (!body.nextCursor) return claims;
    cursor = body.nextCursor;
  }
  return claims;
}

export function installWorkBoard({ client, getState, getSession }) {
  const root = document.querySelector("#work-board");
  if (!root) return { sync() {}, reset() {} };
  let items = [];
  let status = null;
  let cap = 20;
  let seen = null;
  let loadedRoom = null;
  let busy = false;

  function paint() {
    const state = getState();
    const focus = document.activeElement?.closest?.("[data-focus-key]")?.dataset.focusKey ?? null;
    root.innerHTML = boardHtml(items, status, viewerOf(state, getSession()), state?.members ?? {}, Date.now(), cap);
    if (focus) root.querySelector(`[data-focus-key="${CSS.escape(focus)}"]`)?.focus();
  }

  function note(text) {
    const line = root.querySelector("#board-status");
    if (line) line.textContent = text;
  }

  async function load({ force = false } = {}) {
    const session = getSession();
    if (!session?.roomId || busy) return;
    const events = (getState()?.eventLog ?? []).filter(event => event.type === "work_claim.updated");
    const mark = events.length ? events[events.length - 1].id : "";
    if (!force && loadedRoom === session.roomId && seen === mark) return;
    busy = true;
    try {
      const [claims, live, config] = await Promise.all([
        readClaims(client),
        client.request(client.path("/work-claims/status")),
        client.request(client.path("/work-claims/config"))
      ]);
      if (getSession()?.roomId !== session.roomId) return;
      items = claims;
      status = live;
      cap = config?.maxMemberOpenClaims ?? cap;
      loadedRoom = session.roomId;
      seen = mark;
      paint();
    } catch {
      if (getSession()?.roomId === session.roomId) note("Could not load the board.");
    } finally {
      busy = false;
    }
  }

  async function act(run) {
    if (busy) return;
    busy = true;
    try {
      await run();
      busy = false;
      await load({ force: true });
    } catch (error) {
      busy = false;
      note(error?.message || "Could not update the claim.");
    }
  }

  root.addEventListener("click", event => {
    const button = event.target.closest("[data-claim-action]");
    if (!button || !root.contains(button)) return;
    const id = button.dataset.claimId;
    const action = button.dataset.claimAction;
    if (action === "sweep") {
      void act(() => client.request(client.path("/work-claims/sweep"), { method: "POST", data: {} }));
      return;
    }
    const path = client.path(`/work-claims/${encodeURIComponent(id)}`);
    if (action === "claim") void act(() => client.request(`${path}/claim`, { method: "POST", data: {} }));
    else if (action === "release") void act(() => client.request(`${path}/release`, { method: "POST", data: {} }));
    else if (action === "progress") void act(() => client.request(`${path}/update`, { method: "POST", data: { state: "in_progress" } }));
    else if (action === "done") void act(() => client.request(`${path}/update`, { method: "POST", data: { state: "done" } }));
    else if (action === "renew") {
      void act(() => client.request(`${path}/renew`, { method: "POST", data: {} }));
    }
  });
  root.addEventListener("submit", event => {
    const form = event.target.closest("[data-claim-reassign]");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const id = form.dataset.claimReassign;
    const newOwner = new FormData(form).get("newOwner");
    if (typeof newOwner !== "string" || !newOwner) return;
    void act(() => client.request(client.path(`/work-claims/${encodeURIComponent(id)}/reassign`), { method: "POST", data: { newOwner } }));
  });
  root.addEventListener("submit", event => {
    const form = event.target.closest("[data-claim-cap]");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const raw = Number(new FormData(form).get("maxMemberOpenClaims"));
    if (!Number.isSafeInteger(raw)) return;
    void act(async () => {
      const saved = await client.request(client.path("/work-claims/config"), { method: "POST", data: { maxMemberOpenClaims: raw } });
      cap = saved.maxMemberOpenClaims ?? raw;
    });
  });

  return {
    sync() { void load(); },
    reset() { items = []; status = null; seen = null; loadedRoom = null; if (root.isConnected) root.replaceChildren(); }
  };
}
