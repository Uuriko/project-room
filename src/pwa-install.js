// Install helper (HB-3a). S1's shell mounts this. It is not wired into the
// app shell yet. "Install Room" appears after the browser fires
// beforeinstallprompt and after the first moment of value. iOS Safari, which
// has no install prompt, gets a Share-sheet instruction at most once every
// 14 days, and only after that same moment. Nothing here runs on import.

export const INSTALL_DISMISS_KEY = "room.pwa.install.dismissedAt";
export const INSTALL_RECORD_KEY = "room.pwa.installed";
const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;

export function isIosSafari(userAgent) {
  const ua = String(userAgent || "");
  const ios = /iPad|iPhone|iPod/.test(ua);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return ios && safari;
}

// When the install control may show. firstValue is the receipt / first close
// ACT-1a records. Without it the control stays hidden.
export function installDecision({ now, firstValue = false, ios = false, standalone = false, dismissedAt = null, prompted = false } = {}) {
  if (standalone) return { showButton: false, showIosSheet: false };
  if (!firstValue) return { showButton: false, showIosSheet: false };
  const dismissedFresh = typeof dismissedAt === "number" && now - dismissedAt < FORTNIGHT_MS && now >= dismissedAt;
  if (ios) return { showButton: false, showIosSheet: !dismissedFresh };
  return { showButton: prompted === true, showIosSheet: false };
}

export function noteInstalled({ platform, source, storage, now }) {
  const record = { name: "pwa_installed", platform, source, at: now };
  try { storage?.setItem(INSTALL_RECORD_KEY, JSON.stringify(record)); } catch { /* private mode */ }
  return record;
}

function readNumber(storage, key) {
  try {
    const value = Number(storage?.getItem(key));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function mountPwaInstall({
  account,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  userAgent = globalThis.navigator?.userAgent ?? "",
  standalone = false,
  firstValue = false
} = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "install-room-button";
  button.textContent = "Install Room";
  button.hidden = true;
  const sheet = document.createElement("div");
  sheet.id = "ios-install-sheet";
  sheet.hidden = true;
  const copy = document.createElement("p");
  copy.textContent = "Add Room to your Home Screen. Open the Share menu, then choose Add to Home Screen.";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Not now";
  sheet.append(copy, dismiss);
  account?.append(button, sheet);

  let prompted = false;
  let captured = null;
  let value = firstValue === true;
  const ios = isIosSafari(userAgent);

  const refresh = () => {
    const decision = installDecision({
      now: now(), firstValue: value, ios, standalone,
      dismissedAt: readNumber(storage, INSTALL_DISMISS_KEY), prompted
    });
    button.hidden = !decision.showButton;
    sheet.hidden = !decision.showIosSheet;
  };

  const onPrompt = event => {
    if (typeof event?.preventDefault === "function") event.preventDefault();
    captured = event;
    prompted = true;
    refresh();
  };
  const onInstalled = () => {
    noteInstalled({ platform: ios ? "ios" : "desktop", source: "appinstalled", storage, now: now() });
    button.hidden = true;
    sheet.hidden = true;
    prompted = false;
  };
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  button.addEventListener("click", () => { if (captured && typeof captured.prompt === "function") void captured.prompt(); });
  dismiss.addEventListener("click", () => {
    try { storage?.setItem(INSTALL_DISMISS_KEY, String(now())); } catch { /* private mode */ }
    sheet.hidden = true;
  });

  if (standalone && new URL(window.location.href).searchParams.get("source") === "pwa") {
    noteInstalled({ platform: ios ? "ios" : "desktop", source: "pwa", storage, now: now() });
  }
  refresh();
  return {
    markFirstValue() { value = true; refresh(); },
    button,
    sheet
  };
}
