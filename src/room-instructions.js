import { CHARTER_TYPE, CHARTER_FIELDS, charterContext, validateCharterData, confirmsCharter } from "./room-charter.js";
import { retryUnconfirmed } from "./client.js";
import { EVENT_TYPES as T, roomPolicy } from "./events.js";

// Room review policy (issue #6 A4 follow-up): the owner sets it here instead of
// by hand-written command; everyone else sees the policy in force, read only.
// One select covers the four states; Apply sends the existing room.policy_set
// command, so the server rule and the locked new-work checkboxes are unchanged.
const POLICY_OPTIONS = Object.freeze({ none: [false, false], review: [true, false], decision: [false, true], both: [true, true] });
const POLICY_LABELS = Object.freeze({
  none: "Nothing extra is required: each proposer chooses whether an outcome needs independent review or an owner decision.",
  review: "Independent review is required for every new outcome.",
  decision: "An owner decision is required for every new outcome.",
  both: "Independent review and an owner decision are required for every new outcome."
});
export function policyKey(policy) {
  return policy.requireIndependentReview ? (policy.requireOwnerDecision ? "both" : "review") : policy.requireOwnerDecision ? "decision" : "none";
}
export function policyCommand(key) {
  if (!POLICY_OPTIONS[key]) throw new Error("Choose a review policy");
  // The review-policy UI manages only the two review gates; openJoin
  // (Uuriko/project-room#612) is toggled elsewhere and must not be clobbered
  // by mapping the two-element option tuples over all ROOM_POLICY_FIELDS.
  const [requireIndependentReview, requireOwnerDecision] = POLICY_OPTIONS[key];
  return { id: crypto.randomUUID(), type: T.ROOM_POLICY_SET, data: { requireIndependentReview, requireOwnerDecision } };
}

export function installRoomInstructions({ client, getState, onSaved }) {
  const $ = id => document.getElementById(id), dialog = $("room-instructions-dialog"), form = $("room-instructions-form"), open = $("room-instructions-open");
  const fields = Object.keys(CHARTER_FIELDS), controls = fields.map(key => form.elements.namedItem(key));
  let entry = null, readEpoch = 0;
  const policyUI = { select: $("room-policy-select"), apply: $("room-policy-apply"), dirty: false, busy: false, pending: null, status: "" };
  const currentPolicy = () => policyKey(roomPolicy(getState()));
  const current = () => charterContext(getState()?.room);
  const owns = e => e && e === entry && e.session === client.session && e.generation === client.generation && client.ownsAccountSession() && getState();
  const owner = () => { const s = getState(), m = s?.members[client.session?.member.id]; return m?.active === true && m.kind === "human" && m.id === s.room.ownerId; };
  const same = (a, b) => a.revision === b.revision && a.eventId === b.eventId;
  const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const values = () => Object.fromEntries(fields.map(key => [key, form.elements.namedItem(key).value || null]));
  const setFields = c => controls.forEach((el, i) => { el.value = c?.[fields[i]] ?? ""; });
  function content(target, c) {
    const el = $(target); el.replaceChildren();
    if (!c?.purpose) { el.textContent = "No instructions yet."; return; }
    for (const key of fields) if (c[key] !== null) { const h = document.createElement("h3"), p = document.createElement("p"); h.textContent = CHARTER_FIELDS[key]; p.textContent = c[key]; el.append(h, p); }
  }
  function reset() {
    entry = null; readEpoch++; dialog.close(); form.reset(); open.hidden = true;
    Object.assign(policyUI, { dirty: false, busy: false, pending: null, status: "" }); $("room-policy").hidden = true;
    for (const id of ["room-instructions-view", "room-instructions-comparison", "room-instructions-version", "room-instructions-status", "room-policy-current", "room-policy-help", "room-policy-status"]) $(id).replaceChildren();
  }
  function renderPolicy() {
    const state = getState(), key = currentPolicy(), stored = state.room.policy, isOwner = owner();
    $("room-policy").hidden = false; $("room-policy-owner").hidden = !isOwner;
    const setBy = stored?.revision ? ` Set by ${state.members[stored.setById]?.displayName ?? "the room owner"} (version ${stored.revision}).` : "";
    text("room-policy-current", `${POLICY_LABELS[key]}${setBy}`);
    text("room-policy-help", isOwner
      ? "Applies to outcomes proposed from now on; earlier work keeps its recorded requirements. Proposers see the requirement locked on with the reason."
      : "Only the room owner can change this.");
    if (isOwner) {
      if (!policyUI.dirty && !policyUI.busy) policyUI.select.value = key;
      policyUI.select.disabled = policyUI.busy || Boolean(entry?.busy);
      policyUI.apply.disabled = policyUI.busy || Boolean(entry?.busy) || policyUI.select.value === key;
      policyUI.apply.textContent = policyUI.busy ? "Applying…" : "Apply policy";
    }
    text("room-policy-status", policyUI.status);
  }
  function render() {
    if (!getState() || !client.session) return reset();
    open.hidden = !owner() && current().revision === 0 && currentPolicy() === "none";
    renderPolicy();
    open.textContent = entry?.uncertain ? "Instructions · confirm save" : current().revision ? "Room instructions" : "Add instructions";
    if (!entry) return;
    if (!owns(entry)) return reset();
    const e = entry, changed = !same(e.base, current()), editing = e.editing && owner();
    form.hidden = !editing; $("room-instructions-view").hidden = editing;
    $("room-instructions-save").hidden = !editing;
    $("room-instructions-edit").hidden = !owner() || e.editing || !same(e.base, current());
    $("room-instructions-previous").hidden = e.editing || e.base.revision === 0;
    $("room-instructions-latest").hidden = !e.latest || !editing;
    $("room-instructions-refresh").hidden = e.uncertain || !(changed || e.needsReview || e.base.revision < current().revision);
    $("room-instructions-refresh").disabled = e.busy;
    $("room-instructions-previous").disabled = e.busy;
    $("room-instructions-edit").disabled = e.busy;
    for (const el of controls) el.disabled = e.uncertain || e.busy;
    $("room-instructions-save").disabled = e.busy || !e.uncertain && (changed || e.needsReview || Boolean(e.latest));
    $("room-instructions-save").textContent = e.uncertain ? "Retry original save" : "Save";
    $("room-instructions-close").disabled = e.busy || policyUI.busy;
    for (const id of ["instructions-use-latest", "instructions-keep-draft"]) $(id).disabled = e.busy;
    text("room-instructions-version", e.base.revision ? `Version ${e.base.revision} · ${getState().members[e.base.charter.updatedById]?.displayName ?? "Room owner"}` : "Not set");
    const status = e.busy ? "Working…" : e.uncertain ? "Save not confirmed. Retry the original before making changes."
      : e.readError || (e.latest ? `Review version ${e.latest.revision} above before choosing which text to save.`
      : changed || e.needsReview ? "Instructions changed. Review latest; your draft is kept." : e.status ?? "");
    text("room-instructions-status", status);
  }
  function newEntry() { return { session: client.session, generation: client.generation, base: current(), editing: false, busy: false }; }
  function edit() { if (!owner() || !entry || entry.busy) return; entry.editing = true; setFields(entry.base.charter); render(); controls[0].focus(); }
  open.addEventListener("click", () => {
    if (!entry || !owns(entry)) entry = newEntry();
    content("room-instructions-view", entry.base.charter); render(); dialog.showModal();
    if (owner() && entry.base.revision === 0 && !entry.editing) edit();
    else (entry.editing ? controls[0].disabled ? $("room-instructions-save") : controls[0] : $("room-instructions-close")).focus();
  });
  function close() {
    if (entry?.busy || policyUI.busy) return;
    dialog.close(); readEpoch++;
    Object.assign(policyUI, { dirty: false, pending: null, status: "" });
    if (!entry?.editing) entry = null;
    if (getState() && !open.hidden) open.focus();
  }
  $("room-instructions-close").addEventListener("click", close);
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  $("room-instructions-edit").addEventListener("click", edit);
  dialog.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button,textarea,select")].filter(el => !el.disabled && !el.closest("[hidden]") && el.getClientRects().length);
    if (!focusable.length) { e.preventDefault(); return; }
    if (e.shiftKey && document.activeElement === focusable[0]) { e.preventDefault(); focusable.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === focusable.at(-1)) { e.preventDefault(); focusable[0].focus(); }
  });
  async function read(revision, compare = false) {
    const e = entry, epoch = ++readEpoch; if (!owns(e) || e.busy || e.uncertain) return;
    e.busy = true; e.readError = ""; render();
    try {
      const value = await client.charter(revision);
      if (!owns(e) || epoch !== readEpoch || !value) return;
      if (compare) { await client.refresh(); if (!owns(e) || epoch !== readEpoch) return; }
      const selected = { authority: value.authority, revision: value.revision, eventId: value.eventId, charter: value.charter };
      if (compare && e.editing) { e.latest = selected; content("room-instructions-comparison", selected.charter); }
      else { e.base = selected; content("room-instructions-view", selected.charter); }
      e.needsReview = false; e.status = "";
    } catch { if (owns(e) && epoch === readEpoch) e.readError = "Could not load instructions. Try again."; }
    finally { if (owns(e) && epoch === readEpoch) { e.busy = false; render(); $("room-instructions-close").focus(); } }
  }
  $("room-instructions-previous").addEventListener("click", () => read(entry.base.revision - 1));
  $("room-instructions-refresh").addEventListener("click", () => read(undefined, true));
  function chooseLatest(keep) {
    const e = entry; if (!owns(e) || !e.latest || e.busy || e.uncertain) return;
    if (!keep) setFields(e.latest.charter);
    e.base = e.latest; e.latest = null; e.pending = null; e.needsReview = false;
    e.status = "Review your text, then Save."; render(); controls[0].focus();
  }
  $("instructions-use-latest").addEventListener("click", () => chooseLatest(false));
  policyUI.select.addEventListener("change", () => {
    if (!getState()) return;
    policyUI.dirty = policyUI.select.value !== currentPolicy(); policyUI.status = ""; render();
  });
  policyUI.apply.addEventListener("click", async () => {
    const e = entry, key = policyUI.select.value;
    if (!owns(e) || !owner() || policyUI.busy || e.busy || key === currentPolicy()) return;
    // Keep the same command id across network retries so a committed change is not doubled.
    if (policyUI.pending?.key !== key) policyUI.pending = { key, command: policyCommand(key) };
    policyUI.busy = true; policyUI.status = ""; render();
    try {
      const receipt = await client.send(policyUI.pending.command);
      if (!owns(e)) return;
      const currentVerified = client.sequence >= receipt.sequence;
      policyUI.pending = null; policyUI.dirty = !currentVerified;
      policyUI.status = currentVerified ? "Review policy saved." : "Review policy saved. Refresh to see the current version.";
    } catch (error) {
      if (!owns(e)) return;
      if (!retryUnconfirmed(error)) policyUI.pending = null;
      policyUI.status = `Review policy not saved. ${error.message || "Try again."}`;
    } finally {
      if (owns(e)) { policyUI.busy = false; render(); if (dialog.open) policyUI.select.focus(); }
    }
  });
  $("instructions-keep-draft").addEventListener("click", () => chooseLatest(true));
  form.addEventListener("submit", async event => {
    event.preventDefault(); const e = entry;
    if (!owns(e) || !owner() || e.busy || !e.editing || !e.uncertain && (!same(e.base, current()) || e.needsReview || e.latest)) return;
    if (!e.pending) {
      try { const data = validateCharterData({ expectedRevision: e.base.revision, ...values() });
        if (data.purpose === null && e.base.charter?.purpose && !window.confirm("Remove these instructions? Earlier versions remain available.")) return;
        e.pending = { id: crypto.randomUUID(), type: CHARTER_TYPE, data };
      } catch (error) { e.status = error.message; render(); return; }
    }
    const original = e.pending; e.busy = true; render();
    try {
      const receipt = await client.send(original);
      if (!owns(e)) return;
      const confirmed = await confirmsCharter(receipt, original, e.session.roomId, e.session.member.id);
      if (!owns(e)) return;
      if (!confirmed) { e.uncertain = true; return; }
      const currentVerified = client.sequence >= receipt.sequence;
      entry = null; dialog.close(); form.reset(); content("room-instructions-view", null); content("room-instructions-comparison", null);
      onSaved(currentVerified ? "Instructions saved." : "Instructions saved. Refresh to see the current version.");
      open.focus();
    } catch (error) {
      if (!owns(e)) return;
      e.uncertain = retryUnconfirmed(error, e.uncertain);
      if (!e.uncertain) { e.pending = null; e.needsReview = error.status === 409; e.status = error.message; }
    } finally { if (owns(e)) e.busy = false; render(); }
  });
  return { sync: render, reset, hasUnknown: () => Boolean(entry?.uncertain), hasPending: () => Boolean(entry?.editing && (entry.pending || controls.some((el, i) => el.value !== (entry.base.charter?.[fields[i]] ?? "")))) };
}
