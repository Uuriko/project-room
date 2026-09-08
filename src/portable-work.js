import { workPacket, packetMarkdown, parseWorkReturn } from "./work-packet.js";
import { draftCommand } from "./client.js";
import { EVENT_TYPES as T } from "./events.js";
import { sendsOnEnter } from "./conversation.js";

export function installPortableWork({ client, getState, onSaved }) {
  const $ = id => document.getElementById(id);
  const dialog = $("portable-dialog");
  const drafts = new Map(); // Private memory only; cleared on identity loss.
  let entry = null, version = 0, pending = null, saving = false, copying = false, uncertain = false;
  const owns = ticket => Boolean(ticket && entry === ticket && ticket.version === version && client.generation === ticket.generation
    && client.session === ticket.session && client.ownsAccountSession());
  const status = text => { $("portable-status").textContent = text; $("portable-status").classList.toggle("visible", Boolean(text)); };
  function clearView() {
    version++; entry = null; pending = null; saving = copying = uncertain = false;
    $("packet-preview").value = ""; $("portable-result").value = ""; $("portable-work-title").textContent = "";
    $("portable-source").checked = false; $("portable-older").checked = false; $("portable-older-label").hidden = true;
    status(""); dialog.close();
  }
  function reset() { drafts.clear(); clearView(); }
  function hasDraft() { return drafts.size > 0 || Boolean($("portable-result").value.trim()) || saving || uncertain; }
  function close() {
    if (saving) return;
    const opener = entry?.opener, focusKey = entry?.focusKey;
    if (entry && $("portable-result").value.trim()) drafts.set(entry.workId, {
      text: $("portable-result").value, pending, uncertain, older: $("portable-older").checked, showOlder: !$("portable-older-label").hidden
    });
    else if (entry) drafts.delete(entry.workId);
    clearView();
    const replacement = [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === focusKey);
    (opener?.isConnected ? opener : replacement)?.focus({ preventScroll: true });
  }
  function controls() {
    $("portable-close").disabled = saving;
    $("portable-submit").disabled = saving;
    $("portable-result").readOnly = saving || uncertain;
    $("portable-older").disabled = saving || uncertain;
    $("portable-submit").textContent = uncertain ? "Retry proposal" : "Post proposal";
    $("packet-copy").disabled = copying;
    $("portable-source").disabled = copying;
    $("portable-add-result").disabled = copying;
    $("portable-form").setAttribute("aria-busy", String(saving));
  }
  function preview() {
    try {
      const packet = workPacket(entry.state, entry.workId, { ...entry.packetOptions, includeSource: $("portable-source").checked });
      $("packet-preview").value = packetMarkdown(packet); status(""); $("packet-copy").disabled = false;
    } catch (error) { $("packet-preview").value = ""; $("packet-copy").disabled = true; status(error.message); }
  }
  function mode(result) {
    $("portable-export").hidden = result; $("portable-form").hidden = !result;
    $("portable-title").textContent = result ? "Add result" : "Use my AI";
    status(result && uncertain ? "Save not confirmed. Retry the same proposal." : ""); (result ? $("portable-result") : $("packet-copy")).focus();
  }
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-portable-work]");
    if (!button || !client.session || !client.ownsAccountSession() || saving) return;
    close();
    const state = getState(), workId = button.dataset.portableWork;
    if (!state || !Object.hasOwn(state.workItems, workId)) return;
    entry = { version, generation: client.generation, session: client.session, state, workId, opener: button, focusKey: button.dataset.focusKey,
      packetOptions: { packetId: crypto.randomUUID(), exportedAt: new Date().toISOString() } };
    const draft = drafts.get(workId);
    if (draft) {
      $("portable-result").value = draft.text; pending = draft.pending; uncertain = draft.uncertain;
      $("portable-older").checked = draft.older; $("portable-older-label").hidden = !draft.showOlder;
    }
    $("portable-work-title").textContent = state.workItems[workId].title;
    $("portable-source-label").hidden = !state.workItems[workId].sourceMessageId;
    controls(); preview(); dialog.showModal(); mode(button.dataset.portableMode === "result");
  });
  $("portable-close").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  $("portable-source").addEventListener("change", preview);
  $("portable-add-result").addEventListener("click", () => mode(true));
  $("packet-copy").addEventListener("click", async () => {
    const ticket = entry;
    if (!owns(ticket) || copying || !$("packet-preview").value) return;
    copying = true; controls();
    try {
      await navigator.clipboard.writeText($("packet-preview").value);
      if (owns(ticket)) status("Copied. Paste into your AI.");
    } catch {
      if (owns(ticket)) { status("Select the prompt and copy it manually."); $("packet-preview").focus(); $("packet-preview").select(); }
    } finally { if (owns(ticket)) { copying = false; controls(); } }
  });
  $("portable-result").addEventListener("keydown", event => {
    if (sendsOnEnter(event, window.matchMedia("(pointer: coarse)").matches)) { event.preventDefault(); $("portable-form").requestSubmit(); }
  });
  $("portable-form").addEventListener("submit", async event => {
    event.preventDefault();
    const ticket = entry;
    if (!owns(ticket) || saving) return;
    let data;
    try {
      data = parseWorkReturn($("portable-result").value, { roomId: ticket.session.roomId, workItemId: ticket.workId });
      if ($("portable-older").checked) data.allowOlderBasis = true;
    } catch (error) { status(error.message); return; }
    if (!uncertain) pending = draftCommand(pending, T.MESSAGE_POSTED, data);
    saving = true; controls(); status("Saving…");
    try {
      await client.send(pending.command);
      if (!owns(ticket)) return;
      saving = false; $("portable-result").value = ""; close(); onSaved("Proposal added. Work status is unchanged.");
    } catch (error) {
      if (!owns(ticket)) return;
      uncertain = !Number.isSafeInteger(error.status) || error.status >= 500;
      if (error.status === 409 && error.message.startsWith("Stale handoff:")) $("portable-older-label").hidden = false;
      status(uncertain ? "Save not confirmed. Retry the same proposal." : error.message);
    } finally { if (owns(ticket)) { saving = false; controls(); } }
  });
  return { reset, hasDraft };
}
