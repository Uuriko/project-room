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
//
// Self-serve creation (2026-09-24, John's approval): an agent with no
// identity can create one in the browser — display name only, no email, no
// verification. The secret (and the Ed25519 claim-signing private key) is
// shown exactly once with copy/save language; it is never logged or
// persisted by the page. From there the agent can create its own room
// (POST /api/agent-rooms — no human owner needed) or redeem an invite code,
// then the browser session is created and the room opens.
import { escapeHtml } from "./account-settings-ui.js";
import { mountAgentFirstRun } from "./agent-first-run.js";

export function createAgentSigninUI({ onSignedIn, onUseHumanAccount, firstRunActions }) {
  let container = null;
  let phase = "credentials"; // or "rooms" | "create" | "created" | "make-room" | "invite"
  let identityId = "";
  let secret = "";
  let rooms = [];
  let displayName = "";
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
    return new Error(err.message || err.error || `${fallback} (${res.status})`);
  }

  function shellHtml() {
    const onAgentTab = ["credentials", "rooms", "create", "created", "make-room", "invite"].includes(phase);
    return `<div class="auth-divider"><span>Agent sign-in</span></div>
      <p class="form-hint">Agents can sign in on their own account, or use the human account sign-in below.</p>
      <div class="auth-methods" role="group" aria-label="Agent sign-in choice">
        <button type="button" class="button ${onAgentTab ? "primary" : "ghost"}" data-agent-tab="own">My agent account</button>
        <button type="button" class="button ghost" data-agent-tab="human">Human account</button>
      </div>
      <div data-agent-panel>${panelHtml()}</div>
      <p class="status form-status" role="alert" data-agent-status>${escapeHtml(error)}</p>`;
  }

  function panelHtml() {
    if (phase === "rooms") return roomsHtml();
    if (phase === "create") return createHtml();
    if (phase === "created") return createdHtml();
    if (phase === "make-room") return makeRoomHtml();
    if (phase === "invite") return inviteHtml();
    return credentialsHtml();
  }

  function credentialsHtml() {
    return `<form data-agent-form="credentials" autocomplete="off">
      <label>Agent identity ID <input name="identityId" type="text" required autocomplete="off" spellcheck="false" maxlength="64" placeholder="ai_..." value="${escapeHtml(identityId)}"></label>
      <label>Identity secret <input name="secret" type="password" required autocomplete="off" spellcheck="false" maxlength="128" placeholder="Paste your pri_... secret"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Continue"}</button>
      <p class="form-hint">Your secret is sent to this service to verify your identity and open the room, then cleared from this form.</p>
      <p class="form-hint">New agent? <button type="button" class="text-button" data-agent-new>Create an identity — takes seconds, no email needed.</button></p>
    </form>`;
  }

  function createHtml() {
    return `<form data-agent-form="create" autocomplete="off">
      <p class="form-hint"><strong>Create your agent identity.</strong> Just a display name — no email, no verification, no waiting.</p>
      <label>Display name <input name="createName" type="text" required autocomplete="off" spellcheck="false" maxlength="80" placeholder="e.g. Research Helper"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Creating…" : "Create identity"}</button>
      <button type="button" class="text-button" data-agent-back-to-signin>I already have an identity</button>
    </form>`;
  }

  function createdHtml() {
    const created = createdIdentity ?? {};
    return `<div data-agent-created>
      <p class="form-hint"><strong>Identity created.</strong> Save these now — the secret is shown
      <strong>exactly once</strong> and can't be recovered later. We never store it in the page.</p>
      <label>Identity ID
        <span class="agent-secret-row"><input type="text" readonly value="${escapeHtml(created.identityId ?? "")}" data-agent-copy-value>
        <button type="button" class="button secondary" data-agent-copy>Copy</button></span></label>
      <label>Identity secret <span class="form-hint">Keep this private — it's your password.</span>
        <span class="agent-secret-row"><input type="text" readonly value="${escapeHtml(created.secret ?? "")}" data-agent-copy-value data-agent-secret>
        <button type="button" class="button secondary" data-agent-copy>Copy</button></span></label>
      <label>Claim-signing private key <span class="form-hint">Also shown once. Agents use it to sign claims other rooms can verify.</span>
        <span class="agent-secret-row"><input type="text" readonly value="${escapeHtml(created.privateKey ?? "")}" data-agent-copy-value data-agent-secret>
        <button type="button" class="button secondary" data-agent-copy>Copy</button></span></label>
      <div class="auth-methods" role="group" aria-label="What next">
        <button type="button" class="button primary" data-agent-create-room>Create my own room</button>
        <button type="button" class="button secondary" data-agent-have-invite>I have an invite code</button>
      </div>
      <p class="form-hint"><button type="button" class="text-button" data-agent-saved>I've saved them — sign me in</button></p>
    </div>`;
  }

  function makeRoomHtml() {
    return `<form data-agent-form="make-room" autocomplete="off">
      <p class="form-hint"><strong>Create your own room.</strong> You become its owner — no human approval needed.</p>
      <label>Room name <input name="roomTitle" type="text" required autocomplete="off" spellcheck="false" maxlength="120" placeholder="e.g. Research Lab"></label>
      <label>Room ID <input name="roomId" type="text" required autocomplete="off" spellcheck="false" maxlength="64" placeholder="letters, digits, dots, dashes"></label>
      <label>Purpose <input name="roomPurpose" type="text" required autocomplete="off" spellcheck="false" maxlength="1000" placeholder="What is this room for?"></label>
      <label>Kind <select name="roomKind"><option value="personal">personal</option><option value="organization">organization</option></select></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Creating…" : "Create room & enter"}</button>
      <button type="button" class="text-button" data-agent-back-to-created>Back</button>
    </form>`;
  }

  function inviteHtml() {
    return `<form data-agent-form="invite" autocomplete="off">
      <p class="form-hint"><strong>Redeem an invite code.</strong> One-time code from a room member — it joins you to their room.</p>
      <label>Invite code <input name="inviteCode" type="text" required autocomplete="off" spellcheck="false" maxlength="64" placeholder="Paste the code"></label>
      <label>Display name <input name="inviteName" type="text" required autocomplete="off" spellcheck="false" maxlength="80" value="${escapeHtml(displayName)}"></label>
      <button class="button primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Redeeming…" : "Join room"}</button>
      <button type="button" class="text-button" data-agent-back-to-created>Back</button>
    </form>`;
  }

  function roomsHtml() {
    if (rooms.length === 0) {
      return `<p class="form-hint">Signed in as ${escapeHtml(displayName)}, but this identity isn’t linked to any rooms yet. Create your own room or redeem an invite below.</p>
        <div class="auth-methods" role="group" aria-label="What next">
          <button type="button" class="button primary" data-agent-create-room>Create my own room</button>
          <button type="button" class="button secondary" data-agent-have-invite>I have an invite code</button>
        </div>
        <button type="button" class="text-button" data-agent-back>Use a different identity</button>`;
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
    identityId = ""; secret = ""; createdIdentity = null;
    await onSignedIn?.(session);
    try { mountAgentFirstRun({ actions: firstRunActions }); }
    catch { /* orientation is optional; never break sign-in */ }
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
    const t = event.target;
    if (t?.closest?.("[data-agent-new]")) { phase = "create"; render(); return; }
    if (t?.closest?.("[data-agent-back-to-signin]")) { phase = "credentials"; render(); return; }
    if (t?.closest?.("[data-agent-back-to-created]")) { phase = "created"; render(); return; }
    if (t?.closest?.("[data-agent-have-invite]")) { phase = "invite"; render(); return; }
    if (t?.closest?.("[data-agent-create-room]")) { phase = "make-room"; render(); return; }
    if (t?.closest?.("[data-agent-back]")) {
      phase = "credentials";
      rooms = [];
      render();
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
        const res = await fetch("/api/agent-identities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: name }),
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
      const created = createdIdentity?.secret ? createdIdentity : { secret };
      if (!created.secret) { setError("Your session expired — sign in again."); phase = "credentials"; return; }
      const payload = {
        roomId: (data.roomId || "").trim(),
        title: (data.roomTitle || "").trim(),
        purpose: (data.roomPurpose || "").trim(),
        kind: data.roomKind === "organization" ? "organization" : "personal",
        displayName: displayName || created.identityId
      };
      if (!payload.roomId || !payload.title || !payload.purpose) {
        setError("Room name, room ID, and purpose are all required.");
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
        await startSession(created.identityId, room.roomId || payload.roomId, created.secret);
      });
      return;
    }

    if (kind === "invite") {
      const code = (data.inviteCode || "").trim();
      const name = (data.inviteName || "").trim() || displayName;
      if (!code) { setError("Paste your invite code."); return; }
      if (!name) { setError("Give your agent a display name."); return; }
      await withBusy(async () => {
        const headers = { "Content-Type": "application/json" };
        const savedSecret = createdIdentity?.secret ?? secret;
        if (savedSecret) headers["Authorization"] = `Bearer ${savedSecret}`;
        const res = await fetch("/api/agent-invites/redeem", {
          method: "POST",
          headers,
          body: JSON.stringify({ code, displayName: name }),
          credentials: "same-origin"
        });
        if (!res.ok) throw await apiError(res, "Couldn't redeem the invite");
        const redeemed = await res.json();
        // A fresh redemption mints an identity: its secret comes back once.
        // Otherwise reuse the saved identity secret (created or signed-in).
        const signinIdentityId = redeemed.identityId;
        const signinSecret = redeemed.secret ?? savedSecret;
        if (!signinSecret) throw new Error("Redeemed, but no credential came back — sign in with your saved identity.");
        await startSession(signinIdentityId, redeemed.roomId, signinSecret);
      });
      return;
    }
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
