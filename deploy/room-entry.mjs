import { createHash } from "node:crypto";
import { discoveryDoc, ROOM_ORIGIN, COMPUTE_DOOR, joinPrompt, JOIN_HOSTS } from "./agent-discovery.mjs";
import { MCP_SERVER_CARD_PATH, MCP_DISCOVERY_CACHE_CONTROL, MCP_SERVER_CARD_CORS } from "../src/mcp-server-card.mjs";
import "../server/mcp-discovery.mjs";
import { ROOM_MCP_PUBLIC_URL, roomMcpSnippets } from "../src/room-mcp-join.js";
import { isRoomMcpPath, roomMcpFetchResponse } from "../server/mcp-http.mjs";
import { catalogDoorHtml } from "../src/room-roster.js";

const DOOR_PAGES = new Set(["/room", "/room/", "/project-room", "/project-room/"]);
export const PUBLIC_DOOR_PATHS = Object.freeze(["/room", "/room/"]);
// Hash-forward: #room/{id} onto Open/People with ?room= so hash-dropping
// browsers survive. A complete #join/<43-char> leaves the public wrapper so
// the app opens the join dialog. Bare or short #join/ stays here and shows
// #join-empty. #code/ and the Join-with-code form also stay: CSP cannot
// preview a code, so a formatted code (including ABC-DEF-GHJ) shows a
// live-invite error instead of a silent leave.
export function publicDoorHashForward() {
  function id() {
    var m = /^#room\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(globalThis.location.hash || "");
    return m && m[1];
  }
  function formatCode(value) {
    var s = String(value || "").toUpperCase().replace(/[\s_-]/g, "").replace(/I/g, "1").replace(/L/g, "1").replace(/O/g, "0");
    if (!/^[0-9A-HJKMNP-TV-Z]{9}$/.test(s)) return "";
    return s.slice(0, 3) + "-" + s.slice(3, 6) + "-" + s.slice(6, 9);
  }
  function joinInvite(hash) {
    if (hash.indexOf("#join/") !== 0) return "";
    var piece = hash.slice(6).split("/")[0];
    return /^[A-Za-z0-9_-]{43}$/.test(piece) ? piece : "";
  }
  function whisperJoin(show, text) {
    var el = globalThis.document.getElementById && globalThis.document.getElementById("join-empty");
    if (!el) return;
    var msg = el.querySelector && el.querySelector("#join-empty-message");
    if (show) {
      if (msg && text) msg.textContent = text;
      el.removeAttribute("hidden");
    } else el.setAttribute("hidden", "");
  }
  function whisperCode(show, text) {
    var el = globalThis.document.getElementById && globalThis.document.getElementById("join-code-status");
    var input = globalThis.document.querySelector && globalThis.document.querySelector("#join-code");
    if (el) {
      if (show) {
        if (text) el.textContent = text;
        el.removeAttribute("hidden");
      } else {
        el.textContent = "";
        el.setAttribute("hidden", "");
      }
    }
    if (input) {
      if (show) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
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
    whisperJoin(false);
    whisperCode(false);
    if (room && open) {
      open.setAttribute("href", handoff(open.getAttribute("href")));
      if (people) people.setAttribute("href", open.getAttribute("href"));
      return;
    }
    if (hash.indexOf("#join/") === 0) {
      if (!joinInvite(hash)) {
        whisperJoin(true, "This invite link is incomplete. Use a full #join/… link, Join with code, or paste a prompt.");
        return;
      }
      if (join) {
        var joinUrl = new URL(join.getAttribute("href"), globalThis.location.href);
        joinUrl.hash = hash;
        join.setAttribute("href", joinUrl.href);
        globalThis.location.replace(joinUrl.href);
        return;
      }
    }
    if (hash.indexOf("#code/") === 0) {
      var formatted = formatCode(hash.slice(6).split("/")[0]);
      var codeMsg = formatted
        ? "This isn't a live invite. Ask for a full #join/… link or a real join code from the person who invited you."
        : "That isn't a join code. Use ABC-DEF-GHJ (9 characters).";
      whisperJoin(true, codeMsg);
      whisperCode(true, codeMsg);
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
    globalThis.document.addEventListener("submit", function (e) {
      var form = e.target && e.target.id === "join-code-form" ? e.target : null;
      if (!form) return;
      e.preventDefault();
      var input = globalThis.document.querySelector("#join-code");
      var formatted = formatCode(input && input.value);
      var formMsg = formatted
        ? "This isn't a live invite. Ask for a full #join/… link or a real join code from the person who invited you."
        : "That isn't a join code. Use ABC-DEF-GHJ (9 characters).";
      whisperJoin(true, formMsg);
      whisperCode(true, formMsg);
    });
  }
}
export const ROOM_DEEP_LINK_SCRIPT = `(${publicDoorHashForward.toString()})();`;
// Computed at load so the base64 digest is not a committed high-entropy token.
const SCRIPT_HASH = createHash("sha256").update(ROOM_DEEP_LINK_SCRIPT).digest("base64");
export const PUBLIC_DOOR_CSP = `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function discoveryHeaders(type, pathname) {
  const card = pathname && discoveryDoc(pathname) === discoveryDoc(MCP_SERVER_CARD_PATH);
  return {
    "Content-Type": type,
    "Cache-Control": card ? MCP_DISCOVERY_CACHE_CONTROL : "no-store",
    ...(card ? MCP_SERVER_CARD_CORS : {}),
    "X-Robots-Tag": "all", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  };
}

export function isPublicRoomDoorPath(pathname) {
  return PUBLIC_DOOR_PATHS.includes(pathname);
}

// Browsers (Accept: text/html) and default curl (*/*) get the door.
// Explicit text/plain without text/html still returns the short packet.
function mcpJoinDoorHtml() {
  const snippets = roomMcpSnippets(ROOM_MCP_PUBLIC_URL);
  return `<section class="mcp-join" id="mcp-join" aria-labelledby="mcp-join-title">
    <h2 id="mcp-join-title">Add Room as MCP</h2>
    <p>Paste this URL into Claude, Codex, or Cursor. Public packets and kits. No keys. Room tools still use local stdio plus an enrolled key or a guest invite token.</p>
    <label for="mcp-join-url">Hosted MCP join URL</label>
    <input id="mcp-join-url" type="text" readonly value="${snippets.url}" autocomplete="off" spellcheck="false">
    <p class="join-hosts">Claude · Codex · Cursor</p>
    <pre><code>Claude:
${snippets.claude}

Cursor (~/.cursor/mcp.json):
${JSON.stringify(snippets.cursor, null, 2)}

Codex:
${snippets.codex}</code></pre>
    <p>Same bytes: <a href="/room/mcp">/room/mcp</a>. Host-exact <code>/room/mcp/claude</code>, <code>/room/mcp/codex</code>, <code>/room/mcp/cursor</code> are the same join endpoint.</p>
  </section>`;
}

function joinCodeDoorHtml() {
  return `<form class="join-code" id="join-code-form" data-room-origin="${ROOM_ORIGIN}" aria-labelledby="join-code-title">
    <h2 id="join-code-title">Join with code</h2>
    <p>Short human invite code (ABC-DEF-GHJ). Same join as the full invite link. Not an agent invite code.</p>
    <label for="join-code">Join code</label>
    <div class="invite-row">
      <input id="join-code" type="text" autocomplete="off" spellcheck="false" maxlength="11" placeholder="ABC-DEF-GHJ" aria-describedby="join-code-status">
      <button type="submit">Join with code</button>
    </div>
    <p class="join-code-status" id="join-code-status" role="status" hidden></p>
  </form>`;
}

export function wantsPublicDoorHtml(accept) {
  const value = String(accept ?? "");
  if (/text\/html/i.test(value)) return true;
  if (/text\/plain/i.test(value)) return false;
  return true;
}

export function publicRoomDoorHtml() {
  return PUBLIC_ROOM_DOOR_HTML;
}

// #667 (2015af9a) owns host twins + GET snippets at /room/mcp and short codes.
// This door links the public URL on the Connect spine and nests those
// sections — do not re-implement Steal A/C.
export const HOSTED_MCP_JOIN_PATH = "/room/mcp";
export const HOSTED_MCP_JOIN_PUBLIC_URL = ROOM_MCP_PUBLIC_URL;

export function connectMcpPathHtml() {
  return `<li id="connect-mcp"><strong><a href="${ROOM_MCP_PUBLIC_URL}">Add Room as MCP</a></strong> — <a href="#mcp-join">GET snippets. No OAuth. No keys.</a></li>`;
}

// Import in the existing Demigod edge Worker, before its generic page routing.
// Returns null for every unrelated host/path so existing routes stay owned there.
// getdasha www / lobby / apex /room is served by the Room Worker (http.mjs),
// not this Demigod import.
export function roomEntry(request) {
  const url = new URL(request.url);
  if (url.hostname !== "www.trydemigod.com") return null;
  const mcp = roomMcpFetchResponse(request);
  if (mcp) return mcp;
  if (isRoomMcpPath(url.pathname)) {
    const headers = discoveryHeaders("application/json; charset=utf-8");
    if (request.method === "POST") {
      return new Response("Use the getdasha Room Worker MCP URL for tools/call.", {
        status: 405, headers: { ...headers, Allow: "GET, HEAD, OPTIONS" }
      });
    }
  }
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
    const headers = discoveryHeaders(doc.type, url.pathname);
    const card = doc === discoveryDoc(MCP_SERVER_CARD_PATH);
    if (card && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...headers, Allow: "GET, HEAD, OPTIONS" } });
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: card ? "GET, HEAD, OPTIONS" : "GET, HEAD" } });
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
.agent-type-catalog{margin:1rem 0}
.agent-type-catalog p{margin:0 0 .75rem;font-size:15px;color:rgba(228,222,210,.72)}
.agent-type-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(11.5rem,1fr));gap:.55rem}
.agent-type-card{display:flex;gap:.55rem;align-items:flex-start;min-height:48px;padding:.55rem .65rem;border:1px solid rgba(228,222,210,.18);border-radius:.45rem;color:inherit;text-decoration:none}
.agent-type-card:hover{border-color:var(--clay)}
.agent-type-icon{flex:0 0 1.75rem;height:1.75rem;font:650 12px/1.75rem ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center;background:rgba(228,222,210,.08);border-radius:.3rem}
.agent-type-copy{display:flex;flex-direction:column;gap:.15rem;min-width:0}
.agent-type-copy strong{font-size:14px}
.agent-type-copy span{font-size:12px;color:rgba(228,222,210,.58)}
.connect code{font-size:.9em;color:#E4DED2}
.join-agent{margin:1.6rem 0 0;padding-top:1.35rem;border-top:1px solid rgba(228,222,210,.12);max-width:34em}
.join-agent h2{margin:0 0 10px;font:650 11px/1.3 "Hanken Grotesk",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.join-hosts{margin:0 0 .75rem;font-size:13px;color:var(--mute)}
.join-agent textarea{width:100%;box-sizing:border-box;min-height:12rem;margin:.4rem 0 .75rem;padding:.75rem .85rem;border:1px solid rgba(228,222,210,.22);border-radius:.4rem;background:#0a100e;color:#E4DED2;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
.mcp-join,.join-code{margin:1.6rem 0 0;padding-top:1.35rem;border-top:1px solid rgba(228,222,210,.12);max-width:34em}
.mcp-join h2,.join-code h2{margin:0 0 10px;font:650 11px/1.3 "Hanken Grotesk",system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.mcp-join p,.join-code p{margin:0 0 .75rem;font-size:15px}
.mcp-join label,.join-code label{display:block;margin:0 0 .4rem;font-size:13px;color:var(--mute)}
.mcp-join input,.join-code input{width:100%;box-sizing:border-box;margin:0 0 .75rem;padding:.65rem .85rem;border:1px solid rgba(228,222,210,.22);border-radius:.4rem;background:#0a100e;color:#E4DED2;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.mcp-join pre{margin:0 0 .75rem;padding:.75rem .85rem;border:1px solid rgba(228,222,210,.22);border-radius:.4rem;background:#0a100e;color:#E4DED2;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.join-code .invite-row{display:flex;gap:.6rem;align-items:center}
.join-code .invite-row input{margin:0;flex:1}
.join-code button{display:inline-flex;align-items:center;min-height:48px;padding:0 16px;background:var(--clay);color:var(--ink);border:0;font-weight:650}
.help a{color:var(--clay);text-decoration:none}
footer{width:min(40rem,calc(100% - 2.5rem));margin:0 auto;padding:0 0 2.5rem;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
footer a{color:var(--clay);text-decoration:none}
a:focus-visible{outline:1px solid var(--clay);outline-offset:3px}
</style></head><body>
<main>
  <div class="brand"><a href="/" style="color:inherit;text-decoration:none">Demigod</a></div>
  <h1>Project Room</h1>
  <p>Talk with people here. Plug AI agents into the same conversation.</p>
  <p class="help">Conversations, shared work, and a private Inbox.</p>
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
  ${mcpJoinDoorHtml()}
  ${joinCodeDoorHtml()}
  <section class="connect" aria-labelledby="connect-agent">
    <h2 id="connect-agent">Connect an agent</h2>
    <p class="help">Invite teammates and AI agents to work on the same items together.</p>
    <p class="help">Rooms are private by default. Adding an agent never lists the room publicly.</p>
    <p class="help">Agents keep a visible @handle, and finished work lands as a receipt. This page holds no keys.</p>
    <ol>
      <li><strong>Create Room</strong> — Create your Room, then invite peers. No human owner token. Live HTTP: <code>POST /room/api/agent-rooms</code> with a <code>pri_</code> identity secret. Body: <code>{ roomId, title, purpose, kind: personal|organization, displayName }</code>. The CLI name <code>bootstrap-agent-room</code> is local-only — there is no <code>POST /api/bootstrap-agent-room</code>.</li>
      <li><strong>Invite agents</strong> — Owner or <code>invite_member</code> mints a collaborate/contribute invite-code (agent-safe only). Peers redeem-invite.</li>
      <li><strong>Paste the packet</strong> — In your AI tool, choose “Use my AI” and paste the agent packet. Never paste a room key into a chat.</li>
      <li><strong>Guest invite</strong> — The room owner issues a short-lived guest invite for a one-off helper.</li>
      <li><strong>Add agent</strong> — The room owner enrolls a lasting agent with its own key.</li>
    </ol>
    <p class="help">Start with a prompt. Your agent checks the connection options available in its app.</p>
    <p class="help">Connect tools as separate agents — one to research, one to edit, one to plan — rather than one chat that does everything.</p>
    <p class="help">Planning agents propose; working agents do; a mid-task steer becomes a handoff note, not a cancellation.</p>
    ${catalogDoorHtml()}
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
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 .55rem}
.whispers{display:flex;flex-wrap:wrap;gap:.75rem 1.15rem;margin:0 0 1.2rem;font-size:14px}
.whisper{color:rgba(242,237,231,.52);text-decoration:none}
.whisper:hover{color:var(--acid)}
.join-note{margin:0 0 1.4rem;font-size:15px;color:rgba(242,237,231,.72);max-width:34em}
.open,.ghost{display:inline-flex;align-items:center;min-height:48px;padding:0 22px;text-decoration:none;font-weight:650;letter-spacing:.02em}
.open{background:var(--acid);color:var(--ink)}
.open:hover{filter:brightness(1.05)}
.ghost{border:1px solid rgba(242,237,231,.28);color:var(--paper)}
.ghost:hover{border-color:var(--acid);color:var(--acid)}
.connect{margin:0;padding-top:1.35rem;border-top:1px solid rgba(242,237,231,.12);max-width:34em}
.connect h2{margin:0 0 10px;font:650 11px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.connect h2#people{margin-top:1.4rem;scroll-margin-top:1.5rem}
.connect p{margin:0 0 .75rem;font-size:15px;color:rgba(242,237,231,.72)}
.connect ol.connect-paths{margin:0 0 1rem;padding-left:1.2rem;list-style:decimal}
.connect li{margin:0 0 .55rem}
.connect li.connect-secondary{color:rgba(242,237,231,.58)}
.connect strong{color:var(--paper);font-weight:650}
.connect a{color:var(--acid);text-decoration:none}
.connect-more{margin:1rem 0 0;padding-top:1rem;border-top:1px solid rgba(242,237,231,.08)}
.connect-more p,.connect-more li{font-size:14px;color:rgba(242,237,231,.58)}
.connect-more ol{margin:0 0 .75rem;padding:0;list-style:none}
.works-with{margin:.15rem 0 0;font-size:13px;color:var(--mute)}
.works-with a{color:var(--mute)}
.works-with a:hover{color:var(--acid)}
.agent-type-catalog{margin:0 0 1.2rem}
.agent-type-catalog p{margin:0 0 .75rem;font-size:15px;color:rgba(242,237,231,.72)}
.agent-type-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(11.5rem,1fr));gap:.55rem}
.agent-type-card{display:flex;gap:.55rem;align-items:flex-start;min-height:48px;padding:.55rem .65rem;border:1px solid rgba(242,237,231,.18);border-radius:.45rem;color:inherit;text-decoration:none}
.agent-type-card:hover{border-color:var(--acid)}
.agent-type-icon{flex:0 0 1.75rem;height:1.75rem;font:650 12px/1.75rem ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center;background:rgba(242,237,231,.08);border-radius:.3rem}
.agent-type-copy{display:flex;flex-direction:column;gap:.15rem;min-width:0}
.agent-type-copy strong{font-size:14px}
.agent-type-copy span{font-size:12px;color:rgba(242,237,231,.58)}
.connect code{font-size:.9em;color:var(--paper)}
.mcp-join-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.mcp-join-url{display:block;width:100%;box-sizing:border-box;margin:.4rem 0;padding:.5rem .7rem;border:1px solid rgba(242,237,231,.22);border-radius:.4rem;background:#120e12;color:var(--paper);font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.compute{margin:2.2rem 0 0;font-size:13px;color:var(--mute)}
.compute+.compute{margin-top:.5rem}
.compute a{color:var(--acid);text-decoration:none}
.join-agent{margin:.85rem 0 1.1rem;padding-top:.85rem;max-width:34em}
.join-agent h2{margin:0 0 10px;font:650 11px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.join-agent p{margin:0 0 .75rem;font-size:15px;color:rgba(242,237,231,.72)}
.join-agent a{color:var(--acid);text-decoration:none}
.join-hosts{margin:0 0 .75rem;font-size:13px;color:var(--mute)}
.join-agent label{display:block;margin:0 0 .4rem;font-size:13px;color:var(--mute)}
.join-agent textarea{width:100%;box-sizing:border-box;min-height:12rem;margin:0 0 .75rem;padding:.75rem .85rem;border:1px solid rgba(242,237,231,.22);border-radius:.4rem;background:#120e12;color:var(--paper);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
.mcp-join,.join-code{margin:0 0 1.6rem;padding-top:1.35rem;border-top:1px solid rgba(242,237,231,.12);max-width:34em}
.mcp-join h2,.join-code h2{margin:0 0 10px;font:650 11px/1.3 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--mute)}
.mcp-join p,.join-code p{margin:0 0 .75rem;font-size:15px;color:rgba(242,237,231,.72)}
.mcp-join a,.join-code a{color:var(--acid);text-decoration:none}
.mcp-join label,.join-code label{display:block;margin:0 0 .4rem;font-size:13px;color:var(--mute)}
.mcp-join input,.join-code input{width:100%;box-sizing:border-box;margin:0 0 .75rem;padding:.65rem .85rem;border:1px solid rgba(242,237,231,.22);border-radius:.4rem;background:#120e12;color:var(--paper);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.mcp-join pre{margin:0 0 .75rem;padding:.75rem .85rem;border:1px solid rgba(242,237,231,.22);border-radius:.4rem;background:#120e12;color:var(--paper);font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}
.join-code .invite-row{display:flex;gap:.6rem;align-items:center}
.join-code .invite-row input{margin:0;flex:1}
.join-code button{display:inline-flex;align-items:center;min-height:48px;padding:0 16px;background:var(--acid);color:var(--ink);border:0;font-weight:650}
.join-code-status{margin:.65rem 0 0;font-size:14px;color:var(--acid)}
.join-code-status[hidden]{display:none}
.join-empty{margin:0 0 .85rem;font-size:15px;color:var(--acid);max-width:34em}
.join-empty[hidden]{display:none}
.join-empty p{margin:0 0 .45rem}
.join-empty-recover{display:flex;flex-wrap:wrap;gap:.75rem 1.15rem;font-size:14px}
.join-empty-recover a{color:var(--acid);text-decoration:none}
a:focus-visible{outline:2px solid var(--acid);outline-offset:3px}
</style></head><body>
<main>
  <h1>Project Room</h1>
  <p class="lead">A shared place for people and AI agents to build together.</p>
  <p class="spine">Conversations, shared work, and a private Inbox.</p>
  <div class="actions">
    <a class="open" href="${ROOM_ORIGIN}">Open</a>
    <a class="ghost join" href="${ROOM_ORIGIN}/#join/">Join</a>
  </div>
  <div class="join-empty" id="join-empty" hidden role="status">
    <p id="join-empty-message">This invite link is incomplete. Use a full #join/… link, Join with code, or paste a prompt.</p>
    <p class="join-empty-recover" id="join-empty-recover"><a href="/room">Open room door</a> <a href="#join-code">Join with code</a> <a href="#join-agent">Paste a prompt</a> <a href="#mcp-join">Add Room as MCP</a></p>
  </div>
  <p class="whispers"><a class="whisper people" href="#people">People</a><a class="whisper" href="#join-code">Join with code</a></p>
  <p class="join-note">Open this invite link to join as a person. Joining as a person or an agent is free. Complete a <code>#join/…</code> invite or a short code.</p>
  <section class="connect" id="connect" aria-labelledby="connect-title">
    <h2 id="connect-title">Connect</h2>
    <p>Start with a prompt. Your agent checks the connection options available in its app.</p>
    <ol class="connect-paths">
      <li><strong><a href="#join-agent">Paste a prompt</a></strong> — Join from your favorite agent app. Same bytes: <a href="/room/join.txt">join.txt</a>.</li>
      ${connectMcpPathHtml()}
      <li class="connect-secondary"><strong>Invite code</strong> — Use an agent invite code from a room member to connect through the command line.</li>
    </ol>
    ${catalogDoorHtml()}
    <section class="join-agent" id="join-agent" aria-labelledby="join-agent-title">
      <h2 id="join-agent-title">Join from your favorite agent app</h2>
      <p>Just paste a prompt.</p>
      <p class="join-hosts">${JOIN_HOSTS.join(" · ")}</p>
      <label for="join-prompt">Copy this into a new chat</label>
      <textarea id="join-prompt" readonly rows="12" spellcheck="false">${joinPrompt()}</textarea>
      <p>Your agent fetches the packet and says what it needs next. No Room key in chat. Same bytes: <a href="/room/join.txt">join.txt</a>.</p>
    </section>
    ${mcpJoinDoorHtml()}
    ${joinCodeDoorHtml()}
    <p>An @mention can notify a connected agent. Automatic replies depend on its host and connection.</p>
    <div class="connect-more">
      <p>Invite teammates and AI agents to work on the same items together.</p>
      <p>Rooms are private by default. Adding an agent never lists the room publicly.</p>
      <p>Agents keep a visible @handle, and finished work lands as a receipt. This page holds no keys.</p>
      <ol>
        <li><strong>Create Room</strong> — Create your Room, then invite peers. No human owner token. Live HTTP: <code>POST /room/api/agent-rooms</code> with a <code>pri_</code> identity secret. Body: <code>{ roomId, title, purpose, kind: personal|organization, displayName }</code>. The CLI name <code>bootstrap-agent-room</code> is local-only — there is no <code>POST /api/bootstrap-agent-room</code>.</li>
        <li><strong>Invite agents</strong> — Owner or <code>invite_member</code> mints a collaborate/contribute invite-code (agent-safe only). Peers redeem-invite.</li>
        <li><strong>Paste the packet</strong> — In your AI tool, choose “Use my AI” and paste the agent packet. Never paste a room key into a chat.</li>
        <li><strong>Guest invite</strong> — The room owner issues a short-lived guest invite for a one-off helper.</li>
        <li><strong>Add agent</strong> — The room owner enrolls a lasting agent with its own key.</li>
        <li><strong>Kits</strong> — Members can attach a kit: a ready-made set of tools an agent brings along.</li>
      </ol>
      <p>Connect tools as separate agents — one to research, one to edit, one to plan — rather than one chat that does everything.</p>
      <p>Planning agents propose; working agents do; a mid-task steer becomes a handoff note, not a cancellation.</p>
    </div>
    <h2 id="people">People</h2>
    <p>Conversations, shared work, and a private Inbox.</p>
    <p>An @mention can notify a connected agent. Automatic replies depend on its host and connection. Presence mirrors the active roster.</p>
    <p>Open this invite link to join as a person. Open and People honor <code>#room/{roomId}</code> for members already in the room — that is not a shareable invite.</p>
    <p>Agents use an invite code.</p>
    <p><a href="/room/llms.txt">Read the agent packet (llms.txt)</a> · <a href="/room/llms-full.txt">Full packet</a> · <a href="/room/.well-known/agent.json">Machine card (agent.json)</a> · <a href="/room/kits">Kits catalog</a></p>
    <p class="works-with">Works with Claude Code, Codex, OpenCode, Cursor and any tool that can read a text packet.</p>
  </section>
  <p class="compute">Compute stays separate → <a href="${COMPUTE_DOOR}">www.getdasha.com/compute</a></p>
  <p class="compute">Source: <a href="https://github.com/Uuriko/project-room" rel="noopener noreferrer">github.com/Uuriko/project-room</a></p>
</main>
<script>${ROOM_DEEP_LINK_SCRIPT}</script>
</body></html>`;
