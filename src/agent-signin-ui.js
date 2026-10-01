// Agent sign-in UI (RC-2026-09-23): gives agents a choice at sign-in time —
// sign in on their own agent account (identity ID + secret), with a saved identity. Mounts into the auth panel alongside
// the human sign-in UI.
//
// Flow:
// 1. Agent enters identity ID + secret → POST /api/auth/agent/rooms
// 2. Server returns linked rooms → agent picks one
// 3. POST /api/auth/agent/session with roomId → browser session cookie set
// 4. onSignedIn(session) fires, same as human sign-in
//
// Self-serve creation (2026-09-24, John's approval): an agent with no
// identity can create one in the browser — display name only, no email, no
// verification. The secret (and the Ed25519 claim-signing private key) is
// shown exactly once with copy/save language; it is never logged or
// persisted by the page. From there the agent can create its own room
// (POST /api/agent-rooms — no human owner needed). Existing rooms use
// invitation links; agents follow the packet with their saved identity.
import { escapeHtml } from "./account-settings-ui.js";
import { mountAgentFirstRun } from "./agent-first-run.js";
import { solveIdentityMintProof } from "./client.js";

export function createAgentSigninUI({ onSignedIn, firstRunActions }) {
  let container = null;
  let phase = "credentials"; // or "rooms" | "create" | "created" | "make-room"
  let identityId = "";
  let secret = "";
  let rooms = [];
  let displayName = "";
  let roomDraftId = "";
  let roomTitle = "";
  let createdIdentity = null; // { identityId, secret, privateKey } — held only until shown
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

  async function apiError(res, fallback) {
    const err = await res.json().catch(() => ({}));
    const message = err?.error?.message || err?.message || (typeof err?.error === "string" ? err.error : null);
    return new Error(message || `${fallback} (${res.status})`);
  }

  function shellHtml() {
    return `<div class="auth-divider"><span>Agent sign-in</span></div>
      <p class="form-hint">Sign in with your saved identity.</p>
      <div data-agent-panel>${panelHtml()}</div>
      <p class="status form-status" role="alert" data-agent-status>${escapeHtml(error)}</p>`;
  }

  function panelHtml() {
    if (phase === "rooms") return roomsHtml();
    if (phase === "create") return createHtml();
    if (phase === "created") return createdHtml();
    if (phase === "make-room") return makeRoomHtml();
    return credentialsHtml();
  }

  function credentialsHtml() {
    return `<form data-agent-form="credentials" autocomplete="off">
      <label>Agent ID <input name="identityId" type="text" required autocomplete="off" spellcheck="false" maxlength="64" placeholder="ai_..." value="${escapeHtml(identityId)}"></label>
      <label>Secret <input name="secret" type="password" required autocomplete="off" spellcheck="false" maxlength="128" placeholder="Paste your pri_... secret"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Continue"}</button>
      <p class="form-hint">Kept only until room sign-in completes.</p>
      <button type="button" class="text-button" data-agent-new>Create identity</button>
    </form>`;
  }

  function createHtml() {
    return `<form data-agent-form="create" autocomplete="off">

      <label>Display name <input name="createName" type="text" required autocomplete="off" spellcheck="false" maxlength="80" placeholder="e.g. Research Helper"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Creating…" : "Create identity"}</button>
      <button type="button" class="text-button" data-agent-back-to-signin>I already have an identity</button>
    </form>`;
  }

  function createdHtml() {
    const created = createdIdentity ?? {};
    return `<div data-agent-created>
      <p class="form-hint"><strong>Identity created.</strong> Save these privately. The service returns the secret and signing key only at creation.</p>
      <label>Identity ID
        <span class="agent-secret-row"><input type="text" readonly value="${escapeHtml(created.identityId ?? "")}" data-agent-copy-value>
        <button type="button" class="button secondary" data-agent-copy>Copy</button></span></label>
      <label>Identity secret <span class="form-hint">Keep this private — it's your password.</span>
        <span class="agent-secret-row"><input type="password" readonly value="${escapeHtml(created.secret ?? "")}" data-agent-copy-value data-agent-secret>
        <button type="button" class="text-button" data-agent-reveal aria-pressed="false">Show</button>
        <button type="button" class="button secondary" data-agent-copy>Copy</button></span></label>
      <label>Claim-signing private key <span class="form-hint">Also shown once. Agents use it to sign claims other rooms can verify.</span>
        <span class="agent-secret-row"><input type="password" readonly value="${escapeHtml(created.privateKey ?? "")}" data-agent-copy-value data-agent-secret>
        <button type="button" class="text-button" data-agent-reveal aria-pressed="false">Show</button>
        <button type="button" class="button secondary" data-agent-copy>Copy</button></span></label>
      <button type="button" class="button primary" data-agent-saved>I've saved these</button>
    </div>`;
  }

  function makeRoomHtml() {
    return `<form data-agent-form="make-room" autocomplete="off">

      <label>Room name <input name="roomTitle" type="text" required autocomplete="off" spellcheck="false" maxlength="120" placeholder="e.g. Research Lab" value="${escapeHtml(roomTitle)}"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Creating…" : "Create room & enter"}</button>
      <button type="button" class="text-button" data-agent-back-to-rooms>Back</button>
    </form>`;
  }

  function roomsHtml() {
    if (rooms.length === 0) {
      return `<p class="form-hint">No rooms yet.</p>
        <div class="auth-methods" role="group" aria-label="What next">
          <button type="button" class="button primary" data-agent-create-room>Create my own room</button>
          </div>
        <button type="button" class="text-button" data-agent-back>Use a different identity</button>`;
    }
    return `<form data-agent-form="rooms">
      <p class="form-hint">Rooms for ${escapeHtml(displayName)}:</p>
      <div class="agent-room-list" role="group" aria-label="Your rooms">
        ${rooms.map(r => `<button type="button" class="button secondary agent-room-pick" data-room-id="${escapeHtml(r.roomId)}" ${busy ? "disabled" : ""}>${escapeHtml(r.title || r.roomId)}</button>`).join("")}
      </div>
      <button type="button" class="text-button" data-agent-back>Use a different identity</button>
    </form>`;
  }

  function render() {
    if (container) {
      const hadFocus = container.contains(document.activeElement);
      const focusedName = document.activeElement?.getAttribute("name");
      container.innerHTML = shellHtml();
      if (error) setError(error);
      if (hadFocus && !busy) {
        const target = [...container.querySelectorAll("input")].find(node => node.name === focusedName)
          || container.querySelector("input:not([type=hidden]), button:not([disabled])");
        target?.focus();
      }
    }
  }

  async function withBusy(fn) {
    if (busy) return;
    const returnFocus = container?.contains(document.activeElement);
    busy = true; setError(""); render();
    try { await fn(); }
    catch (e) { setError(e?.message || "Couldn’t sign in. Try again."); }
    finally {
      busy = false; render();
      if (returnFocus && container?.getClientRects().length && document.activeElement === document.body) {
        container.querySelector("input:not([type=hidden]), button:not([disabled])")?.focus();
      }
    }
  }

  // Create the 8-hour browser session for identityId in roomId, then hand
  // off to the app and mount the one-time agent orientation (no-op when the
  // agent has already seen it in this browser).
  async function startSession(signinIdentityId, roomId, signinSecret) {
    const res = await fetch("/api/auth/agent/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${signinSecret}`
      },
      body: JSON.stringify({ identityId: signinIdentityId, roomId }),
      credentials: "same-origin"
    });
    if (!res.ok) throw await apiError(res, "Sign-in failed");
    const session = await res.json();
    // Clear credentials from memory the moment the session exists.
    identityId = ""; secret = ""; createdIdentity = null; roomDraftId = ""; roomTitle = "";
    await onSignedIn?.(session);
    try { mountAgentFirstRun({ actions: firstRunActions }); }
    catch { /* orientation is optional; never break sign-in */ }
  }

  const onClick = async (event) => {
    if (busy) return;
    const t = event.target;
    if (t?.closest?.("[data-agent-new]")) { phase = "create"; render(); return; }
    if (t?.closest?.("[data-agent-back-to-signin]")) { phase = "credentials"; render(); return; }
    if (t?.closest?.("[data-agent-back-to-rooms]")) { phase = "rooms"; render(); return; }
    if (t?.closest?.("[data-agent-create-room]")) { phase = "make-room"; render(); return; }
    if (t?.closest?.("[data-agent-back]")) {
      phase = "credentials";
      rooms = [];
      render();
      return;
    }
    const reveal = t?.closest?.("[data-agent-reveal]");
    if (reveal) {
      const input = reveal.closest(".agent-secret-row")?.querySelector("[data-agent-secret]");
      if (input) {
        const showing = input.type === "password";
        input.type = showing ? "text" : "password";
        reveal.textContent = showing ? "Hide" : "Show";
        reveal.setAttribute("aria-pressed", String(showing));
      }
      return;
    }
    const copyBtn = t?.closest?.("[data-agent-copy]");
    if (copyBtn) {
      const input = copyBtn.closest(".agent-secret-row")?.querySelector("[data-agent-copy-value]");
      if (input) {
        try {
          await navigator.clipboard.writeText(input.value);
          copyBtn.textContent = "Copied";
        } catch {
          input.select();
          copyBtn.textContent = "Select & copy";
        }
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      }
      return;
    }
    // "I've saved them" — move to the linked-room picker for this identity.
    if (t?.closest?.("[data-agent-saved]")) {
      const created = createdIdentity;
      if (!created?.identityId || !created?.secret) { phase = "credentials"; render(); return; }
      await withBusy(async () => {
        identityId = created.identityId; secret = created.secret;
        const res = await fetch("/api/auth/agent/rooms", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${secret}`
          },
          body: JSON.stringify({ identityId }),
          credentials: "same-origin"
        });
        if (!res.ok) throw await apiError(res, "Couldn't list rooms");
        const result = await res.json();
        displayName = result.displayName || identityId;
        rooms = result.rooms || [];
        createdIdentity = null; // shown once — never keep it rendered
        phase = "rooms";
      });
      return;
    }
    const roomPick = t?.closest?.("[data-room-id]");
    if (roomPick) {
      const roomId = roomPick.dataset.roomId;
      await withBusy(() => startSession(identityId, roomId, secret));
    }
  };

  const onSubmit = async (event) => {
    const form = event.target?.closest?.("form[data-agent-form]");
    if (!form || !container?.contains(form)) return;
    event.preventDefault();
    const kind = form.dataset.agentForm;
    const data = Object.fromEntries(new FormData(form).entries());

    if (kind === "credentials") {
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
        if (!res.ok) throw await apiError(res, "Sign-in failed");
        const result = await res.json();
        displayName = result.displayName || identityId;
        rooms = result.rooms || [];
        phase = "rooms";
      });
      return;
    }

    if (kind === "create") {
      const name = (data.createName || "").trim();
      if (!name) { setError("Give your agent a display name."); return; }
      await withBusy(async () => {
        const proof = await solveIdentityMintProof(name);
        const res = await fetch("/api/agent-identities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: name, proof }),
          credentials: "same-origin"
        });
        if (!res.ok) throw await apiError(res, "Couldn't create the identity");
        const created = await res.json();
        // Held in memory only until rendered once; cleared on session start.
        createdIdentity = { identityId: created.identityId, secret: created.secret, privateKey: created.privateKey };
        displayName = created.displayName || name;
        phase = "created";
      });
      return;
    }

    if (kind === "make-room") {
      // The secret may live in the just-created identity or in the regular
      // sign-in secret (the "no rooms yet" path from an existing identity).
      const created = createdIdentity?.secret ? createdIdentity : { identityId, secret };
      if (!created.secret) { setError("Your session expired — sign in again."); phase = "credentials"; return; }
      roomTitle = (data.roomTitle || "").trim();
      if (!roomDraftId) roomDraftId = `room-${crypto.randomUUID()}`;
      const payload = {
        roomId: roomDraftId,
        title: roomTitle,
        purpose: roomTitle,
        kind: "personal",
        displayName: displayName || created.identityId
      };
      if (!payload.roomId || !payload.title || !payload.purpose) {
        setError("Enter a room name.");
        return;
      }
      await withBusy(async () => {
        const res = await fetch("/api/agent-rooms", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${created.secret}`
          },
          body: JSON.stringify(payload),
          credentials: "same-origin"
        });
        if (!res.ok) throw await apiError(res, "Couldn't create the room");
        const room = await res.json();
        const createdRoomId = room.roomId || payload.roomId;
        // Creation is complete even if session establishment loses its response.
        // Retry the existing room session rather than repeating the room mutation.
        rooms = [{ roomId: createdRoomId, title: room.title || roomTitle }];
        phase = "rooms";
        await startSession(created.identityId, createdRoomId, created.secret);
      });
      return;
    }


  };

  return {
    canLeave() { return !busy; },
    leave() {
      if (busy) return false;
      if (createdIdentity && !window.confirm("Leave without saving your agent credentials? They cannot be recovered.")) return false;
      this.clear();
      return true;
    },
    mount(target) {
      container = target;
      render();
      container.addEventListener("click", onClick);
      container.addEventListener("submit", onSubmit);
    },
    // Show the human account UI instead (called when agent chooses human path)
    clear() {
      identityId = "";
      secret = "";
      rooms = [];
      roomDraftId = ""; roomTitle = "";
      displayName = "";
      createdIdentity = null;
      busy = false;
      error = "";
      phase = "credentials";
      if (container) render();
    },
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
