import { hasSessionHint } from "./browser-session.js";
import { uiText } from "./strings.js";
import { clipboard } from "./clipboard.js";
// Static imports must finish before the readable fallback yields to startup.
import "./entry-started.js";

const agentPrompt = document.getElementById("entry-agent-prompt");
const agentCopy = document.getElementById("entry-agent-copy");
const agentCopyStatus = document.getElementById("entry-agent-copy-status");
if (agentPrompt && agentCopy && agentCopyStatus) {
  // A pasted prompt must return to the installation the person actually opened.
  if (location.protocol === "https:" || location.protocol === "http:") {
    agentPrompt.value = agentPrompt.value.replaceAll("https://room.trydemigod.com", location.origin);
  }
  clipboard.subscribe(() => { agentCopy.disabled = clipboard.busy; });
  agentCopy.addEventListener("click", async () => {
    if (clipboard.busy) return;
    const result = await clipboard.copy(agentPrompt.value);
    agentCopy.textContent = result === "copied" ? "Copied" : "Copy";
    agentCopyStatus.textContent = result === "copied" ? "Copied." : result === "pending" ? "Copy is still in progress." : "Select and copy the text.";
    agentCopyStatus.classList.toggle("sr-only", result === "copied");
    agentCopyStatus.classList.add("visible");
    if (result === "failed") { agentPrompt.focus(); agentPrompt.select(); }
  });
}

let flight = null, dispose = () => {};
const resumeKey = "project-room:signin-entry:v1";
async function openWorkspace(options) {
  if (flight) return flight;
  if (options?.signedIn) {
    try { sessionStorage.setItem(resumeKey, options.accountClient.session.account.id); } catch { /* The current document still owns its continuation. */ }
  }
  flight = (async () => {
    let accountId;
    try { accountId = sessionStorage.getItem(resumeKey); } catch { /* Storage may be disabled. */ }
    if (!options && accountId && !location.search && !location.hash) {
      const { AccountClient } = await import("./account-client.js");
      const accountClient = new AccountClient();
      const session = await accountClient.restore();
      if (session?.authenticated && session.account.id === accountId) options = { accountClient, signedIn: true };
    }
    // The callback has finished setting its Strict cookie. Start the small
    // account restore alongside the workspace download, not after the entire
    // application module graph. Reuse this client to avoid a duplicate read.
    const googleReturn = !options && new URLSearchParams(location.search).get("google") === "signed-in";
    const accountFlight = googleReturn ? import("./account-client.js").then(async ({ AccountClient }) => {
      const accountClient = new AccountClient();
      await accountClient.restore();
      return accountClient;
    }) : Promise.resolve(null);
    const [workspace, , restoredAccount] = await Promise.all([import("./app.js"), import("./request-access.js"), accountFlight]);
    if (restoredAccount) options = { accountClient: restoredAccount };
    dispose();
    await workspace.startApp(options);
    try { sessionStorage.removeItem(resumeKey); } catch { /* No stored continuation. */ }
  })().catch(() => {
    flight = null;
    showLoadFailure();
    throw new Error(uiText("entry.loadFailed"));
  });
  return flight;
}

function showLoadFailure() {
  document.querySelector("#static-hero")?.remove();
  const status = document.querySelector("#auth-error");
  status.textContent = uiText("entry.loadFailed");
  status.classList.add("error", "visible");
  document.querySelector("#auth-panel").hidden = false;
  let retry = document.querySelector("#entry-retry");
  if (!retry) {
    retry = document.createElement("button");
    retry.id = "entry-retry"; retry.type = "button"; retry.className = "button secondary";
    retry.textContent = uiText("entry.retry");
    retry.addEventListener("click", () => location.reload());
    status.after(retry);
  }
}

function needsWorkspace() {
  if (location.search || location.hash || hasSessionHint()) return true;
  try {
    return ["pr-pending-invite", "pr-pending-join", "project-room:oauth-return:v1", resumeKey]
      .some(key => sessionStorage.getItem(key));
  } catch { return false; }
}

// Register the push service worker on ordinary app load (R-25: the
// push-only gating was unintended). Until now the sole registration lived
// inside subscribe() in human-push.js, so a visitor who never entered the
// push flow got no worker: no offline shell and no worker-managed upgrade
// path. Registration alone never prompts and never subscribes — push
// subscription still happens only in human-push.js, after the browser
// permission grant in its existing user-gesture flow. Registering the same
// script URL and scope again there returns the same registration.
// Registration failure (unsupported browser, blocked worker) must never
// break app load, so it is fire-and-forget with the rejection swallowed.
// Automated browsers (navigator.webdriver, e.g. the Playwright browser
// checks) skip it: a worker that answers fetches takes requests out of the
// page.route() interception those checks depend on, which silently broke
// ~60 browser checks (held, late and failed responses never applied).
if ("serviceWorker" in navigator && !navigator.webdriver) {
  const worker = new URL("../push-sw.js", import.meta.url);
  void navigator.serviceWorker.register(worker.href, { scope: new URL("./", worker).pathname }).catch(() => {});
}

// Complex entry journeys keep their existing ownership and restoration order.
if (needsWorkspace()) {
  void openWorkspace().catch(() => {});
} else {
  try {
    const { mountSigninEntry } = await import("./signin-entry.js");
    // A same-document invitation can arrive while the entry module downloads.
    if (needsWorkspace()) void openWorkspace().catch(() => {});
    else dispose = mountSigninEntry({ openWorkspace });
  } catch { showLoadFailure(); }
}
