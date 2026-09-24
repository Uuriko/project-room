// Agent sign-in UI (RC-2026-09-23): gives agents a choice at sign-in time —
// sign in on their own agent account (identity ID + secret), or fall back
// to the human account sign-in flows. Mounts into the auth panel alongside
// the human sign-in UI.
//
// Flow:
// 1. Agent enters identity ID + secret → POST /api/auth/agent/rooms
// 2. Server returns linked rooms → agent picks one
// 3. POST /api/auth/agent/session with roomId → browser session cookie set
// 4. onSignedIn(session) fires, same as human sign-in
import { escapeHtml } from "./account-settings-ui.js";

export function createAgentSigninUI({ onSignedIn, onUseHumanAccount }) {
  let container = null;
  let phase = "credentials"; // or "rooms"
  let identityId = "";
  let secret = "";
  let rooms = [];
  let displayName = "";
  let busy = false;
  let error = "";

  const statusNode = () => container?.querySelector("[data-agent-status]") ?? null;
  function setError(text) {
    error = text;
    const node = statusNode();
    if (node) {
      node.textContent = text;
      node.classList.toggle("visible", Boolean(text));
      node.classList.toggle("error", Boolean(text));
    }
  }

  function shellHtml() {
    return `<div class="auth-divider"><span>Agent sign-in</span></div>
      <p class="form-hint">Agents can sign in on their own account, or use the human account sign-in below.</p>
      <div class="auth-methods" role="group" aria-label="Agent sign-in choice">
        <button type="button" class="button ${phase === "credentials" || phase === "rooms" ? "primary" : "ghost"}" data-agent-tab="own">My agent account</button>
        <button type="button" class="button ghost" data-agent-tab="human">Human account</button>
      </div>
      <div data-agent-panel>${panelHtml()}</div>
      <p class="status form-status" role="alert" data-agent-status>${escapeHtml(error)}</p>`;
  }

  function panelHtml() {
    if (phase === "rooms") return roomsHtml();
    return credentialsHtml();
  }

  function credentialsHtml() {
    return `<form data-agent-form="credentials" autocomplete="off">
      <label>Agent identity ID <input name="identityId" type="text" required autocomplete="off" spellcheck="false" maxlength="64" placeholder="ai_..." value="${escapeHtml(identityId)}"></label>
      <label>Identity secret <input name="secret" type="password" required autocomplete="off" spellcheck="false" maxlength="128" placeholder="Paste your pri_... secret"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Continue"}</button>
      <p class="form-hint">Your secret stays in this browser — it’s sent once to verify, then the session cookie takes over.</p>
    </form>`;
  }

  function roomsHtml() {
    if (rooms.length === 0) {
      return `<p class="form-hint">Signed in as ${escapeHtml(displayName)}, but this identity isn’t linked to any rooms yet. Ask a room owner to link it, then try again.</p>
        <button type="button" class="button ghost" data-agent-back>Back</button>`;
    }
    return `<form data-agent-form="rooms">
      <p class="form-hint">Signed in as ${escapeHtml(displayName)}. Choose a room:</p>
      <div class="agent-room-list" role="list">
        ${rooms.map(r => `<button type="button" class="button secondary agent-room-pick" role="listitem" data-room-id="${escapeHtml(r.roomId)}" ${busy ? "disabled" : ""}>${escapeHtml(r.title || r.roomId)}</button>`).join("")}
      </div>
      <button type="button" class="text-button" data-agent-back>Use a different identity</button>
    </form>`;
  }

  function render() {
    if (container) {
      container.innerHTML = shellHtml();
      if (error) setError(error);
    }
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true; setError(""); render();
    try { await fn(); }
    catch (e) { setError(e?.message || "Couldn’t sign in. Try again."); }
    finally { busy = false; render(); }
  }

  const onClick = async (event) => {
    const tab = event.target?.closest?.("[data-agent-tab]");
    if (tab) {
      if (tab.dataset.agentTab === "human") {
        onUseHumanAccount?.();
      } else {
        phase = "credentials";
        render();
      }
      return;
    }
    if (event.target?.closest?.("[data-agent-back]")) {
      phase = "credentials";
      rooms = [];
      render();
      return;
    }
    const roomPick = event.target?.closest?.("[data-room-id]");
    if (roomPick) {
      const roomId = roomPick.dataset.roomId;
      await withBusy(async () => {
        const res = await fetch("/api/auth/agent/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${secret}`
          },
          body: JSON.stringify({ identityId, roomId }),
          credentials: "same-origin"
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || `Sign-in failed (${res.status})`);
        }
        const session = await res.json();
        // Clear the secret from memory
        secret = "";
        await onSignedIn?.(session);
      });
    }
  };

  const onSubmit = async (event) => {
    const form = event.target?.closest?.('[data-agent-form="credentials"]');
    if (!form || !container?.contains(form)) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    identityId = (data.identityId || "").trim();
    secret = (data.secret || "").trim();
    if (!identityId || !secret) {
      setError("Enter both your identity ID and secret.");
      return;
    }
    await withBusy(async () => {
      const res = await fetch("/api/auth/agent/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${secret}`
        },
        body: JSON.stringify({ identityId }),
        credentials: "same-origin"
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Sign-in failed (${res.status})`);
      }
      const result = await res.json();
      displayName = result.displayName || identityId;
      rooms = result.rooms || [];
      phase = "rooms";
    });
  };

  return {
    mount(target) {
      container = target;
      render();
      container.addEventListener("click", onClick);
      container.addEventListener("submit", onSubmit);
    },
    // Show the human account UI instead (called when agent chooses human path)
    hide() {
      if (container) container.hidden = true;
    },
    show() {
      if (container) {
        container.hidden = false;
        phase = "credentials";
        render();
      }
    }
  };
}
