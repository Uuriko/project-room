import { uiText } from "./strings.js";

// Owner stop for the room header. A pause lasts until resume: the roster's
// pausedAt is a start time, and the line says "until resumed".
export function pauseHeaderModel({ owner, members, paused, armed }) {
  if (!owner) return { visible: false, armed: false, lines: [], targets: [] };
  const people = (Array.isArray(members) ? members : []).filter(member => member && typeof member.id === "string");
  const byId = new Map(people.map(member => [member.id, member]));
  const held = new Set();
  const lines = [];
  for (const row of Array.isArray(paused) ? paused : []) {
    const member = byId.get(row?.memberId);
    const name = typeof member?.displayName === "string" ? member.displayName.trim() : "";
    if (!member || member.active === false || !name) continue;
    held.add(member.id);
    lines.push({ memberId: member.id, name, since: Number.isFinite(row?.pausedAt) ? row.pausedAt : null });
  }
  const targets = armed
    ? people.filter(member => member.kind === "agent" && member.active !== false && member.identityRevoked !== true && !held.has(member.id)).map(member => member.id)
    : [];
  return { visible: true, armed: Boolean(armed), lines, targets };
}

export function pauseLineText(line, formatTime) {
  const name = String(line?.name ?? "");
  const when = Number.isFinite(line?.since) && typeof formatTime === "function" ? String(formatTime(line.since) ?? "") : "";
  if (when) return uiText("pause.header.since", { name, when });
  return uiText("pause.header.line", { name });
}

export function renderPauseHeader(root, model, formatTime) {
  if (!root) return;
  root.hidden = !model.visible;
  const label = root.querySelector("[data-pause-label]");
  const button = root.querySelector("[data-pause-all]");
  const keep = root.querySelector("[data-pause-keep]");
  if (label) label.textContent = uiText(model.armed ? "pause.header.confirm" : "pause.header.pause");
  if (button) button.setAttribute("aria-pressed", model.armed ? "true" : "false");
  if (keep) { keep.hidden = !model.armed; keep.textContent = uiText("pause.header.keep"); }
  const status = root.querySelector("[data-pause-status]");
  if (!status) return;
  status.replaceChildren();
  if (!model.visible) return;
  if (model.lines.length === 0) {
    status.textContent = uiText("pause.header.none");
    return;
  }
  const list = document.createElement("ul");
  for (const line of model.lines) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = pauseLineText(line, formatTime);
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "topbar-button";
    resume.dataset.pauseResume = line.memberId;
    resume.textContent = uiText("pause.header.resume");
    resume.setAttribute("aria-label", uiText("pause.header.resume_name", { name: line.name }));
    item.append(text, resume);
    list.append(item);
  }
  status.append(list);
}
