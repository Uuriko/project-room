// Service worker registration for every visitor (PRODUCT-200 M-06, PWA
// behavior). The offline navigation fallback in push-sw.js only exists while
// a worker controls the page. Push opt-in (src/human-push.js) registers the
// same script, but visitors who never enabled push got the browser's dead
// network-error page instead of /offline.html. Registration is idempotent —
// re-registering an identical script and scope is a no-op — and any failure
// is swallowed so a registration error can never break app boot.
export async function registerPwaWorker({
  worker = "/push-sw.js",
  scope = "/",
  navigator: nav = globalThis.navigator
} = {}) {
  if (typeof nav !== "object" || nav === null || !("serviceWorker" in nav)) {
    return { registered: false, reason: "unsupported" };
  }
  try {
    const registration = await nav.serviceWorker.register(worker, { scope });
    return { registered: true, scope: registration?.scope ?? scope };
  } catch {
    return { registered: false, reason: "failed" };
  }
}
