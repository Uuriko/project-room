// Squads panel (plan-squads): read-only squad roster UI. Lazy-loaded like
// board-ui.js; the panel lists every squad in the room with its goal,
// members, channel thread, and owner. Reads only — roster writes stay on
// REST/MCP for now.
import { escapeHtml } from "./board-ui.js";

function squadHtml(squad, members) {
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
  return `<article class="squad-card" data-squad-id="${escapeHtml(squad.id)}">
    <h4>@squad/${name}${state}</h4>
    <p class="squad-goal">${goal}</p>
    <dl class="squad-meta">
      <div><dt>Channel</dt><dd>${channel}</dd></div>
      <div><dt>Members</dt><dd><ul class="squad-roster">${roster}</ul></dd></div>
    </dl>
  </article>`;
}

export function squadsHtml(squads, members) {
  if (!squads.length) {
    return `<p class="squads-empty">No squads yet. Create one from REST <code>POST /api/rooms/{roomId}/squads</code> — then mention it as <code>@squad/&lt;name&gt;</code> to fan out to every member.</p>`;
  }
  return squads.map(squad => squadHtml(squad, members)).join("");
}

export function installSquadsPanel({ client, getState, getSession }) {
  const root = document.querySelector("#squads-list");
  if (!root) return { sync() {}, reset() {} };
  let squads = [], error = "", loadedRoom = null, flight = null;

  function paint() {
    const state = getState();
    if (error) {
      root.innerHTML = `<p class="squads-error" role="alert">${escapeHtml(error)}</p>`;
      return;
    }
    root.innerHTML = squadsHtml(squads, state?.members ?? {});
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

  return {
    sync: () => load(),
    reset() { squads = []; error = ""; loadedRoom = null; flight = null; paint(); },
  };
}
