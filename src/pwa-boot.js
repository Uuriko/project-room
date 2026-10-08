// PWA boot (hardwork-mobile-1, wave2-1606-pwa). Two jobs that make the room
// installable as a PWA:
//
//  1. Register /push-sw.js on every page load. Before this, the service
//     worker was only registered when a visitor opted into push
//     notifications (src/human-push.js), so for everyone else the browser
//     never saw a service worker with a fetch handler and never fired
//     beforeinstallprompt: Chrome requires a registered worker with a fetch
//     handler for installability. Re-registering the same script + scope is
//     idempotent and returns the existing registration.
//  2. Mount the install-prompt UI from pwa-install.js. That module was dead
//     code until now: nothing in the app shell imported it, so neither the
//     Android "Install Room" button nor the iOS Share-sheet hint ever
//     appeared.
import { mountPwaInstall } from "./pwa-install.js";

const SW_URL = new URL("../push-sw.js", import.meta.url);
const SW_SCOPE = new URL("./", SW_URL).pathname;

// Fire-and-forget safe: never throws, never blocks boot. A failed or
// unsupported registration just leaves this visit as un-installable as
// before (no beforeinstallprompt), which is the status quo ante.
export async function registerPwaWorker(navigatorRef = globalThis.navigator) {
  try {
    const workers = navigatorRef?.serviceWorker;
    if (!workers || typeof workers.register !== "function") return null;
    return await workers.register(SW_URL.href, { scope: SW_SCOPE });
  } catch {
    return null;
  }
}

export function isStandaloneDisplay(matchMediaRef = globalThis.matchMedia) {
  try {
    return Boolean(matchMediaRef?.("(display-mode: standalone)").matches);
  } catch {
    return false;
  }
}

// Mounts the "Install Room" button / iOS Share-sheet hint into `account`.
// Returns the pwa-install handle ({ markFirstValue, button, sheet }) or
// null when there is no account container. `mount` is injectable for tests.
export function mountInstallPrompt({ account, mount = mountPwaInstall, storage, now, userAgent, standalone } = {}) {
  if (!account || typeof account.append !== "function") return null;
  return mount({
    account,
    storage: storage ?? globalThis.localStorage,
    now: now ?? (() => Date.now()),
    userAgent: userAgent ?? globalThis.navigator?.userAgent ?? "",
    standalone: standalone ?? isStandaloneDisplay(),
    firstValue: false,
  });
}
