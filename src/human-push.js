// One button. It asks the browser for notification permission and subscribes
// this device to mentions and direct messages. There is no level picker and
// no quiet-hours control.

const BUTTON_LABEL = "Notify me of mentions and DMs";

function urlBase64ToUint8Array(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function subscribe(client, publicKey) {
  const registration = await navigator.serviceWorker.register("/push-sw.js", { type: "module", scope: "/" });
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
  const json = typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;
  await client.saveHumanPush({
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth }
  });
}

export function installHumanPush({ client, button, note, eligible }) {
  let serial = 0;
  let resolvedFor = null;

  const hide = () => {
    button.hidden = true;
    button.disabled = false;
    note.hidden = true;
    note.textContent = "";
  };
  const showNote = text => {
    button.hidden = true;
    note.hidden = false;
    note.textContent = text;
  };
  const showButton = () => {
    button.hidden = false;
    button.disabled = false;
    button.textContent = BUTTON_LABEL;
    note.hidden = true;
    note.textContent = "";
  };

  function reset() {
    serial += 1;
    resolvedFor = null;
    hide();
  }

  async function refresh() {
    const ticket = ++serial;
    try {
      if (!eligible()) { hide(); return; }
      const sessionKey = client.session?.member?.id ?? "";
      if (resolvedFor === sessionKey) return;
      const config = await client.humanPushConfig();
      if (ticket !== serial || !eligible()) return;
      resolvedFor = sessionKey;
      if (!config?.configured || typeof config.publicKey !== "string") { hide(); return; }
      const permission = globalThis.Notification?.permission;
      if (permission === "denied") { showNote("Notifications are blocked in this browser."); return; }
      if (permission === "granted") {
        await subscribe(client, config.publicKey);
        if (ticket !== serial) return;
        showNote("Mentions and DMs are on for this browser.");
        return;
      }
      showButton();
    } catch {
      if (ticket === serial) showNote("This browser could not turn on notifications.");
    }
  }

  button.addEventListener("click", async () => {
    const ticket = serial;
    button.disabled = true;
    try {
      const config = await client.humanPushConfig();
      if (ticket !== serial || !eligible()) return;
      if (!config?.configured || typeof config.publicKey !== "string") { hide(); return; }
      const permission = await Notification.requestPermission();
      if (ticket !== serial) return;
      if (permission !== "granted") { showNote("Notifications are blocked in this browser."); return; }
      await subscribe(client, config.publicKey);
      if (ticket !== serial) return;
      resolvedFor = client.session?.member?.id ?? "";
      showNote("Mentions and DMs are on for this browser.");
    } catch {
      if (ticket === serial) showNote("This browser could not turn on notifications.");
    }
  });

  return { refresh, reset };
}
