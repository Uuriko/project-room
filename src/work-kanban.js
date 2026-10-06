// Kanban board view for room work (backlog K004).
//
// Standalone view: four lifecycle columns (unclaimed -> claimed ->
// in_progress -> done). Reads claim state through the existing work-claims
// API; moves go through the existing claim/update APIs (claimWork for
// unclaimed -> claimed, updateWork otherwise). The server
// (server/work-claims.mjs TRANSITIONS) stays the enforcer — the client only
// ever offers moves the state machine allows, and only to members allowed
// to make them.
//
// Rendering is DOM-based (templates in kanban.html, textContent for all
// user data): no HTML string building, so claim titles can never break the
// markup. Pure helpers are exported for unit tests; the DOM boot at the
// bottom runs only in a browser.

export const KANBAN_COLUMNS = Object.freeze(["unclaimed", "claimed", "in_progress", "done"]);

// Client copy of the lifecycle transitions. The parity test
// (tests/work-kanban.test.js) asserts this matches server/work-claims.mjs
// TRANSITIONS exactly, so a server-side change fails loudly here instead of
// the board silently offering moves the API will reject.
const CLIENT_TRANSITIONS = Object.freeze({
  unclaimed: Object.freeze(["claimed"]),
  claimed: Object.freeze(["in_progress", "blocked", "unclaimed"]), // unclaimed = release
  in_progress: Object.freeze(["blocked", "done", "claimed"]),       // claimed = pause
  blocked: Object.freeze(["in_progress", "claimed"]),
  done: Object.freeze([]),
});

export function allowedMoves(state) {
  const moves = CLIENT_TRANSITIONS[String(state ?? "")];
  return moves ? [...moves] : [];
}

// Single-word move labels (never prose).
const MOVE_LABELS = Object.freeze({
  claimed: "Claim",
  in_progress: "Start",
  blocked: "Block",
  done: "Done",
  unclaimed: "Release",
});

function moveLabel(from, to) {
  if (from === "in_progress" && to === "claimed") return "Pause";
  if (from === "blocked") return to === "claimed" ? "Unblock" : MOVE_LABELS[to];
  return MOVE_LABELS[to] ?? to;
}

// Groups claims by lifecycle column. "blocked" is not one of the four
// kanban columns, so blocked claims get their own strip — never dropped.
export function groupClaims(claims) {
  const groups = { unclaimed: [], claimed: [], in_progress: [], done: [], blocked: [] };
  for (const claim of claims ?? []) {
    const bucket = Object.prototype.hasOwnProperty.call(groups, claim?.state) ? claim.state : "unclaimed";
    groups[bucket].push(claim);
  }
  return groups;
}

// Render model: the four columns plus the blocked strip, in order.
export function kanbanModel(claims, { viewerId } = {}) {
  const groups = groupClaims(claims);
  return {
    columns: KANBAN_COLUMNS.map(name => ({ name, claims: groups[name], viewerId })),
    blocked: groups.blocked,
    viewerId,
  };
}

function isOwner(claim, viewerId) {
  return Boolean(viewerId) && claim?.owner === viewerId;
}

// Move buttons for one card: only valid lifecycle transitions. Claiming
// unclaimed work is open to any signed-in member (claimWork); every other
// transition is owner-only (updateWork). Everyone else gets a read-only card.
export function moveButtons(claim, { viewerId } = {}) {
  if (!viewerId) return [];
  if (claim?.state === "unclaimed") return [{ to: "claimed", label: moveLabel("unclaimed", "claimed") }];
  if (!isOwner(claim, viewerId)) return [];
  return allowedMoves(claim?.state).map(to => ({ to, label: moveLabel(claim.state, to) }));
}

// Where a move is sent. Claiming unclaimed work goes through the claim
// endpoint (claimWork); every other transition goes through the update
// endpoint (updateWork). Pure so tests can pin the routing.
export function moveEndpoint(roomId, claim, to) {
  const claimsBase = `/api/rooms/${encodeURIComponent(roomId)}/work-claims`;
  const base = [claimsBase, encodeURIComponent(claim?.id)].join("/");
  if (claim?.state === "unclaimed" && to === "claimed") {
    return { path: `${base}/claim`, method: "POST", data: {} };
  }
  return { path: `${base}/update`, method: "POST", data: { state: to } };
}

// ---- browser boot (not exercised by unit tests) ----

function roomIdFromLocation(locationLike = globalThis.location) {
  const params = new URLSearchParams(String(locationLike?.search ?? "").replace(/^\?/, ""));
  const room = params.get("room");
  return typeof room === "string" && room.length > 0 && room.length <= 384 ? room : null;
}

function setStatus(doc, text) {
  const line = doc.querySelector("#kanban-status");
  if (line) line.textContent = text;
}

// Status with a dynamic detail: the static prefix stays a short non-prose
// literal, the detail is appended as a text node (never interpolated).
function setStatusDetail(doc, prefix, detail) {
  const line = doc.querySelector("#kanban-status");
  if (!line) return;
  line.textContent = prefix;
  line.append(String(detail ?? ""));
}

function showStatic(doc, id) {
  const el = doc.getElementById(id);
  if (el) el.hidden = false;
}

function makeCard(doc, template, claim, viewerId) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.claimId = claim.id;
  node.dataset.claimState = claim.state;
  node.querySelector("h4").textContent = claim.title || claim.id || "untitled";
  const ownerLine = node.querySelector(".kanban-owner");
  if (claim.owner) {
    ownerLine.textContent = String(claim.owner).slice(0, 12);
  } else {
    ownerLine.remove();
  }
  const moves = node.querySelector(".kanban-moves");
  for (const button of moveButtons(claim, { viewerId })) {
    const el = doc.createElement("button");
    el.type = "button";
    el.textContent = button.label;
    el.dataset.moveTo = button.to;
    el.dataset.claimId = claim.id;
    moves.append(el);
  }
  if (!moves.hasChildNodes()) moves.remove();
  return node;
}

export async function bootKanban({ document: doc = globalThis.document, location: loc = globalThis.location } = {}) {
  const root = doc.querySelector("#kanban");
  if (!root) return false;
  const fail = (staticId) => {
    const loading = doc.getElementById("kanban-loading");
    if (loading) loading.remove();
    showStatic(doc, staticId);
  };

  let AccountClient;
  try {
    ({ AccountClient } = await import("./client.js"));
  } catch {
    fail("kanban-noclient");
    return false;
  }
  const account = new AccountClient();
  let session;
  try {
    session = await account.restore();
  } catch {
    session = null;
  }
  if (!session) {
    fail("kanban-signin");
    return false;
  }
  const roomId = roomIdFromLocation(loc) || session.roomId;
  const viewerId = session?.member?.id ?? null;
  if (!roomId) {
    fail("kanban-noroom");
    return false;
  }

  const template = doc.getElementById("kanban-card-template");
  const claimsBase = `/api/rooms/${encodeURIComponent(roomId)}/work-claims`;
  const byId = new Map();

  async function refresh() {
    let items = [];
    try {
      const result = await account.request(claimsBase);
      items = result?.claims ?? result?.items ?? [];
    } catch (error) {
      setStatusDetail(doc, "Load failed: ", error?.message ?? error);
      return;
    }
    const loading = doc.getElementById("kanban-loading");
    if (loading) loading.remove();
    byId.clear();
    for (const item of items) byId.set(item.id, item);
    const model = kanbanModel(items, { viewerId });
    for (const column of model.columns) {
      const zone = root.querySelector(`[data-drop-column="${column.name}"]`);
      if (!zone) continue;
      zone.replaceChildren();
      const count = zone.closest("[data-column]")?.querySelector(".kanban-count");
      if (count) count.textContent = String(column.claims.length);
      for (const claim of column.claims) zone.append(makeCard(doc, template, claim, viewerId));
    }
    const blockedSection = doc.getElementById("kanban-blocked");
    const blockedZone = blockedSection?.querySelector(".kanban-cards");
    if (blockedSection && blockedZone) {
      blockedSection.hidden = model.blocked.length === 0;
      blockedZone.replaceChildren();
      const count = blockedSection.querySelector(".kanban-count");
      if (count) count.textContent = String(model.blocked.length);
      for (const claim of model.blocked) blockedZone.append(makeCard(doc, template, claim, viewerId));
    }
  }

  async function attemptMove(id, to) {
    const claim = byId.get(id);
    const from = claim?.state;
    if (!allowedMoves(from).includes(to)) {
      setStatus(doc, "Invalid move.");
      return;
    }
    setStatus(doc, "Moving…");
    try {
      const { path, method, data } = moveEndpoint(roomId, claim ?? { id, state: from }, to);
      await account.request(path, { method, data });
      setStatus(doc, "Moved.");
      await refresh();
    } catch (error) {
      setStatusDetail(doc, "Move failed: ", error?.message ?? error);
    }
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-move-to]");
    if (!button) return;
    void attemptMove(button.dataset.claimId, button.dataset.moveTo);
  });
  let dragged = null;
  root.addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-claim-id]");
    if (!card) return;
    dragged = card;
    event.dataTransfer.effectAllowed = "move";
    try { event.dataTransfer.setData("text/plain", card.dataset.claimId); } catch { /* noop */ }
  });
  root.addEventListener("dragover", (event) => {
    if (!event.target.closest("[data-drop-column]")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  });
  root.addEventListener("drop", (event) => {
    const zone = event.target.closest("[data-drop-column]");
    if (!zone || !dragged) return;
    event.preventDefault();
    const id = dragged.dataset.claimId;
    dragged = null;
    void attemptMove(id, zone.dataset.dropColumn);
  });
  root.addEventListener("dragend", () => { dragged = null; });

  await refresh();
  return true;
}

if (typeof globalThis.document !== "undefined" && typeof globalThis.location !== "undefined") {
  const el = globalThis.document.querySelector("#kanban[data-autoboot]");
  if (el) void bootKanban();
}
