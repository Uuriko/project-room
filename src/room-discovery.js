import { uiText } from "./strings.js";

// Listing is visibility, not admission. Human requests use the account-bound flow.
export function installRoomDiscovery({ getSession, onRequestRoom, fetchImpl = globalThis.fetch }) {
  const $ = selector => document.querySelector(selector);
  const panel = $("#room-discovery"), list = $("#room-discovery-list");
  const trigger = $("#room-choice-discover"), status = $("#room-discovery-status");
  const more = $("#room-discovery-more"), retry = $("#room-discovery-retry");
  let generation = 0, controller = null, cursor = null, loaded = false, owner = null;
  const ids = new Set();
  function reset() {
    generation++; controller?.abort(); controller = null;
    cursor = null; loaded = false; owner = null; ids.clear(); list.replaceChildren();
    panel.hidden = true; more.hidden = true; retry.hidden = true;
    status.textContent = ""; trigger.setAttribute("aria-expanded", "false");
  }
  async function load() {
    const session = getSession();
    if (!session?.authenticated || session.terms?.required || controller) return;
    if (owner && owner !== session) reset();
    owner = session;
    const version = generation, abort = new AbortController(); controller = abort;
    more.hidden = true; retry.hidden = true;
    status.textContent = uiText("rooms.discovery.loading");
    try {
      const url = new URL("/api/public/rooms/directory", location.origin);
      if (cursor) url.searchParams.set("after", cursor);
      const response = await fetchImpl(url, { signal: abort.signal, credentials: "omit" });
      if (!response.ok) throw new Error("directory_unavailable");
      const page = await response.json();
      if (version !== generation || getSession() !== session) return;
      if (!Array.isArray(page.rooms) || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new Error("directory_invalid");
      const fragment = document.createDocumentFragment(), pageIds = new Set();
      for (const room of page.rooms) {
        if (!room || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(room.roomId) || typeof room.title !== "string" || typeof room.purpose !== "string") throw new Error("directory_invalid");
        if (ids.has(room.roomId) || pageIds.has(room.roomId)) continue;
        pageIds.add(room.roomId);
        const row = document.createElement("article"); row.className = "room-discovery-entry";
        const title = document.createElement("h4"); title.textContent = room.title;
        const purpose = document.createElement("p"); purpose.textContent = room.purpose;
        row.append(title, purpose);
        if (onRequestRoom) {
          const request = document.createElement("button"); request.type = "button"; request.className = "text-button";
          request.textContent = uiText("rooms.discovery.joining");
          request.addEventListener("click", () => {
            if (getSession() === session && !session.terms?.required) onRequestRoom(room.roomId, room.title);
          });
          row.append(request);
        }
        fragment.append(row);
      }
      if (page.nextCursor === cursor && cursor !== null) throw new Error("directory_cursor_stalled");
      for (const room of page.rooms) ids.add(room.roomId);
      list.append(fragment); cursor = page.nextCursor; loaded = true;
      status.textContent = ids.size ? "" : uiText(cursor ? "rooms.discovery.emptyPage" : "rooms.discovery.empty");
      more.hidden = !cursor;
    } catch (error) {
      if (version !== generation || getSession() !== session || error.name === "AbortError") return;
      status.textContent = uiText("rooms.discovery.error"); retry.hidden = false;
    } finally { if (controller === abort) controller = null; }
  }
  trigger.addEventListener("click", () => {
    if (!getSession()?.authenticated || getSession().terms?.required) return;
    if (owner && owner !== getSession()) reset();
    panel.hidden = !panel.hidden; trigger.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) {
      $("#room-discovery-title").focus();
      if (!loaded) void load();
    }
  });
  more.addEventListener("click", () => { void load(); });
  retry.addEventListener("click", () => { void load(); });
  return { reset };
}
