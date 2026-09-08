import { CHARTER_TYPE, CHARTER_FIELDS, charterContext, validateCharterData, confirmsCharter } from "./room-charter.js";
import { retryUnconfirmed } from "./client.js";

export function installRoomInstructions({ client, getState, onSaved }) {
  const $ = id => document.getElementById(id), dialog = $("room-instructions-dialog"), form = $("room-instructions-form"), open = $("room-instructions-open");
  const fields = Object.keys(CHARTER_FIELDS), controls = fields.map(key => form.elements.namedItem(key));
  let entry = null, readEpoch = 0;
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
    for (const id of ["room-instructions-view", "room-instructions-comparison", "room-instructions-version", "room-instructions-status"]) $(id).replaceChildren();
  }
  function render() {
    if (!getState() || !client.session) return reset();
    open.hidden = !owner() && current().revision === 0;
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
    $("room-instructions-close").disabled = e.busy;
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
    if (entry?.busy) return;
    dialog.close(); readEpoch++;
    if (!entry?.editing) entry = null;
    if (getState() && !open.hidden) open.focus();
  }
  $("room-instructions-close").addEventListener("click", close);
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  $("room-instructions-edit").addEventListener("click", edit);
  dialog.addEventListener("keydown", e => {
    if (e.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button,textarea")].filter(el => !el.disabled && !el.closest("[hidden]") && el.getClientRects().length);
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
