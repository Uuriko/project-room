// Optional room split. Off until a person turns it on, so chat stays the page.
import { uiText } from "./strings.js";
import { briefHistoryGroup } from "./return-brief.js";
import { memberHandle, memberStatus } from "./conversation.js";

const STORAGE_KEY = "project-room-lanes";
const QUERY_APPLIED = "project-room-lanes-query";
const LANE_KEY = "project-room-lane";
const LANES = ["conversation", "work", "receipts"];

let readContext = () => ({ enabled: false });
let selected = "conversation";
let laneReady = false;
let chipOpen = false;
let listening = false;

function storageGet(storage, key) {
  try { return storage?.getItem?.(key) ?? null; } catch { return null; }
}

function storageSet(storage, key, value) {
  try { storage?.setItem?.(key, value); } catch { /* private mode */ }
}

// The query string applies once. A later toggle is not overwritten on every paint.
export function readLanesFlag(search, storage) {
  const params = new URLSearchParams(typeof search === "string" ? search.replace(/^\?/, "") : "");
  if (params.has("lanes") && storageGet(storage, QUERY_APPLIED) !== "1") {
    const on = params.get("lanes") === "1";
    storageSet(storage, STORAGE_KEY, on ? "1" : "0");
    storageSet(storage, QUERY_APPLIED, "1");
    return on;
  }
  return storageGet(storage, STORAGE_KEY) === "1";
}

export function messageLane(message, members) {
  if (!message) return "conversation";
  if (message.kind === "receipt_card") return "receipts";
  const author = members?.[message.authorId];
  if (author?.system === true) return "system";
  return "conversation";
}

export function nodeLane(node, state) {
  if (!node || typeof node.hasAttribute !== "function") return "conversation";
  if (node.hasAttribute("data-claim-update")) return "system";
  if (node.hasAttribute("data-work-timeline")) {
    const item = state?.workItems?.[node.getAttribute("data-work-timeline")];
    if (item?.receipt?.eventId || item?.state === "completed") return "receipts";
    return "work";
  }
  const recordId = node.dataset?.messageRecordId;
  if (!recordId || !Array.isArray(state?.messages)) return "conversation";
  let message = null;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (state.messages[index]?.id === recordId) { message = state.messages[index]; break; }
  }
  return messageLane(message, state?.members);
}

export function catchUpLine({ finished = 0, needsYou = 0 } = {}) {
  const done = Number.isFinite(finished) && finished > 0 ? finished : 0;
  const needs = Number.isFinite(needsYou) && needsYou > 0 ? needsYou : 0;
  if (!done && !needs) return "";
  if (done && needs === 1) return uiText("lanes.catchup.both.one", { finished: done });
  if (done && needs > 1) return uiText("lanes.catchup.both.many", { finished: done, needsYou: needs });
  if (done) return uiText("lanes.catchup.finished", { finished: done });
  if (needs === 1) return uiText("lanes.catchup.needs.one");
  return uiText("lanes.catchup.needs.many", { needsYou: needs });
}

// Counts only the frozen return-brief window, grouped the same way as catch-up.
export function finishedSince(items, viewerId) {
  let count = 0;
  for (const item of items || []) if (briefHistoryGroup(item, viewerId) === "outcome") count += 1;
  return count;
}

export function agentStatusLines(members, context) {
  return Object.values(members || {})
    .filter(member => member && member.kind === "agent" && member.active !== false && member.system !== true)
    .map(member => ({
      id: member.id,
      name: memberHandle(member),
      status: memberStatus(member, context),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
}

function currentLane() {
  if (!laneReady) {
    laneReady = true;
    const stored = storageGet(globalThis.sessionStorage, LANE_KEY);
    if (LANES.includes(stored)) selected = stored;
  }
  return selected;
}

function chooseLane(lane) {
  if (!LANES.includes(lane)) return;
  selected = lane;
  laneReady = true;
  storageSet(globalThis.sessionStorage, LANE_KEY, lane);
}

function paintStatus(list, lines) {
  const seen = new Set();
  for (const line of lines) {
    seen.add(line.id);
    let row = [...list.children].find(entry => entry.dataset.agentId === line.id);
    if (!row) {
      row = list.ownerDocument.createElement("li");
      row.dataset.agentId = line.id;
      const name = list.ownerDocument.createElement("strong");
      const detail = list.ownerDocument.createElement("span");
      row.append(name, detail);
      list.append(row);
    }
    const name = row.querySelector("strong");
    const detail = row.querySelector("span");
    if (name.textContent !== line.name) name.textContent = line.name;
    if (detail.textContent !== line.status) detail.textContent = line.status;
  }
  for (const row of [...list.children]) if (!seen.has(row.dataset.agentId)) row.remove();
}

function ensureChrome(doc, enabled) {
  const topbar = doc.querySelector(".room-topbar .topbar-actions");
  let toggle = doc.getElementById("lane-toggle");
  if (topbar && !toggle) {
    toggle = doc.createElement("button");
    toggle.id = "lane-toggle";
    toggle.type = "button";
    toggle.className = "topbar-button";
    topbar.prepend(toggle);
  }
  if (toggle) {
    toggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    toggle.textContent = enabled ? uiText("lanes.hide") : uiText("lanes.show");
  }
  const list = doc.getElementById("message-list");
  const chrome = doc.getElementById("room-lanes");
  if (!enabled) {
    chrome?.remove();
    list?.querySelectorAll(":scope > .lane-folded").forEach(node => node.classList.remove("lane-folded"));
    return null;
  }
  if (!list) return null;
  if (chrome) return chrome;
  const root = doc.createElement("div");
  root.id = "room-lanes";
  root.className = "room-lanes";
  const tabs = doc.createElement("div");
  tabs.className = "room-lane-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", uiText("lanes.tabs"));
  for (const lane of LANES) {
    const button = doc.createElement("button");
    button.type = "button";
    button.id = `lane-tab-${lane}`;
    button.setAttribute("role", "tab");
    button.dataset.laneTab = lane;
    button.setAttribute("aria-controls", "message-list");
    button.textContent = uiText(`lanes.${lane}`);
    tabs.append(button);
  }
  tabs.addEventListener("keydown", event => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = LANES.indexOf(currentLane());
    const next = event.key === "ArrowRight" ? (index + 1) % LANES.length
      : event.key === "ArrowLeft" ? (index + LANES.length - 1) % LANES.length
      : event.key === "Home" ? 0 : LANES.length - 1;
    chooseLane(LANES[next]);
    syncRoomLanes(doc);
    doc.getElementById(`lane-tab-${LANES[next]}`)?.focus();
  });
  const catchup = doc.createElement("p");
  catchup.id = "lane-catchup";
  catchup.className = "lane-catchup";
  catchup.hidden = true;
  const status = doc.createElement("ul");
  status.id = "lane-status";
  status.className = "lane-status";
  const empty = doc.createElement("p");
  empty.id = "lane-empty";
  empty.className = "lane-catchup";
  empty.hidden = true;
  const chip = doc.createElement("button");
  chip.id = "lane-chip";
  chip.type = "button";
  chip.className = "lane-chip text-button";
  chip.hidden = true;
  root.append(tabs, catchup, status, empty, chip);
  list.before(root);
  return root;
}

export function installRoomLanes(read) {
  readContext = typeof read === "function" ? read : () => ({ enabled: false });
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("click", event => {
    const toggle = event.target.closest?.("#lane-toggle");
    const tab = event.target.closest?.("[data-lane-tab]");
    const chip = event.target.closest?.("#lane-chip");
    if (!toggle && !tab && !chip) return;
    if (toggle) {
      const next = toggle.getAttribute("aria-pressed") !== "true";
      storageSet(globalThis.sessionStorage, STORAGE_KEY, next ? "1" : "0");
      storageSet(globalThis.sessionStorage, QUERY_APPLIED, "1");
    } else if (tab) chooseLane(tab.getAttribute("data-lane-tab"));
    else chipOpen = !chipOpen;
    syncRoomLanes(document);
  });
}

export function syncRoomLanes(doc = globalThis.document) {
  if (!doc?.getElementById) return;
  const ctx = readContext() || {};
  const enabled = ctx.enabled === true;
  const chrome = ensureChrome(doc, enabled);
  const list = doc.getElementById("message-list");
  if (!enabled || !chrome || !list) return;
  const lane = currentLane();
  for (const button of chrome.querySelectorAll("[data-lane-tab]")) {
    const on = button.dataset.laneTab === lane;
    button.setAttribute("aria-selected", on ? "true" : "false");
    button.tabIndex = on ? 0 : -1;
  }
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const counts = { work: 0, receipts: 0, system: 0 };
  for (const node of list.children) {
    const place = nodeLane(node, ctx.state);
    if (place === "work" || place === "receipts" || place === "system") counts[place] += 1;
    const structural = node.classList?.contains("timeline-pager") || node.classList?.contains("empty-note");
    const showSystem = place === "system" && lane === "conversation" && chipOpen;
    const visible = structural ? lane === "conversation" : place === lane || showSystem || place === "conversation" && lane === "conversation";
    node.classList.toggle("lane-folded", !visible);
  }
  const catchup = chrome.querySelector("#lane-catchup");
  const line = catchUpLine({
    finished: finishedSince(ctx.brief?.history?.items, ctx.viewerId),
    needsYou: Array.isArray(ctx.needsYou) ? ctx.needsYou.length : 0,
  });
  catchup.hidden = !line;
  if (line && catchup.textContent !== line) catchup.textContent = line;
  paintStatus(chrome.querySelector("#lane-status"), agentStatusLines(ctx.state?.members, { workItems: ctx.state?.workItems }));
  const empty = chrome.querySelector("#lane-empty");
  const emptyText = lane === "work" && counts.work === 0 ? uiText("lanes.empty.work")
    : lane === "receipts" && counts.receipts === 0 ? uiText("lanes.empty.receipts") : "";
  empty.hidden = !emptyText;
  if (emptyText && empty.textContent !== emptyText) empty.textContent = emptyText;
  const chip = chrome.querySelector("#lane-chip");
  const updates = lane === "conversation" ? counts.system : 0;
  chip.hidden = updates === 0;
  if (updates) {
    const label = updates === 1 ? uiText("lanes.updates.one") : uiText("lanes.updates", { count: updates });
    if (chip.textContent !== label) chip.textContent = label;
    chip.setAttribute("aria-expanded", chipOpen ? "true" : "false");
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
}
