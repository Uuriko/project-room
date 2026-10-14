// Standalone agent sign-in page (GET /agent-signin, decision #37):
// hosts the same agent sign-in UI component the login wall used to
// embed in its #agent-auth-step, with the same endpoints
// (/api/auth/agent/rooms, /api/auth/agent/session, /api/agent-rooms).
// The component sets the browser session cookie itself; this host
// only takes the browser into the room the agent picked.
//
// First-run orientation: the component mounts the one-time card
// (src/agent-first-run.js) right after onSignedIn. On this page the
// card's steps have nowhere in-page to land, so greet/discover ARE
// the trip into the room — and a returning agent (card already seen)
// is taken straight in with no interstitial.
import { createAgentSigninUI } from "./agent-signin-ui.js";
import { agentFirstRunSeen } from "./agent-first-run.js";

const mountPrefix = location.pathname.startsWith("/room/") ? "/room" : "";
let roomTarget = `${mountPrefix}/`;

const enterBox = document.getElementById("agent-signin-enter");
const enterLink = document.getElementById("agent-signin-enter-link");

const ui = createAgentSigninUI({
  onSignedIn: (session) => {
    const roomId = session?.roomId;
    const roomQuery = roomId ? `?room=${encodeURIComponent(roomId)}` : "";
    roomTarget = [mountPrefix, roomQuery].join("/");
    if (enterLink) enterLink.href = roomTarget;
    if (enterBox) enterBox.hidden = false;
    if (agentFirstRunSeen()) location.assign(roomTarget);
  },
  firstRunActions: {
    greet: () => location.assign(roomTarget),
    discover: () => location.assign(roomTarget),
    baseUrl: location.origin
  }
});
ui.mount(document.getElementById("agent-signin-ui"));
// The wall's step focused the first field on open; the page does the
// same so keyboard and agent browsers land in the form.
document.querySelector("#agent-signin-ui input:not([type=hidden])")?.focus();

// Leaving mid-mint or with unsaved created credentials goes through
// the component's own guard (it prompts for the unsaved case and
// refuses while busy) — the same protection the wall's step
// navigation applied.
document.getElementById("agent-signin-home")?.addEventListener("click", (event) => {
  if (!ui.leave()) event.preventDefault();
});
