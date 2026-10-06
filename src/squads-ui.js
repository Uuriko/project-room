import { uiText } from './strings.js';
// Squads panel (plan-squads): squad roster UI. Lazy-loaded like board-ui.js;
// the panel lists every squad in the room with its goal, members, channel
// thread, and owner, plus create/disband actions (the same calls as the
// REST routes; the server enforces owner-only disband and the 12-member cap).
import { escapeHtml } from "./board-ui.js";

function squadHtml(squad, members, me) {
  const name = escapeHtml(squad.name);
  const goal = escapeHtml(squad.goal || "—");
  const roster = (squad.members || []).map(id => {
    const m = members?.[id];
    const label = m?.displayName || id;
    const ownerMark = id === squad.owner ? " · owner" : "";
    return ["<li>", escapeHtml(label), "", escapeHtml(ownerMark), "</li>"].join('');
  }).join("");
  const channel = squad.channel
    ? ["<a href=\"#message-", escapeHtml(squad.channel), "\" data-thread-root=\"", escapeHtml(squad.channel), "\">open thread</a>"].join('')
    : "—";
  const state = squad.state === "disbanded" ? ` <span class="squad-state">disbanded</span>` : "";
  const disband = squad.state === "active" && me && squad.owner === me
    ? ` <button type="button" data-squad-action="disband" data-squad-id="${escapeHtml(squad.id)}">disband</button>`
    : "";
  return uiText("squads.copy.001", { fragmentA: escapeHtml(squad.id), fragmentB: name, fragmentC: state, fragmentD: disband, fragmentE: goal, fragmentF: channel, fragmentG: roster });
}

export function squadsHtml(squads, members, me = null) {
  const rosterOptions = Object.entries(members ?? {}).filter(([id, m]) => id !== me && m.active !== false)
    .map(([id, m]) => ["<label><input type=\"checkbox\" name=\"memberId\" value=\"", escapeHtml(id), "\">", escapeHtml(m.displayName || id), "</label>"].join('')).join("");
  const form = uiText("squads.copy.002", { fragmentA: rosterOptions });
  if (!squads.length) {
    return uiText("squads.copy.003", { fragmentA: form });
  }
  return form + squads.map(squad => squadHtml(squad, members, me)).join("");
}

export function installSquadsPanel({ client, getState, getSession }) {
  const root = document.querySelector("#squads-list");
  if (!root) return { sync() {}, reset() {} };
  let squads = [], error = "", loadedRoom = null, flight = null, mutating = false;
  let epoch = 0, boundary = null, painted = null;
  const boundaryKey = () => JSON.stringify([getSession()?.roomId, getSession()?.member?.id, client.generation]);
  const current = (ticket, key) => ticket === epoch && key === boundaryKey();

  function paint() {
    const state = getState();
    const me = getSession()?.member?.id ?? null;
    const html = (error ? `<p class="squads-error" role="alert">${escapeHtml(error)}</p>` : "")
      + squadsHtml(squads, state?.members ?? {}, me);
    if (painted === html) return;
    const form = root.querySelector("form"), draft = form ? new FormData(form) : null;
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusName = focused?.name, start = focused?.selectionStart, end = focused?.selectionEnd;
    root.innerHTML = html;
    painted = html;
    if (draft) for (const input of root.querySelectorAll("input")) {
      if (input.type === "checkbox") input.checked = draft.getAll(input.name).includes(input.value);
      else input.value = draft.get(input.name) ?? "";
    }
    if (focusName) {
      const input = Array.from(root.querySelectorAll("input")).find(i => i.name === focusName);
      input?.focus();
      if (typeof start === "number") input?.setSelectionRange(start, end);
    }
  }

  async function load({ force = false } = {}) {
    const session = getSession();
    const roomId = session?.roomId;
    const key = boundaryKey();
    if (boundary !== key) {
      epoch++; boundary = key; squads = []; error = ""; loadedRoom = null; flight = null; mutating = false; painted = null; root.replaceChildren();
    }
    const ticket = epoch;
    if (!roomId) return;
    if (!force && loadedRoom === roomId && flight === "done") { paint(); return; }
    if (flight && flight !== "done") return;
    flight = "loading";
    try {
      const res = await client.request(client.path("/squads"));
      if (!current(ticket, key)) return;
      squads = res?.squads ?? [];
      error = "";
      loadedRoom = roomId;
    } catch (err) {
      if (!current(ticket, key)) return;
      error = err?.message || uiText("squads.copy.004");
      squads = [];
    }
    if (!current(ticket, key)) return;
    flight = "done";
    paint();
  }

  async function act(work) {
    if (mutating) return;
    mutating = true;
    const ticket = epoch, key = boundaryKey();
    try {
      await work();
      if (!current(ticket, key)) return;
      error = "";
      root.querySelector("form")?.reset();
      await load({ force: true });
    } catch (err) {
      if (!current(ticket, key)) return;
      error = err?.message || uiText("squads.copy.005");
      paint();
    } finally {
      if (current(ticket, key)) mutating = false;
    }
  }

  root.addEventListener("submit", event => {
    const form = event.target.closest("[data-squad-action='create']");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get("name") || "").trim();
    const goal = String(data.get("goal") || "").trim();
    if (!name) return;
    void act(() => client.request(client.path("/squads"), {
      method: "POST", data: { name, goal, memberIds: data.getAll("memberId") },
    }));
  });

  root.addEventListener("click", event => {
    const button = event.target.closest("[data-squad-action='disband']");
    if (!button || !root.contains(button)) return;
    const id = button.dataset.squadId;
    if (!id || !window.confirm(uiText("squads.copy.006", { fragmentA: id }))) return;
    void act(() => client.request(client.path(`/squads/${encodeURIComponent(id)}/disband`), {
      method: "POST", data: {},
    }));
  });

  return {
    sync: () => load(),
    reset() { epoch++; boundary = null; mutating = false; squads = []; error = ""; loadedRoom = null; flight = null; painted = null; root.replaceChildren(); },
  };
}
