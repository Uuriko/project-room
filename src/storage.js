const STORAGE_KEY = "project-room-v0-events";
const CHANNEL_NAME = "project-room-v0";

export function loadEvents(fallback) {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return structuredClone(fallback);
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

export function saveEvents(events) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
}

export function resetEvents(fallback) {
  const next = structuredClone(fallback);
  saveEvents(next);
  return next;
}

export function openRoomChannel(onEvents) {
  if (!("BroadcastChannel" in globalThis)) return { publish() {}, close() {} };
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener("message", ({ data }) => {
    if (data?.type === "events.changed" && Array.isArray(data.events)) onEvents(data.events);
  });
  return {
    publish(events) {
      channel.postMessage({ type: "events.changed", events });
    },
    close() {
      channel.close();
    }
  };
}
