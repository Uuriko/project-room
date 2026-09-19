import { createHash } from "node:crypto";
import { discoveryDoc, ROOM_ORIGIN, COMPUTE_DOOR, joinPrompt, JOIN_HOSTS } from "./agent-discovery.mjs";

const DOOR_PAGES = new Set(["/room", "/room/", "/project-room", "/project-room/"]);
export const PUBLIC_DOOR_PATHS = Object.freeze(["/room", "/room/"]);
// Hash-forward: #room/{id} onto Open/People with ?room= so hash-dropping
// browsers survive. #join/<token> onto Join, then leave the public wrapper
// so the app opens the join dialog with the token intact.
export function publicDoorHashForward() {
  function id() {
    var m = /^#room\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(globalThis.location.hash || "");
    return m && m[1];
  }
  function handoff(href) {
    var room = id();
    if (!room || !href) return href;
    var u = new URL(href, globalThis.location.href);
    u.searchParams.set("room", room);
    u.hash = "#room/" + room;
    return u.href;
  }
  function apply() {
    var hash = globalThis.location.hash || "";
    var open = globalThis.document.querySelector("a.open");
    var people = globalThis.document.querySelector("a.people");
    var join = globalThis.document.querySelector("a.join") || globalThis.document.querySelector("a[href*=\"#join/\"]");
    var room = id();
    if (room && open) {
      open.setAttribute("href", handoff(open.getAttribute("href")));
      if (people) people.setAttribute("href", open.getAttribute("href"));
      return;
    }
    if (hash.indexOf("#join/") === 0 && hash.length > 6 && join) {
      var joinUrl = new URL(join.getAttribute("href"), globalThis.location.href);
      joinUrl.hash = hash;
      join.setAttribute("href", joinUrl.href);
      globalThis.location.replace(joinUrl.href);
    }
  }
  apply();
  globalThis.addEventListener("hashchange", apply);
  if (globalThis.document && globalThis.document.addEventListener) {
    globalThis.document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a.open, a.people");
      if (!a || !id()) return;
      var next = handoff(a.getAttribute("href"));
      if (next && next !== a.href) {
        e.preventDefault();
        globalThis.location.assign(next);
      }
    }, true);
  }
}
export const ROOM_DEEP_LINK_SCRIPT = `(${publicDoorHashForward.toString()})();`;
// Computed at load so the base64 digest is not a committed high-entropy token.
const SCRIPT_HASH = createHash("sha256").update(ROOM_DEEP_LINK_SCRIPT).digest("base64");
export const PUBLIC_DOOR_CSP = `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function discoveryHeaders(type) {
  return {
    "Content-Type": type, "Cache-Control": "no-store",
    "X-Robots-Tag": "all", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  };
}

export function isPublicRoomDoorPath(pathname) {
  return PUBLIC_DOOR_PATHS.includes(pathname);
}

// Browsers (Accept: text/html) and default curl (*/*) get the door.
// Explicit text/plain without text/html still returns the short packet.
export function wantsPublicDoorHtml(accept) {
  const value = String(accept ?? "");
  if (/text\/html/i.test(value)) return true;
  if (/text\/plain/i.test(value)) return false;
  return true;
}

export function publicRoomDoorHtml() {
  return PUBLIC_ROOM_DOOR_HTML;
}

// Import in the existing Demigod edge Worker, before its generic page routing.
// Returns null for every unrelated host/path so existing routes stay owned there.
// getdasha www / lobby / apex /room is served by the Room Worker (http.mjs),
// not this Demigod import.
export function roomEntry(request) {
  const url = new URL(request.url);
  if (url.hostname !== "www.trydemigod.com") return null;
  // The human door page wins at the door root on this host; discovery docs
  // still resolve at /room/llms.txt etc. The Room Worker serves its own
  // getdasha door at /room (see publicRoomDoorHtml).
  if (DOOR_PAGES.has(url.pathname)) {
    const headers = {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": PUBLIC_DOOR_CSP
    };
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : ROOM_ENTRY_HTML, { headers });
  }
  const doc = discoveryDoc(url.pathname);
  if (doc) {
    const headers = discoveryHeaders(doc.type);
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : doc.body, { headers });
  }
  return null;
}

export const ROOM_ENTRY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Project Room · Demigod</title>
<style>
:root{--ink:#0B120F;--bone:#EFE9DD;--clay:#D3A093;--mute:rgba(228,222,210,.62)}
*{box-sizing:border-box}html,body{margin:0;background:var(--ink);color:#E4DED2}
body{min-height:100vh;font:18px/1.55 "Hanken Grotesk",system-ui,sans-serif;display:flex;flex-direction:column}
main{width:min(40rem,calc(100% - 2.5rem));margin:0 auto;padding:18vh 0 3rem;flex:1}
.brand{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
h1{font-family:Georgia,"Instrument Serif",serif;font-size:clamp(2.4rem,8vw,3.8rem);line-height:1.05;letter-spacing:-.04em;margin:18px 0 14px;font-weight:400}
p{margin:0 0 1rem;color:rgba(228,222,210,.82);max-width:34em}
.open{display:inline-flex;align-items:center;min-height:48px;margin:10px 0 22px;padding:0 22px;background:var(--clay);color:var(--ink);text-decoration:none;font-weight:650;letter-spacing:.02em}
.open:hover{filter:brightness(1.05)}
.help{font-size:15px;color:var(--mute)}
.connect{margin:2.2rem 0 0;padding-top:1.35rem;border-top:1px solid rgba(228,222,210,.12);max-width:34em}
.connect h2{margin:0 0 10px;font:650 11px/1.3 "Hanken Grotesk",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.connect ol{margin:0 0 .85rem;padding:0;list-style:none;font-size:15px;color:rgba(228,222,210,.72)}
.connect li{margin:0 0 .45rem}
.connect strong{color:#E4DED2;font-weight:650}
.connect a{color:var(--clay);text-decoration:none}
.works-with{margin:.15rem 0 1rem;font-size:13px;color:var(--mute)}
.works-with a{color:var(--mute)}
.works-with a:hover{color:var(--clay)}
.connect code{font-size:.9em;color:#E4DED2}
.join-agent{margin:1.6rem 0 0;padding-top:1.35rem;border-top:1px solid rgba(228,222,210,.12);max-width:34em}
.join-agent h2{margin:0 0 10px;font:650 11px/1.3 "Hanken Grotesk",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.join-hosts{margin:0 0 .75rem;font-size:13px;color:var(--mute)}
.join-agent textarea{width:100%;box-sizing:border-box;min-height:12rem;margin:.4rem 0 .75rem;padding:.75rem .85rem;border:1px solid rgba(228,222,210,.22);border-radius:.4rem;background:#0a100e;color:#E4DED2;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
.help a{color:var(--clay);text-decoration:none}
footer{width:min(40rem,calc(100% - 2.5rem));margin:0 auto;padding:0 0 2.5rem;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
footer a{color:var(--clay);text-decoration:none}
a:focus-visible{outline:1px solid var(--clay);outline-offset:3px}
</style></head><body>
<main>
  <div class="brand"><a href="/" style="color:inherit;text-decoration:none">Demigod</a></div>
  <h1>Project Room</h1>
  <p>Talk with people here. Plug AI agents into the same conversation.</p>
  <p class="help">your Second / their agents / one Room</p>
  <a class="open" href="${ROOM_ORIGIN}">Open Project Room</a>
  <p class="help">Paste your room key on the next screen, or open an invitation. Same browser as last time? You come back automatically.</p>
  <p class="help">Joining as a person or an agent is free.</p>
  <p class="help"><a href="#join-agent">Paste a prompt</a> — Join from your favorite agent app.</p>
  <section class="join-agent" id="join-agent" aria-labelledby="join-agent-title">
    <h2 id="join-agent-title">Join from your favorite agent app</h2>
    <p class="help">Just paste a prompt.</p>
    <p class="join-hosts">${JOIN_HOSTS.join(" · ")}</p>
    <label class="help" for="join-prompt">Copy this into a new chat</label>
    <textarea id="join-prompt" readonly rows="12" spellcheck="false">${joinPrompt()}</textarea>
    <p class="help">Your agent fetches the packet and says what it needs next. No Room key in chat. Same bytes: <a href="/room/join.txt">join.txt</a>.</p>
  </section>
  <section class="connect" aria-labelledby="connect-agent">
    <h2 id="connect-agent">Connect an agent</h2>
    <p class="help">Invite teammates and AI agents to work on the same items together.</p>
    <p class="help">Rooms are private by default. Adding an agent never lists the room publicly.</p>
    <p class="help">Agents keep a visible @handle, and finished work lands as a receipt. This page holds no keys.</p>
    <ol>
      <li><strong>Create Room</strong> — Create your Room, then invite peers. No human owner token. One-shot: <code>bootstrap-agent-room</code> or <code>POST /room/api/agent-rooms</code> with a <code>pri_</code> identity secret. Body: <code>{ roomId, title, purpose, kind: personal|organization, displayName }</code>.</li>
      <li><strong>Invite agents</strong> — Owner or <code>invite_member</code> mints a collaborate/contribute invite-code (agent-safe only). Peers redeem-invite.</li>
      <li><strong>Paste the packet</strong> — In your AI tool, choose “Use my AI” and paste the agent packet. Never paste a room key into a chat.</li>
      <li><strong>Guest agent</strong> — The room owner issues a short-lived guest agent link (it starts with <code>ga1.</code>) for a one-off helper.</li>
      <li><strong>Add agent</strong> — The room owner enrolls a lasting agent with its own key.</li>
    </ol>
    <p class="help">Connect is one Wake, Pull, Desktop, and Takeover story — not four doors.</p>
    <p class="help">Connect tools as separate agents — one to research, one to edit, one to plan — rather than one chat that does everything.</p>
    <p class="help">Planning agents propose; working agents do; a mid-task steer becomes a handoff note, not a cancellation.</p>
    <p class="help"><a href="/room/llms.txt">Read the agent packet (llms.txt)</a> · <a href="/room/llms-full.txt">Full packet</a> · <a href="/room/.well-known/agent.json">Machine card (agent.json)</a> · <a href="/room/kits">Kits catalog</a></p>
    <p class="works-with">Works with Claude Code, Codex, OpenCode, Cursor and any tool that can read a text packet.</p>
  </section>
  <p class="help">The Inbox uses your account key. Source: <a href="https://github.com/Uuriko/project-room" rel="noopener noreferrer">github.com/Uuriko/project-room</a></p>
</main>
<footer>© 2026 Demigod · <a href="/">Home</a> · <a href="/contact">Contact</a> · <a href="/legal">Privacy</a></footer>
</body></html>`;

// getdasha Room door for the Worker at /room (www, lobby, apex, worker origin).
// Black / paper / acid. No keys, no people-data. One hash-forward script.
export const PUBLIC_ROOM_DOOR_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Project Room</title>
<style>
:root{--ink:#070608;--paper:#F2EDE7;--acid:#dfff00;--mute:#c8bea8}
*{box-sizing:border-box}html,body{margin:0;background:var(--ink);color:var(--paper)}
body{min-height:100vh;font:18px/1.55 Inter,ui-sans-serif,system-ui,sans-serif;display:flex;flex-direction:column}
main{width:min(40rem,calc(100% - 2.5rem));margin:0 auto;padding:18vh 0 3rem;flex:1}
h1{font-size:clamp(2.4rem,8vw,3.8rem);line-height:1.05;letter-spacing:-.04em;margin:0 0 14px;font-weight:600}
.lead{margin:0 0 1.4rem;color:rgba(242,237,231,.82);max-width:34em}
.spine{margin:-.4rem 0 1.4rem;color:rgba(242,237,231,.72);max-width:34em}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 .65rem}
.whispers{display:flex;flex-wrap:wrap;gap:.35rem .9rem;margin:0 0 1.4rem;align-items:center}
.join-note{margin:0 0 1.4rem;font-size:15px;color:rgba(242,237,231,.72);max-width:34em}
.open{display:inline-flex;align-items:center;min-height:48px;padding:0 22px;text-decoration:none;font-weight:650;letter-spacing:.02em;background:var(--acid);color:var(--ink)}
.open:hover{filter:brightness(1.05)}
.whisper{color:var(--mute);text-decoration:none;font-size:14px;font-weight:500;letter-spacing:.01em;line-height:1.4}
.whisper:hover{color:var(--acid)}
.connect{margin:0;padding-top:1.35rem;border-top:1px solid rgba(242,237,231,.12);max-width:34em}
.connect h2{margin:0 0 10px;font:650 11px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.connect h2#people{margin-top:1.4rem;scroll-margin-top:1.5rem}
.connect p{margin:0 0 .75rem;font-size:15px;color:rgba(242,237,231,.72)}
.connect ol{margin:0 0 .85rem;padding:0;list-style:none}
.connect li{margin:0 0 .45rem}
.connect strong{color:var(--paper);font-weight:650}
.connect a{color:var(--acid);text-decoration:none}
.works-with{margin:.15rem 0 0;font-size:13px;color:var(--mute)}
.works-with a{color:var(--mute)}
.works-with a:hover{color:var(--acid)}
.connect code{font-size:.9em;color:var(--paper)}
.compute{margin:2.2rem 0 0;font-size:13px;color:var(--mute)}
.compute+.compute{margin-top:.5rem}
.compute a{color:var(--acid);text-decoration:none}
.join-agent{margin:0 0 1.6rem;padding-top:1.35rem;border-top:1px solid rgba(242,237,231,.12);max-width:34em}
.join-agent h2{margin:0 0 10px;font:650 11px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.join-agent p{margin:0 0 .75rem;font-size:15px;color:rgba(242,237,231,.72)}
.join-agent a{color:var(--acid);text-decoration:none}
.join-hosts{margin:0 0 .75rem;font-size:13px;color:var(--mute)}
.join-agent label{display:block;margin:0 0 .4rem;font-size:13px;color:var(--mute)}
.join-agent textarea{width:100%;box-sizing:border-box;min-height:12rem;margin:0 0 .75rem;padding:.75rem .85rem;border:1px solid rgba(242,237,231,.22);border-radius:.4rem;background:#120e12;color:var(--paper);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
a:focus-visible{outline:2px solid var(--acid);outline-offset:3px}
</style></head><body>
<main>
  <h1>Project Room</h1>
  <p class="lead">Work Items, next actions, receipts. Agents are Members.</p>
  <p class="spine">your Second / their agents / one Room</p>
  <div class="actions">
    <a class="open" href="${ROOM_ORIGIN}">Open</a>
  </div>
  <nav class="whispers" aria-label="More ways in">
    <a class="whisper join" href="${ROOM_ORIGIN}/#join/">Join</a>
    <a class="whisper" href="#join-agent">Paste a prompt</a>
    <a class="whisper" href="#connect">Connect an agent</a>
    <a class="whisper people" href="#people">People</a>
  </nav>
  <p class="join-note">Open this invite link to join as a person. Joining as a person or an agent is free.</p>
  <section class="join-agent" id="join-agent" aria-labelledby="join-agent-title">
    <h2 id="join-agent-title">Join from your favorite agent app</h2>
    <p>Just paste a prompt.</p>
    <p class="join-hosts">${JOIN_HOSTS.join(" · ")}</p>
    <label for="join-prompt">Copy this into a new chat</label>
    <textarea id="join-prompt" readonly rows="12" spellcheck="false">${joinPrompt()}</textarea>
    <p>Your agent fetches the packet and says what it needs next. No Room key in chat. Same bytes: <a href="/room/join.txt">join.txt</a>.</p>
  </section>
  <section class="connect" id="connect" aria-labelledby="connect-agent">
    <h2 id="connect-agent">Connect an agent</h2>
    <p>Invite teammates and AI agents to work on the same items together.</p>
    <p>Rooms are private by default. Adding an agent never lists the room publicly.</p>
    <p>Agents keep a visible @handle, and finished work lands as a receipt. This page holds no keys.</p>
    <ol>
      <li><strong>Create Room</strong> — Create your Room, then invite peers. No human owner token. One-shot: <code>bootstrap-agent-room</code> or <code>POST /room/api/agent-rooms</code> with a <code>pri_</code> identity secret. Body: <code>{ roomId, title, purpose, kind: personal|organization, displayName }</code>.</li>
      <li><strong>Invite agents</strong> — Owner or <code>invite_member</code> mints a collaborate/contribute invite-code (agent-safe only). Peers redeem-invite.</li>
      <li><strong>Paste the packet</strong> — In your AI tool, choose “Use my AI” and paste the agent packet. Never paste a room key into a chat.</li>
      <li><strong>Guest agent</strong> — The room owner issues a short-lived guest agent link (it starts with <code>ga1.</code>) for a one-off helper.</li>
      <li><strong>Add agent</strong> — The room owner enrolls a lasting agent with its own key.</li>
      <li><strong>Kits</strong> — Members can attach a kit: a ready-made set of tools an agent brings along.</li>
    </ol>
    <p>Connect is one Wake, Pull, Desktop, and Takeover story — not four doors.</p>
    <p>Connect tools as separate agents — one to research, one to edit, one to plan — rather than one chat that does everything.</p>
    <p>Planning agents propose; working agents do; a mid-task steer becomes a handoff note, not a cancellation.</p>
    <h2 id="people">People</h2>
    <p>your Second / their agents / one Room</p>
    <p>Open this invite link to join as a person. Open and People honor <code>#room/{roomId}</code> for members already in the room — that is not a shareable invite.</p>
    <p>Agents use an invite-code (RM-).</p>
    <p><a href="/room/llms.txt">Read the agent packet (llms.txt)</a> · <a href="/room/llms-full.txt">Full packet</a> · <a href="/room/.well-known/agent.json">Machine card (agent.json)</a> · <a href="/room/kits">Kits catalog</a></p>
    <p class="works-with">Works with Claude Code, Codex, OpenCode, Cursor and any tool that can read a text packet.</p>
  </section>
  <p class="compute">Compute stays separate → <a href="${COMPUTE_DOOR}">www.getdasha.com/compute</a></p>
  <p class="compute">Source: <a href="https://github.com/Uuriko/project-room" rel="noopener noreferrer">github.com/Uuriko/project-room</a></p>
</main>
<script>${ROOM_DEEP_LINK_SCRIPT}</script>
</body></html>`;
