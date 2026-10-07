// Spend-pricing kill-switch UI (jill-spend-pricing-killswitch, audit item 10).
//
// The owner-only POST /api/rooms/:id/spend-pricing route existed with no UI
// to flip it. This module renders an owner-only emergency toggle and wires it
// to that route. Visibility is enforced here (non-owners get no markup at all)
// AND on the server (setSpendPricing 403s non-owners before parsing the body),
// so a compromised or stale client state can never grant the control.
//
// The current enabled flag comes from the SSE-carried projection
// (state.room.spendPricing, default enabled when absent) — no extra GET is
// needed. The flip is a two-step arm/confirm so it cannot be hit by accident.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

// Same owner rule as the spend-allowance controls in src/app.js: the room's
// human owner, not a member holding admin permissions.
export function isSpendPricingOwner({ session, state } = {}) {
  const memberId = session?.member?.id;
  if (!memberId || !state?.room) return false;
  return state.room.ownerId === memberId && state.members?.[memberId]?.kind === "human";
}

// Projection read: room.spend_pricing_set events land here via SSE; absent
// state means enabled (the pre-switch behaviour).
export function spendPricingViewOf(state) {
  const stored = state?.room?.spendPricing ?? null;
  return {
    enabled: stored?.enabled !== false,
    revision: stored?.revision ?? 0,
    setById: stored?.setById ?? null,
    setAt: stored?.setAt ?? null,
  };
}

let requestCounter = 0;
export function newRequestId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid) return uuid;
  requestCounter += 1;
  return `spend-pricing-${Date.now().toString(36)}-${requestCounter}`;
}

// POST the flip to the existing owner-gated route. Throws on 403/422 like any
// client.request call; the caller surfaces the message.
export async function flipSpendPricing({ client, roomId, enabled, requestId } = {}) {
  if (!client || typeof client.request !== "function") throw new Error("flipSpendPricing needs a client with request()");
  if (!roomId) throw new Error("flipSpendPricing needs a roomId");
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  return client.request(`/api/rooms/${encodeURIComponent(roomId)}/spend-pricing`, {
    method: "POST",
    data: { enabled, requestId: requestId ?? newRequestId() },
  });
}

export function killSwitchSectionHtml({ enabled, armed = false, busy = false, error = "", saved = false } = {}) {
  const action = enabled ? "disable" : "enable";
  const stateLine = enabled ? "Pricing is currently ENABLED." : "Pricing is currently DISABLED.";
  const status = error
    ? `<p class="status form-status" role="status">${escapeHtml(error)}</p>`
    : saved
      ? `<p class="status form-status" role="status">Saved. The room updates when the change arrives over the event stream.</p>`
      : "";
  const controls = armed
    ? `<p class="form-hint"><strong>This flips spend pricing for the whole room immediately.</strong> `
      + `When disabled, priced tools run free and no charges are recorded.</p>`
      + `<button type="button" class="button" data-spend-pricing="confirm"${busy ? " disabled" : ""}>Confirm: ${escapeHtml(action)} spend pricing</button> `
      + `<button type="button" class="text-button" data-spend-pricing="cancel"${busy ? " disabled" : ""}>Cancel</button>`
    : `<button type="button" class="text-button" data-spend-pricing="arm">${escapeHtml(action === "disable" ? "Disable" : "Enable")} spend pricing</button>`;
  return `<div class="spend-pricing-killswitch">`
    + `<h4>Emergency spend-pricing kill switch</h4>`
    + `<p class="form-hint">Owner only. The emergency brake for room spend: when pricing is disabled, `
    + `priced tools forward free and nothing is charged. Only flip this deliberately.</p>`
    + `<p class="form-hint">${escapeHtml(stateLine)}</p>`
    + status
    + `<div class="spend-pricing-actions">${controls}</div>`
    + `</div>`;
}

// Owns one mounted container: keeps the arm/confirm state and re-renders on
// every sync(). The server remains the real gate; this is visibility + UX.
export function createSpendPricingKillSwitch() {
  const bound = new WeakSet();
  const inst = {
    armed: false,
    busy: false,
    error: "",
    saved: false,
    latest: null,

    sync(container, { session, state, client, roomId } = {}) {
      if (!container) return "none";
      if (!isSpendPricingOwner({ session, state })) {
        // Never render the control for non-owners — not even hidden markup.
        inst.armed = false; inst.busy = false; inst.error = ""; inst.saved = false;
        container.hidden = true;
        container.innerHTML = "";
        return "hidden";
      }
      inst.latest = { session, state, client, roomId };
      container.hidden = false;
      inst.render(container);
      if (!bound.has(container)) {
        bound.add(container);
        container.addEventListener("click", event => inst.onClick(event));
      }
      return "shown";
    },

    render(container) {
      const view = spendPricingViewOf(inst.latest?.state);
      container.innerHTML = killSwitchSectionHtml({ enabled: view.enabled, armed: inst.armed, busy: inst.busy, error: inst.error, saved: inst.saved });
    },

    async onClick(event) {
      const action = event?.target?.closest?.("[data-spend-pricing]")?.dataset?.spendPricing;
      const container = event?.currentTarget;
      if (!action || !container || inst.busy) return;
      if (action === "arm") {
        inst.armed = true; inst.error = ""; inst.saved = false;
        inst.render(container);
        return;
      }
      if (action === "cancel") {
        inst.armed = false; inst.error = ""; inst.saved = false;
        inst.render(container);
        return;
      }
      if (action !== "confirm" || !inst.armed) return;
      const { client, roomId, state } = inst.latest ?? {};
      const view = spendPricingViewOf(state);
      inst.busy = true; inst.error = ""; inst.saved = false;
      inst.render(container);
      try {
        await flipSpendPricing({ client, roomId, enabled: !view.enabled });
        inst.armed = false; inst.saved = true;
      } catch (error) {
        // A 403 here means the viewer lost ownership between render and flip —
        // the server gate held. Show it, do not retry.
        inst.armed = false;
        inst.error = error?.message || "The flip failed. Try again.";
      } finally {
        inst.busy = false;
        inst.render(container);
      }
    },
  };
  return inst;
}
