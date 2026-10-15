import { hasSessionHint } from "./browser-session.js";
import { uiText } from "./strings.js";

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
    const [workspace] = await Promise.all([import("./app.js"), import("./request-access.js")]);
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
