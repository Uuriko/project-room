// One button plus two preference switches. It asks the browser for
// notification permission and subscribes this device; the checkboxes choose
// which event kinds (mentions, direct messages) may wake it. Preferences are
// stored per member per room on the server and enforced before any send.

const BUTTON_LABEL = "Notify me of mentions and DMs";

function urlBase64ToUint8Array(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
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
  if (!saved?.saved) throw new Error("Subscription was not saved for this session");
  return true;
}

export function installHumanPush({ client, button, note, eligible, prefs = null }) {
  let serial = 0;
  let resolvedFor = null;
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
    if (current.mention && current.dm) return "Mentions and DMs are on for this browser.";
    if (current.mention) return "Mentions are on for this browser; DMs are off.";
    if (current.dm) return "DMs are on for this browser; mentions are off.";
    return "Push is off for this browser — nothing here will notify you.";
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
        const saved = await subscribe(client, config.publicKey, () => ticket === serial && eligible());
        if (!saved || ticket !== serial || !eligible()) return;
        showPrefs(config.preferences);
        showNote(subscribedNote(config.preferences));
        return;
      }
      showButton();
      showPrefs(config.preferences);
    } catch {
      if (ticket === serial) showNote("This browser could not turn on notifications.");
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
      if (!result?.preferences) throw new Error("Preferences were not saved");
      showPrefs(result.preferences);
      if (!button.hidden) return; // not subscribed yet: the checkboxes are the state
      showNote(subscribedNote(result.preferences));
    } catch {
      if (ticket === serial) {
        showPrefs(lastPrefs); // revert: show the last saved settings, keep the human's intent honest
        flashNote("Preferences could not be saved.");
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
      if (permission !== "granted") { showNote("Notifications are blocked in this browser."); return; }
      const saved = await subscribe(client, config.publicKey, () => ticket === serial && eligible());
      if (!saved || ticket !== serial || !eligible()) return;
      resolvedFor = client.session?.member?.id ?? "";
      showPrefs(config.preferences);
      showNote(subscribedNote(config.preferences));
    } catch {
      if (ticket === serial) showNote("This browser could not turn on notifications.");
    }
  });

  return { refresh, reset };
}
