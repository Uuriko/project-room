import { workPacket, packetMarkdown, parseWorkReturn, nativeWorkDraft, resultDraft, resultDraftText } from "./work-packet.js";
import { draftCommand, retryUnconfirmed } from "./client.js";
import { EVENT_TYPES as T } from "./events.js";
import { sendsOnEnter } from "./conversation.js";
import { workStatus, confirmsWorkReturn } from "./workflow.js";

export function installPortableWork({ client, getState, onSaved }) {
  const $ = id => document.getElementById(id);
  const dialog = $("portable-dialog");
  const drafts = new Map(); // Private memory only; cleared on identity loss.
  let entry = null, version = 0, pending = null, saving = false, copying = false, uncertain = false;
  const draftKey = ticket => (ticket.native ? "native:" : "return:") + ticket.workId;
  const owns = ticket => Boolean(ticket && entry === ticket && ticket.version === version && dialog.open && client.generation === ticket.generation
    && client.session === ticket.session && client.ownsAccountSession() && getState()?.room?.id === ticket.session.roomId);
  const status = text => { $("portable-status").textContent = text; $("portable-status").classList.toggle("visible", Boolean(text)); };
  function clearView() {
    // Closing a dialog or clearing identity cannot cancel an issued OS copy.
    // Retain its latch until settlement so a new prompt cannot race that write.
    version++; entry = null; pending = null; saving = uncertain = false;
    $("packet-preview").value = ""; $("portable-result").value = ""; $("portable-work-title").textContent = "";
    $("portable-source").checked = false; $("portable-older").checked = false; $("portable-older-label").hidden = true;
    status(""); dialog.close();
  }
  function reset() { drafts.clear(); clearView(); }
  function hasDraft() { return drafts.size > 0 || Boolean($("portable-result").value.trim()) || saving || uncertain; }
  function close() {
    if (saving) return;
    const opener = entry?.opener, focusKey = entry?.focusKey;
    if (entry && $("portable-result").value.trim()) drafts.set(draftKey(entry), {
      text: $("portable-result").value, pending, uncertain, older: $("portable-older").checked, showOlder: !$("portable-older-label").hidden,
      basisRevision: entry.basisRevision, packetOptions: entry.packetOptions
    });
    else if (entry) drafts.delete(draftKey(entry));
    clearView();
    const replacement = [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === focusKey);
    (opener?.isConnected ? opener : replacement)?.focus({ preventScroll: true });
  }
  function controls() {
    const current = getState()?.workItems?.[entry?.workId];
    const older = entry?.native && current && current.revision > entry.basisRevision;
    const unavailable = entry?.native && (!current || current.revision < entry.basisRevision);
    $("portable-close").disabled = saving;
    $("portable-submit").disabled = saving || !uncertain && Boolean(unavailable || older && !$("portable-older").checked);
    if (entry?.native && !uncertain) $("portable-older-label").hidden = !older;
    $("portable-result").readOnly = saving || uncertain;
    $("portable-older").disabled = saving || uncertain;
    $("portable-submit").textContent = uncertain ? "Retry draft" : "Post draft";
    $("packet-copy").disabled = copying || !$("packet-preview").value;
    $("packet-copy").textContent = copying ? "Copying…" : "Copy";
    $("portable-source").disabled = copying;
    $("portable-form").setAttribute("aria-busy", String(saving));
  }
  function preview() {
    try {
      const packet = workPacket(entry.state, entry.workId, { ...entry.packetOptions, includeSource: $("portable-source").checked });
      $("packet-preview").value = packetMarkdown(packet); $("packet-preview").scrollTop = 0; status("");
    } catch (error) { $("packet-preview").value = ""; status(error.message); }
    controls();
  }
  function mode(result) {
    $("portable-export").hidden = result; $("portable-form").hidden = !result;
    const native = entry?.native === true;
    $("portable-title").textContent = native ? "Share draft" : result ? "Paste AI draft" : "Use my AI";
    document.querySelector('label[for="portable-result"]').textContent = native ? "Your draft" : "Your AI’s answer";
    $("portable-result").maxLength = native ? 4000 : 16000;
    $("portable-result").rows = native ? 6 : 10;
    $("portable-result").placeholder = native ? "Share something useful…" : "Paste the full answer, including its ROOM-RETURN line…";
    status(result && uncertain ? "Save not confirmed. Retry the same draft." : ""); (result ? $("portable-result") : $("packet-copy")).focus();
  }
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-portable-work]");
    if (!button || dialog.open || !client.session || !client.ownsAccountSession() || saving) return;
    close();
    const state = getState(), workId = button.dataset.portableWork;
    if (!state || state.room.id !== client.session.roomId || !Object.hasOwn(state.workItems, workId)) return;
    entry = { version, generation: client.generation, session: client.session, state, workId, opener: button, focusKey: button.dataset.focusKey,
      native: button.dataset.portableMode === "draft", basisRevision: state.workItems[workId].revision,
      packetOptions: { packetId: crypto.randomUUID(), exportedAt: new Date().toISOString() } };
    const draft = drafts.get(draftKey(entry));
    if (draft) {
      $("portable-result").value = draft.text; pending = draft.pending; uncertain = draft.uncertain;
      $("portable-older").checked = draft.older; $("portable-older-label").hidden = !draft.showOlder;
      if (entry.native) { entry.basisRevision = draft.basisRevision; entry.packetOptions = draft.packetOptions; }
    }
    $("portable-work-title").textContent = state.workItems[workId].title;
    $("portable-source-label").hidden = !state.workItems[workId].sourceMessageId;
    controls(); if (!entry.native) preview(); dialog.showModal(); mode(entry.native || button.dataset.portableMode === "result");
  });
  $("portable-close").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  $("portable-source").addEventListener("change", preview);
  $("portable-older").addEventListener("change", controls);
  $("portable-add-result").addEventListener("click", () => mode(true));
  $("packet-copy").addEventListener("click", async () => {
    const ticket = entry;
    if (!owns(ticket) || copying || !$("packet-preview").value) return;
    copying = true; controls();
    try {
      await navigator.clipboard.writeText($("packet-preview").value);
      if (owns(ticket) && !$("portable-export").hidden) status("Copied. Paste into your AI.");
    } catch {
      if (owns(ticket) && !$("portable-export").hidden) { status("Select the prompt and copy it manually."); $("packet-preview").focus(); $("packet-preview").select(); }
    } finally {
      copying = false;
      // Release current controls without giving an old copy status authority.
      if (owns(entry)) controls();
    }
  });
  $("portable-result").addEventListener("keydown", event => {
    if (sendsOnEnter(event, window.matchMedia("(pointer: coarse)").matches)) { event.preventDefault(); $("portable-form").requestSubmit(); }
  });
  $("portable-form").addEventListener("submit", async event => {
    event.preventDefault();
    const ticket = entry;
    if (!owns(ticket) || saving) return;
    if (!uncertain) {
      let data;
      try {
        data = ticket.native
          ? nativeWorkDraft($("portable-result").value, { workItemId: ticket.workId, packetId: ticket.packetOptions.packetId, basisRevision: ticket.basisRevision })
          : parseWorkReturn($("portable-result").value, { roomId: ticket.session.roomId, workItemId: ticket.workId });
        if (ticket.native && getState()?.workItems?.[ticket.workId]?.revision > ticket.basisRevision && !$("portable-older").checked) {
          controls(); status("Work changed. Review before posting this older draft."); return;
        }
        if ($("portable-older").checked) data.allowOlderBasis = true;
      } catch (error) { status(error.message); return; }
      data.messageId = pending?.command.data.messageId ?? crypto.randomUUID();
      pending = draftCommand(pending, T.MESSAGE_POSTED, data);
    }
    const command = pending.command, focus = document.activeElement;
    saving = true; controls(); status("Saving…");
    try {
      const receipt = await client.send(command);
      if (!owns(ticket)) return;
      if (!confirmsWorkReturn(receipt, command, ticket.session.roomId, ticket.session.member.id)) throw new Error("Draft receipt could not be confirmed");
      saving = false; $("portable-result").value = ""; close(); onSaved(command.data.messageId);
    } catch (error) {
      if (!owns(ticket)) return;
      uncertain = retryUnconfirmed(error, uncertain);
      if (!uncertain && error.status === 409 && error.code === "command_rejected" && error.message.startsWith("Stale handoff:")) $("portable-older-label").hidden = false;
      status(uncertain ? "Save not confirmed. Retry the same draft." : error.message);
    } finally {
      if (owns(ticket)) {
        saving = false; controls();
        if (document.activeElement === document.body && focus?.isConnected && dialog.contains(focus)) {
          (uncertain ? $("portable-submit") : focus).focus({ preventScroll: true });
        }
      }
    }
  });
  function sync() {
    if (!entry) return;
    if (!owns(entry)) return reset();
    controls();
  }
  return { reset, hasDraft, sync };
}

// Independent from the prompt/return dialog: no command, receipt or durable draft.
export function installResultCopy({ client, getState }) {
  const $ = id => document.getElementById(id), dialog = $("result-copy-dialog"), input = $("result-copy-preview"), copy = $("result-copy-button");
  const drafts = new Map();
  let entry = null, epoch = 0, textRevision = 0, flight = null;
  const work = () => getState()?.workItems?.[entry?.workId];
  const basis = item => item ? JSON.stringify([item.revision, item.receipt?.eventId, item.receipt?.evidenceVersion]) : null;
  const owns = ticket => Boolean(ticket && ticket === entry && ticket.epoch === epoch && dialog.open
    && client.generation === ticket.generation && client.session === ticket.session && client.ownsAccountSession()
    && getState()?.room?.id === ticket.session.roomId);
  const dirty = () => Boolean(entry && input.value !== entry.initial);
  const status = text => { $("result-copy-status").textContent = text; $("result-copy-status").classList.toggle("visible", Boolean(text)); };
  const valid = () => Boolean(input.value.trim()) && input.value.length <= 16000;
  function controls() {
    const current = work(), older = Boolean(entry && basis(current) !== entry.basis);
    input.readOnly = Boolean(flight);
    $("result-copy-wait").hidden = !entry || !flight || flight.ticket === entry;
    copy.disabled = Boolean(flight) || !valid() || !current?.receipt;
    copy.textContent = older ? "Copy older draft" : "Copy";
    $("result-copy-fresh").hidden = !older || !current?.receipt;
    $("result-copy-fresh").disabled = Boolean(flight);
    $("result-copy-changed").hidden = !older;
    $("result-copy-changed").textContent = current?.receipt ? "Work changed. Your draft is unchanged." : "This result is no longer available.";
    dialog.setAttribute("aria-busy", String(Boolean(flight)));
  }
  function retire() {
    epoch++; entry = null; textRevision++;
    input.value = ""; $("result-copy-source").textContent = "";
    dialog.querySelector("details").open = false;
    status(""); dialog.close(); controls();
    // An issued system clipboard write cannot be cancelled. Keep its flight latch.
  }
  function reset() { drafts.clear(); retire(); }
  function close() {
    const previous = entry;
    if (entry) {
      if (dirty()) drafts.set(entry.workId, { initial: entry.initial, basis: entry.basis, source: entry.source, text: input.value });
      else drafts.delete(entry.workId);
    }
    retire();
    const retiredEpoch = epoch, focus = document.activeElement;
    requestAnimationFrame(() => {
      if (!previous || epoch !== retiredEpoch || dialog.open || client.generation !== previous.generation
        || client.session !== previous.session || !client.ownsAccountSession()
        || (document.activeElement !== focus && document.activeElement !== document.body)) return;
      const replacement = [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === previous.focusKey);
      const card = [...document.querySelectorAll("[data-work-record-id]")].find(node => node.dataset.workRecordId === previous.workId);
      const target = [previous.opener, replacement, card].find(node => node?.isConnected && !node.disabled
        && (node.checkVisibility?.() ?? Boolean(node.getClientRects().length)));
      target?.focus({ preventScroll: true });
    });
  }
  function seed(item) {
    input.value = resultDraftText(resultDraft(item));
    entry.initial = input.value; entry.basis = basis(item);
    entry.source = `Original work: ${workStatus(item).label} · revision ${item.revision}`;
    $("result-copy-source").textContent = entry.source;
    textRevision++; status(""); controls();
  }
  function sync() {
    if (!entry) return;
    if (!owns(entry)) return reset();
    const current = basis(work());
    if (current !== entry.observedBasis) { entry.observedBasis = current; status(""); }
    controls();
  }
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-copy-result]");
    if (!button || dialog.open || !client.session || !client.ownsAccountSession()) return;
    const state = getState(), workId = button.dataset.copyResult;
    if (!state || state.room.id !== client.session.roomId || !Object.hasOwn(state.workItems, workId)) return;
    const item = state.workItems[workId];
    try { resultDraft(item); } catch { return; }
    entry = { epoch, workId, generation: client.generation, session: client.session, opener: button, focusKey: button.dataset.focusKey, observedBasis: basis(item) };
    const draft = drafts.get(workId);
    if (draft) { Object.assign(entry, draft); input.value = draft.text; $("result-copy-source").textContent = draft.source; status(""); controls(); }
    else seed(item);
    dialog.showModal(); input.focus();
  });
  input.addEventListener("input", () => { textRevision++; status(""); controls(); });
  $("result-copy-close").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const nodes = [...dialog.querySelectorAll("button, textarea, summary")].filter(node => !node.disabled && node.getClientRects().length);
    const next = event.shiftKey ? nodes.at(-1) : nodes[0], edge = event.shiftKey ? nodes[0] : nodes.at(-1);
    if (document.activeElement === edge) { event.preventDefault(); next?.focus(); }
  });
  $("result-copy-fresh").addEventListener("click", () => {
    if (!owns(entry) || flight || !work()?.receipt) return;
    if (dirty() && !window.confirm("Replace your edits with the current reported result?")) return;
    try { seed(work()); drafts.delete(entry.workId); input.focus(); } catch (error) { status(error.message); }
  });
  copy.addEventListener("click", async () => {
    const ticket = entry, offeredOlder = copy.textContent === "Copy older draft";
    if (!owns(ticket) || flight) return;
    sync();
    if (copy.disabled || (basis(work()) !== ticket.basis && !offeredOlder)) return;
    const attempt = { ticket, text: input.value, revision: textRevision, basis: basis(work()), focus: document.activeElement };
    flight = attempt; controls(); status("Copying…");
    const current = () => owns(ticket) && textRevision === attempt.revision && input.value === attempt.text && basis(work()) === attempt.basis;
    try {
      await navigator.clipboard.writeText(attempt.text);
      if (current()) status("Copied. Paste where you choose.");
    } catch {
      if (current()) {
        status("Select the text and copy it manually.");
        if ([attempt.focus, document.body].includes(document.activeElement)) { input.focus(); input.select(); }
      }
    } finally {
      if (flight === attempt) flight = null;
      controls();
    }
  });
  return { reset, sync, hasDraft: () => drafts.size > 0 || dirty() };
}
