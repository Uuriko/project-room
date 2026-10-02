// Contextual push permission (HB-3a). The question appears the first time an
// agent's needs-you item is shown, inside that surface. Importing this module
// does not ask. "Not now" waits 7 days. On iOS the ask waits until the app is
// installed (standalone); the install sheet comes first.

export const PUSH_ASK_KEY = "room.push.ask.dismissedAt";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const PUSH_ASK_COPY = "Get a tap on your phone when an agent needs you?";

export function pushAskDecision({ now, needsMe = false, permission = "default", ios = false, standalone = false, dismissedAt = null } = {}) {
  if (needsMe !== true) return { show: false };
  if (permission === "granted" || permission === "denied") return { show: false };
  if (ios && !standalone) return { show: false };
  if (typeof dismissedAt === "number" && now >= dismissedAt && now - dismissedAt < WEEK_MS) return { show: false };
  return { show: true };
}

function readNumber(storage, key) {
  try {
    const value = Number(storage?.getItem(key));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function mountPushAsk({
  dock,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  ios = false,
  standalone = false,
  permission = () => globalThis.Notification?.permission ?? "default",
  requestPermission = () => globalThis.Notification?.requestPermission?.() ?? Promise.resolve("default"),
  subscribe = null
} = {}) {
  const root = document.createElement("div");
  root.id = "push-soft-ask";
  root.hidden = true;
  const copy = document.createElement("p");
  copy.textContent = PUSH_ASK_COPY;
  const turnOn = document.createElement("button");
  turnOn.type = "button";
  turnOn.textContent = "Turn on";
  const notNow = document.createElement("button");
  notNow.type = "button";
  notNow.textContent = "Not now";
  root.append(copy, turnOn, notNow);
  dock?.append(root);

  const apply = item => {
    const decision = pushAskDecision({
      now: now(),
      needsMe: item?.needsMe === true,
      permission: typeof permission === "function" ? permission() : permission,
      ios, standalone,
      dismissedAt: readNumber(storage, PUSH_ASK_KEY)
    });
    root.hidden = !decision.show;
    return decision;
  };

  turnOn.addEventListener("click", async () => {
    const result = await requestPermission();
    if (result === "granted" && typeof subscribe === "function") await subscribe();
    root.hidden = true;
  });
  notNow.addEventListener("click", () => {
    try { storage.setItem(PUSH_ASK_KEY, String(now())); } catch { /* private mode */ }
    root.hidden = true;
  });

  return { showFor: apply, root };
}
