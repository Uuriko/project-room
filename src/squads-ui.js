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
    return `<li>${escapeHtml(label)}${escapeHtml(ownerMark)}</li>`;
  }).join("");
  const channel = squad.channel
    ? `<a href="#message-${escapeHtml(squad.channel)}" data-thread-root="${escapeHtml(squad.channel)}">open thread</a>`
    : "—";
  const state = squad.state === "disbanded" ? ` <span class="squad-state">disbanded</span>` : "";
  const disband = squad.state === "active" && me && squad.owner === me
    ? ` <button type="button" data-squad-action="disband" data-squad-id="${escapeHtml(squad.id)}">disband</button>`
    : "";
  return `<article class="squad-card" data-squad-id="${escapeHtml(squad.id)}">
    <h4>@squad/${name}${state}${disband}</h4>
    <p class="squad-goal">${goal}</p>
    <dl class="squad-meta">
      <div><dt>Channel</dt><dd>${channel}</dd></div>
      <div><dt>Members</dt><dd><ul class="squad-roster">${roster}</ul></dd></div>
    </dl>
  </article>`;
}

export function squadsHtml(squads, members, me = null) {
  const form = `<form class="squads-create" data-squad-action="create">
    <input name="name" required maxlength="64" pattern="[A-Za-z0-9_-]{1,64}" placeholder="squad name" aria-label="Squad name">
    <input name="goal" maxlength="500" placeholder="goal (optional)" aria-label="Squad goal">
    <button type="submit">create squad</button>
  </form>`;
  if (!squads.length) {
    return `${form}<p class="squads-empty">No squads yet. Mention one as <code>@squad/&lt;name&gt;</code> to fan out to every member (at most 12).</p>`;
  }
  return form + squads.map(squad => squadHtml(squad, members, me)).join("");
}

export function installSquadsPanel({ client, getState, getSession }) {
  const root = document.querySelector("#squads-list");
  if (!root) return { sync() {}, reset() {} };
  let squads = [], error = "", loadedRoom = null, flight = null, mutating = false;

  function paint() {
    const state = getState();
    if (error) {
      root.innerHTML = `<p class="squads-error" role="alert">${escapeHtml(error)}</p>`;
      return;
    }
    const me = getSession()?.member?.id ?? null;
    root.innerHTML = squadsHtml(squads, state?.members ?? {}, me);
  }

  async function load({ force = false } = {}) {
    const session = getSession();
    const roomId = session?.roomId;
    if (!roomId) return;
    if (!force && loadedRoom === roomId && flight === "done") { paint(); return; }
    if (flight && flight !== "done") return;
    flight = "loading";
    try {
      const res = await client.request(client.path("/squads"));
      squads = res?.squads ?? [];
      error = "";
      loadedRoom = roomId;
    } catch (err) {
      error = err?.message || "Could not load squads.";
      squads = [];
    }
    flight = "done";
    paint();
  }

  async function act(work) {
    if (mutating) return;
    mutating = true;
    try {
      await work();
      error = "";
    } catch (err) {
      error = err?.message || "Squad action failed.";
    } finally {
      mutating = false;
    }
    await load({ force: true });
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
      method: "POST", data: goal ? { name, goal } : { name },
    }));
  });

  root.addEventListener("click", event => {
    const button = event.target.closest("[data-squad-action='disband']");
    if (!button || !root.contains(button)) return;
    const id = button.dataset.squadId;
    if (!id || !window.confirm(`Disband @squad/${id}? The squad stops fanning out mentions.`)) return;
    void act(() => client.request(client.path(`/squads/${encodeURIComponent(id)}/disband`), {
      method: "POST", data: {},
    }));
  });

  return {
    sync: () => load(),
    reset() { squads = []; error = ""; loadedRoom = null; flight = null; paint(); },
  };
}
