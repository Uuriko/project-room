import { uiText } from './strings.js';
// One button plus two preference switches. It asks the browser for
// notification permission and subscribes this device; the checkboxes choose
// which event kinds (mentions, direct messages) may wake it. Preferences are
// stored per member per room on the server and enforced before any send.

const BUTTON_LABEL = uiText("push.copy.001");

function urlBase64ToUint8Array(value) {
  const padded = ["", value, "", "=".repeat((4 - (value.length % 4)) % 4), ""].join('').replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function subscribe(client, publicKey, current) {
  const worker = new URL("../push-sw.js", import.meta.url);
  // Classic script. iOS 16.4–18.3 home-screen workers reject { type: "module" }.
  const registration = await navigator.serviceWorker.register(worker.href, { scope: new URL("./", worker).pathname });
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });
  const json = typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;
  if (!current()) return false;
  const saved = await client.saveHumanPush({
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth }
  });
  if (!saved?.saved) throw new Error(uiText("push.copy.002"));
  return true;
}

export function installHumanPush({ client, button, note, eligible, prefs = null }) {
  let serial = 0;
  let resolvedFor = null;
  let subscribed = false;
  let lastPrefs = { mention: true, dm: true };
  const prefBox = prefs?.box ?? null;
  const prefMention = prefs?.mention ?? null;
  const prefDm = prefs?.dm ?? null;

  const hide = () => {
    button.hidden = true;
    button.disabled = false;
    note.hidden = true;
    note.textContent = "";
    if (prefBox) prefBox.hidden = true;
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
  const prefsFrom = values => ({
    mention: values?.mention !== false,
    dm: values?.dm !== false
  });
  const showPrefs = values => {
    if (!prefBox || !prefMention || !prefDm) return;
    const current = prefsFrom(values);
    lastPrefs = current;
    prefMention.checked = current.mention;
    prefDm.checked = current.dm;
    prefMention.disabled = false;
    prefDm.disabled = false;
    prefBox.hidden = false;
  };
  const flashNote = text => {
    // A transient message that does not disturb the button/prefs controls.
    note.hidden = false;
    note.textContent = text;
  };
  const subscribedNote = values => {
    const current = prefsFrom(values);
    if (current.mention && current.dm) return uiText("push.copy.003");
    if (current.mention) return uiText("push.copy.004");
    if (current.dm) return uiText("push.copy.005");
    return uiText("push.copy.006");
  };

  function reset() {
    serial += 1;
    resolvedFor = null;
    subscribed = false;
    hide();
  }

  async function refresh() {
    if (eligible() && resolvedFor === (client.session?.member?.id ?? "")) return;
    const ticket = ++serial;
    try {
      if (!eligible()) { hide(); return; }
      const sessionKey = client.session?.member?.id ?? "";
      if (resolvedFor === sessionKey) return;
      const config = await client.humanPushConfig();
      if (ticket !== serial || !eligible()) return;
      resolvedFor = sessionKey;
      showPrefs(config.preferences);
      if (!config?.configured || typeof config.publicKey !== "string") { showNote(uiText("push.copy.007")); return; }
      if (!globalThis.Notification || !navigator.serviceWorker) { showNote(uiText("push.copy.008")); return; }
      const permission = globalThis.Notification?.permission;
      if (permission === "denied") { showNote(uiText("push.copy.009")); return; }
      if (permission === "granted") {
        const saved = await subscribe(client, config.publicKey, () => ticket === serial && eligible());
        if (!saved || ticket !== serial || !eligible()) return;
        subscribed = true;
        showPrefs(config.preferences);
        showNote(subscribedNote(config.preferences));
        return;
      }
      showButton();
      showPrefs(config.preferences);
    } catch {
      if (ticket === serial) showNote(uiText("push.copy.010"));
    }
  }

  async function savePrefs() {
    if (!prefMention || !prefDm || !eligible()) return;
    const ticket = ++serial;
    prefMention.disabled = true;
    prefDm.disabled = true;
    const values = { mention: prefMention.checked, dm: prefDm.checked };
    try {
      const result = await client.saveHumanPushPreferences(values);
      if (ticket !== serial || !eligible()) return;
      if (!result?.preferences) throw new Error(uiText("push.copy.011"));
      showPrefs(result.preferences);
      if (!subscribed) { flashNote(uiText("push.copy.012")); return; } // // not subscribed yet: the checkboxes are the state
      showNote(subscribedNote(result.preferences));
    } catch {
      if (ticket === serial) {
        showPrefs(lastPrefs); // revert: show the last saved settings, keep the human's intent honest
        flashNote(uiText("push.copy.013"));
      }
    } finally {
      if (ticket === serial) { prefMention.disabled = false; prefDm.disabled = false; }
    }
  }

  if (prefMention) prefMention.addEventListener("change", savePrefs);
  if (prefDm) prefDm.addEventListener("change", savePrefs);

  button.addEventListener("click", async () => {
    const ticket = serial;
    button.disabled = true;
    try {
      const config = await client.humanPushConfig();
      if (ticket !== serial || !eligible()) return;
      if (!config?.configured || typeof config.publicKey !== "string") { hide(); return; }
      const permission = await Notification.requestPermission();
      if (ticket !== serial) return;
      if (permission !== "granted") { showNote(uiText("push.copy.014")); return; }
      const saved = await subscribe(client, config.publicKey, () => ticket === serial && eligible());
      if (!saved || ticket !== serial || !eligible()) return;
      resolvedFor = client.session?.member?.id ?? "";
      subscribed = true;
      showPrefs(config.preferences);
      showNote(subscribedNote(config.preferences));
    } catch {
      if (ticket === serial) showNote(uiText("push.copy.015"));
    }
  });

  return { refresh, reset };
}
