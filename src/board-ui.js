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
  if (!status || typeof status.behind !== "number") return "Deploy status unknown";
  if (status.behind === 0) return "Live matches main";
  if (status.behind > 0) return "Live is behind main";
  return "Deploy status unknown";
}

// room_read_board / room_acquire_claim / room_renew_claim / room_release_claim
// read the older work-item model. They are not tools for this Board.
const NOT_BOARD_TOOLS = new Set(["room_read_board", "room_acquire_claim", "room_renew_claim", "room_release_claim"]);

export function boardToolNames(capabilities) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  const names = [];
  for (const name of list) {
    if (typeof name !== "string" || NOT_BOARD_TOOLS.has(name)) continue;
    if (!/work[_-]claim/.test(name) || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

export function emptyBoardCopy(capabilities) {
  const tools = boardToolNames(capabilities);
  const line = "Claim work here so people and agents don't collide.";
  return tools.length ? `${line} Agents can use ${tools.join(", ")}.` : line;
}

function advertisedCapabilities(state) {
  const names = [];
  for (const member of Object.values(state?.members ?? {})) {
    if (Array.isArray(member?.capabilities)) names.push(...member.capabilities);
  }
  return names;
}

export function canWriteClaims(state, session) {
  const id = session?.member?.id;
  if (!id || !state?.members) return false;
  const ownerId = state.room?.ownerId;
  const enforced = typeof ownerId === "string" && ownerId.length > 0;
  if (!enforced) return true;
  if (id === ownerId) return true;
  const member = state.members[id];
  if (!member || member.active === false) return false;
  const permissions = new Set(member.permissions ?? []);
  if (member.kind === "human") return permissions.has("accept_work") || permissions.has("complete_work");
  const holds = (...needed) => needed.every(name => permissions.has(name));
  return holds("accept_work", "complete_work") || permissions.has("verify") || holds("steer", "accept_work", "complete_work", "verify");
}

function viewerOf(state, session) {
  const id = session?.member?.id ?? null;
  const member = id ? state?.members?.[id] : null;
  const manage = Boolean(id && (state?.room?.ownerId === id || (member?.permissions ?? []).includes("manage_claims")));
  return { id, manage, owner: Boolean(id && state?.room?.ownerId === id) };
}

function cardHtml(item, viewer, members, now, workItems) {
  const ownerId = item.owner;
  const owner = ownerId ? memberName(members, ownerId) : "Unclaimed";
  const mine = Boolean(viewer.id && ownerId === viewer.id);
  const files = Array.isArray(item.files) ? item.files : [];
  const blocks = item.fileBlocks && typeof item.fileBlocks === "object" ? item.fileBlocks : {};
  const fileLabel = file => blocks[file] ? `${file} (${blocks[file]})` : file;
  const fileBlock = files.length
    ? `<details class="claim-files"><summary>${files.length} file${files.length === 1 ? "" : "s"}</summary><ul>${files.map(file => `<li>${escapeHtml(fileLabel(file))}</li>`).join("")}</ul></details>`
    : "";
  const lease = item.state === "done" ? "" : countdown(item.leaseExpiresAt, now);
  const pulls = Array.isArray(item.pullRequests) && item.pullRequests.length ? item.pullRequests : (item.pullRequest?.url ? [item.pullRequest] : []);
  const pr = pulls.map((pull, index) => {
    const number = pullNumber(pull.url);
    const outcome = pull.outcome ? ` · ${pull.outcome}` : "";
    const ci = index === 0 && item.ci?.state ? ` <span class="ci-badge ci-${escapeHtml(item.ci.state)}">${escapeHtml(item.ci.state)}</span>` : "";
    return `<p class="claim-pr"><a href="${escapeHtml(pull.url)}">PR ${number ? `#${escapeHtml(number)}` : "link"}</a>${escapeHtml(outcome)}${ci}</p>`;
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
  const button = (action, label, tone) => `<button type="button" class="button ${tone}" data-claim-action="${action}" data-claim-id="${escapeHtml(item.id)}" data-focus-key="${action}:${escapeHtml(item.id)}">${label}</button>`;
  const actions = [];
  if (item.state === "unclaimed") actions.push(button("claim", "Claim", "primary"));
  if (mine && ["claimed", "in_progress", "blocked"].includes(item.state)) actions.push(button("renew", "Renew", "secondary"));
  if (mine && (item.state === "claimed" || item.state === "blocked")) actions.push(button("progress", "Mark in progress", "secondary"));
  if (mine && item.state === "in_progress") actions.push(button("done", "Done", "primary"));
  if (viewer.manage && ownerId && item.state !== "done" && item.state !== "unclaimed") {
    actions.push(button("release", "Release", "secondary"));
    const options = Object.values(members ?? {}).filter(member => member && member.active !== false && member.id !== ownerId)
      .map(member => `<option value="${escapeHtml(member.id)}">${escapeHtml(memberName(members, member.id))}</option>`).join("");
    if (options) actions.push(`<form data-claim-reassign="${escapeHtml(item.id)}"><label>Reassign <select name="newOwner" aria-label="Reassign ${escapeHtml(item.title)}">${options}</select></label><button type="submit" class="button secondary">Move</button></form>`);
  }
  const linked = typeof item.workItemId === "string" && Object.hasOwn(workItems ?? {}, item.workItemId) && workItems[item.workItemId]?.id === item.workItemId;
  const title = linked ? `<a href="#pr-record/work/${encodeURIComponent(item.workItemId)}" data-open-work="${escapeHtml(item.workItemId)}" data-focus-key="claim-work:${escapeHtml(item.id)}">${escapeHtml(item.title || item.id)}</a>` : escapeHtml(item.title || item.id);
  return `<article class="claim-card" data-claim-id="${escapeHtml(item.id)}"><h4 tabindex="-1">${title}</h4><p class="claim-owner">${ownerId ? `<span class="member-avatar" aria-hidden="true">${escapeHtml(initials(owner))}</span> ` : ""}<span>${escapeHtml(owner)}</span></p>${place}${fileBlock}${lease ? `<p class="claim-lease">${escapeHtml(lease)}</p>` : ""}${pr}${reviews}${deps ? `<ul class="claim-deps">${deps}</ul>` : ""}${links ? `<ul class="claim-chain">${links}</ul>` : ""}<div class="claim-actions">${actions.join("")}</div></article>`;
}

function newItemForm() {
  return `<form id="board-new-item" class="board-new"><h3>New item</h3><label>Title <input name="title" maxlength="200" required autocomplete="off"></label><label>Files <input name="files" maxlength="4000" autocomplete="off" placeholder="Optional, comma-separated"></label><button type="submit" class="button primary">Add item</button></form>`;
}

function boardHtml(items, status, viewer, members, now, { older = false, canWrite = false, capabilities = [], cap = 20, workItems = {} } = {}) {
  const columns = placeClaims(items, now);
  const sweep = viewer.manage ? `<button type="button" class="button secondary" id="board-close-stale" data-claim-action="sweep">Close stale</button>` : "";
  const capForm = viewer.owner ? `<form data-claim-cap><label>Claims per member <input name="maxMemberOpenClaims" type="number" min="1" max="10000" value="${escapeHtml(String(cap ?? 20))}" aria-label="Open claims per member"></label><button type="submit">Save cap</button></form>` : "";
  const form = canWrite ? newItemForm() : "";
  const hint = older ? `<p class="form-hint board-older">Older landed work is in the API</p>` : "";
  const body = items.length
    ? `${hint}<div class="board-columns">${COLUMNS.map(([id, label]) => `<section aria-labelledby="board-col-${id}"><h3 id="board-col-${id}">${label}</h3>${columns[id].map(item => cardHtml(item, viewer, members, now, workItems)).join("") || `<p class="form-hint">Nothing here.</p>`}</section>`).join("")}</div>`
    : `<p class="board-empty">${escapeHtml(emptyBoardCopy(capabilities))}</p>${hint}`;
  return `${form}<div class="board-head"><p class="live-chip">${escapeHtml(liveLabel(status))}</p>${sweep}${capForm}</div><p id="board-status" class="form-hint" role="status"></p>${body}`;
}

function staleDonePage(claims, now) {
  return claims.length > 0 && claims.every(item => {
    if (item?.state !== "done") return false;
    const at = Date.parse(updatedAt(item));
    return Number.isFinite(at) && now - at > WEEK;
  });
}

async function readClaims(client, now = Date.now()) {
  const claims = [];
  let cursor = null;
  let older = false;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: "200" });
    // SEC-2 adds updatedSince=now-7d once the list route accepts it. Until
    // then an unknown parameter is a 422, so the query stays limit and cursor
    // and a page of only old done items ends the walk.
    if (cursor) query.set("cursor", cursor);
    const body = await client.request(client.path(`/work-claims?${query}`));
    const pageClaims = body.claims ?? [];
    claims.push(...pageClaims);
    if (staleDonePage(pageClaims, now)) { older = true; break; }
    if (!body.nextCursor) return { claims, older };
    cursor = body.nextCursor;
  }
  return { claims, older };
}

function claimIdFromTitle(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${slug || "item"}-${suffix}`.slice(0, 128);
}

function filesFromField(value) {
  return String(value ?? "").split(/[\n,]/).map(part => part.trim()).filter(Boolean).slice(0, 64);
}

export function installWorkBoard({ client, getState, getSession }) {
  const root = document.querySelector("#work-board");
  if (!root) return { sync() {}, reset() {}, async whenReady() { return false; } };
  let items = [];
  let status = null;
  let cap = 20;
  let older = false;
  let seen = null;
  let loadedRoom = null;
  let loadedContext = null, operation = 0, readFlight = null, actionFlight = null;
  const context = () => {
    const current = getSession(), member = current?.member?.id;
    return current?.roomId && member && getState()?.members?.[member]?.id === member && getState().members[member].active !== false
      ? `${client.generation}|${current.roomId}|${member}` : null;
  };
  let busy = false;
  let pendingFocus = null;
  let pendingStatus = "";
  let stick = null;

  function paint() {
    const state = getState();
    const session = getSession();
    const active = document.activeElement;
    const restoreFocus = !active || active === document.body || root.contains(active);
    if (pendingFocus) stick = { key: pendingFocus.key ?? null, id: pendingFocus.id ?? null, status: pendingStatus };
    else if (!stick && restoreFocus) {
      const key = active?.closest?.("[data-focus-key]")?.dataset.focusKey ?? null;
      if (key) stick = { key, id: active.closest("article")?.dataset.claimId ?? null, status: "" };
    }
    pendingFocus = null;
    pendingStatus = "";
    root.innerHTML = boardHtml(items, status, viewerOf(state, session), state?.members ?? {}, Date.now(), {
      older, canWrite: canWriteClaims(state, session), capabilities: advertisedCapabilities(state), cap, workItems: state?.workItems ?? {}
    });
    if (stick?.status) {
      const line = root.querySelector("#board-status");
      if (line) line.textContent = stick.status;
    }
    if (!restoreFocus || !stick) return;
    const same = stick.key ? root.querySelector(`[data-focus-key="${CSS.escape(stick.key)}"]`) : null;
    const heading = !same && stick.id ? root.querySelector(`article[data-claim-id="${CSS.escape(stick.id)}"] h4`) : null;
    (same || heading)?.focus();
  }

  function note(text) {
    stick = { ...(stick ?? {}), status: text };
    const line = root.querySelector("#board-status");
    if (line) line.textContent = text;
  }

  function titleOf(id) {
    return items.find(item => item.id === id)?.title || id;
  }

  function outcome(action, id) {
    const title = titleOf(id);
    if (action === "claim") return `Claimed '${title}'`;
    if (action === "renew") return `Renewed '${title}'`;
    if (action === "progress") return `Marked '${title}' in progress`;
    if (action === "done") return `Done '${title}'`;
    if (action === "release") return `Released '${title}'`;
    if (action === "reassign") return `Reassigned '${title}'`;
    if (action === "create") return `Opened '${title}'`;
    return "Closed stale claims";
  }

  async function load({ force = false } = {}) {
    const session = getSession(), owned = context();
    if (!owned) return;
    if (loadedContext !== owned) {
      operation++; busy = false; loadedRoom = null; seen = null; items = []; status = null;
      loadedContext = owned; pendingFocus = null; pendingStatus = ""; stick = null; paint();
    }
    if (busy) return;
    const events = (getState()?.eventLog ?? []).filter(event => event.type === "work_claim.updated");
    const mark = events.length ? events[events.length - 1].id : "";
    if (!force && loadedRoom === session.roomId && seen === mark) return;
    const mine = ++operation;
    let pending = null;
    busy = true;
    try {
      pending = Promise.all([
        readClaims(client),
        client.request(client.path("/work-claims/status")),
        client.request(client.path("/work-claims/config"))
      ]);
      readFlight = pending;
      const [page, live, config] = await pending;
      if (mine !== operation || context() !== owned) return;
      items = page.claims;
      older = page.older;
      status = live;
      cap = config?.maxMemberOpenClaims ?? cap;
      loadedRoom = session.roomId;
      seen = mark;
      paint();
    } catch {
      if (mine === operation && context() === owned) note("Could not load the board.");
    } finally {
      if (readFlight === pending) readFlight = null;
      if (mine === operation) busy = false;
    }
  }

  async function act(run, focus) {
    const owned = context();
    if (!owned || busy) return;
    const mine = ++operation;
    if (focus) { pendingFocus = { key: focus.key ?? null, id: focus.id ?? null }; pendingStatus = focus.status ?? ""; }
    busy = true;
    let pending = null;
    try {
      pending = run(); actionFlight = pending;
      await pending;
      if (mine !== operation || context() !== owned) return;
      busy = false;
      await load({ force: true });
    } catch (error) {
      if (mine !== operation || context() !== owned) return;
      pendingFocus = null;
      pendingStatus = "";
      busy = false;
      note(error?.message || "Could not update the claim.");
    } finally {
      if (actionFlight === pending) actionFlight = null;
    }
  }

  root.addEventListener("click", event => {
    const button = event.target.closest("[data-claim-action]");
    if (!button || !root.contains(button)) return;
    const id = button.dataset.claimId;
    const action = button.dataset.claimAction;
    const focus = { key: button.dataset.focusKey ?? null, id: id ?? null, status: outcome(action, id) };
    if (action === "sweep") {
      void act(() => client.request(client.path("/work-claims/sweep"), { method: "POST", data: {} }), focus);
      return;
    }
    const path = client.path(`/work-claims/${encodeURIComponent(id)}`);
    if (action === "claim") void act(() => client.request(`${path}/claim`, { method: "POST", data: {} }), focus);
    else if (action === "release") void act(() => client.request(`${path}/release`, { method: "POST", data: {} }), focus);
    else if (action === "progress") void act(() => client.request(`${path}/update`, { method: "POST", data: { state: "in_progress" } }), focus);
    else if (action === "done") void act(() => client.request(`${path}/update`, { method: "POST", data: { state: "done" } }), focus);
    else if (action === "renew") {
      void act(() => client.request(`${path}/renew`, { method: "POST", data: {} }), focus);
    }
  });
  root.addEventListener("submit", event => {
    const created = event.target.closest("#board-new-item");
    if (created && root.contains(created)) {
      event.preventDefault();
      const data = new FormData(created);
      const title = String(data.get("title") ?? "").trim();
      if (!title) return;
      const id = claimIdFromTitle(title);
      const files = filesFromField(data.get("files"));
      const body = files.length ? { id, title, files } : { id, title };
      void act(() => client.request(client.path("/work-claims"), { method: "POST", data: body }), { id, status: `Opened '${title}'` });
      return;
    }
    const form = event.target.closest("[data-claim-reassign]");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const id = form.dataset.claimReassign;
    const newOwner = new FormData(form).get("newOwner");
    if (typeof newOwner !== "string" || !newOwner) return;
    void act(() => client.request(client.path(`/work-claims/${encodeURIComponent(id)}/reassign`), { method: "POST", data: { newOwner } }), { id, status: outcome("reassign", id) });
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
    async whenReady() {
      const owned = context();
      if (!owned) return false;
      try {
        if (actionFlight) await actionFlight;
        if (context() !== owned) return false;
        if (readFlight) await readFlight;
        else await load();
      } catch { return false; }
      return context() === owned && loadedContext === owned && loadedRoom === getSession()?.roomId;
    },
    reset() { operation++; busy = false; readFlight = null; actionFlight = null; loadedContext = null; items = []; status = null; cap = 20; older = false; seen = null; loadedRoom = null; pendingFocus = null; pendingStatus = ""; stick = null; if (root.isConnected) root.replaceChildren(); }
  };
}
