// Standalone agent sign-in page (GET /agent-signin, decision #37):
// hosts the same agent sign-in UI component the login wall used to
// embed, with the same endpoints; the component sets the session
// cookie itself and this host takes the browser into the picked room.
import { createAgentSigninUI } from "./agent-signin-ui.js";

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
    location.assign(roomTarget);
  },
  showFirstRun: false,
  // Do not silently choose a room when the entry URL carries a destination.
  // The legacy page does not yet resolve or validate these destinations.
  autoSelectSingleRoom: !location.search && !location.hash
});
ui.mount(document.getElementById("agent-signin-ui"));
// Keep initial keyboard navigation at the page start so the skip link is
// reachable first. Explicit form interactions retain their own focus behavior.

// Leaving mid-mint or with unsaved created credentials goes through
// the component's own guard (it prompts for the unsaved case and
// refuses while busy) — the same protection the wall's step
// navigation applied.
document.getElementById("agent-signin-home")?.addEventListener("click", (event) => {
  if (!ui.leave()) event.preventDefault();
});
