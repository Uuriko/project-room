import { canReplyToResult } from "./result-availability.js";
import { uiText } from "./strings.js";
import { WORK_STATES as S, isRoomArchived } from "./events.js";
import { matchesReceipt } from "./workflow.js";
import { currentResult } from "./work-selectors.js";

// Owns only the pinned reader view. Session, composer, and work mutations stay
// with their controllers; asynchronous responses must still own this view.
export function installResultReader({ client, getState, getSession, sameSession,
  isBusy, canDiscuss, memberLabel, workRecord, focusRecord,
  clearResultComparison, loadResultComparison, onDiscuss, onOriginal }) {
  const $ = selector => document.querySelector(selector);
  let resultView = null;
  const resultReader = $("#result-dialog"), resultParking = resultReader.parentElement;
  const resultElement = id => id === "result-dialog" ? resultReader : resultReader.querySelector(`#${id}`);
  function usableText(view) {
    return view && view === resultView && view.loaded && !view.withdrawn && !view.error
      && sameSession(view.generation, view.roomId, view.memberId)
      && !getState().messages.find(message => message.id === view.textMessageId)?.deletedAt;
  }
  function mountResultReader() {
    if (!resultView) return;
    const host = resultView.fromResults
      ? [...$("#room-results-list").querySelectorAll("[data-result-work-id]")].find(node => node.dataset.resultWorkId === resultView.workItemId) ?? $("#results-panel")
      : workRecord(resultView.workItemId);
    if (host && resultReader.parentElement !== host) host.append(resultReader);
  }
  function preserveResultFocus(container, render) {
    const focus = resultView && container.contains(resultReader) && resultReader.contains(document.activeElement) ? document.activeElement : null;
    render();
    if (resultView) mountResultReader();
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  }
  function resultDiscussionMessage(view) {
    if (!view?.loaded || view.withdrawn || view.error || !sameSession(view.generation, view.roomId, view.memberId)
      || isRoomArchived(getState())) return null;
    // The ordinary thread composer does not inherit a DM audience.
    return getState().messages.find(message => canReplyToResult(getState(), message) && message.id === view.textMessageId && message.workItemId === view.workItemId
      && message.body === view.body);
  }
  function needsConversation(view) {
    return Boolean(usableText(view) && !isRoomArchived(getState()) && client.owesHistory
      && !getState().messages.some(message => message.id === view.textMessageId));
  }
  function resultStatus() {
    mountResultReader();
    const view = resultView;
    if (!view || !sameSession(view.generation, view.roomId, view.memberId)) return;
    const focused = resultReader.contains(document.activeElement) ? document.activeElement : null;
    const textMessage = getState().messages.find(message => message.id === view.textMessageId);
    if (textMessage?.deletedAt) view.withdrawn = { by: textMessage.deletedBy, at: textMessage.deletedAt };
    if (view.withdrawn) {
      view.body = "";
      resultElement("result-body").textContent = "";
      resultElement("result-body").hidden = true;
      resultElement("result-original").hidden = true;
      resultElement("result-use-status").textContent = "";
      clearResultComparison(resultElement("result-diff"));
    }
    const item = getState().workItems[view.workItemId];
    const earlier = !matchesReceipt(view.receipt, item?.receipt) || item?.state !== S.COMPLETED || Boolean(item?.supersededBy);
    resultElement("result-status").textContent = (earlier ? "Earlier result · " : "") + (view.error ? "Exact text unavailable. Retry this result or close."
      : view.withdrawn ? `Text withdrawn by ${memberLabel(view.withdrawn.by)} · reported by ${memberLabel(view.reportedById)}`
      : view.loaded ? `Submitted by ${memberLabel(view.reportedById)} · exact stored text` : "Loading exact text…");
    const retry = resultElement("result-retry");
    resultElement("result-discuss").hidden = !resultDiscussionMessage(view) && !needsConversation(view);
    resultElement("result-discuss").disabled = !canDiscuss() || Boolean(view.resolving);
    retry.hidden = !view.error && !view.retrying;
    retry.disabled = !view.error;
    for (const action of ["result-copy-text", "result-download"]) {
      resultElement(action).hidden = !usableText(view);
      resultElement(action).disabled = action === "result-copy-text" && Boolean(view.copying);
    }
    if (focused && (!focused.getClientRects().length || focused.disabled)) resultElement("close-result").focus({ preventScroll: true });
    if (resultReader.contains(document.activeElement)) document.activeElement.scrollIntoView({ block: "nearest" });
  }
  function closeResult(restore = true) {
    const view = resultView;
    resultView = null; resultReader.hidden = true; resultParking.append(resultReader); resultElement("result-title").textContent = "Result";
    resultElement("result-status").textContent = ""; resultElement("result-body").textContent = ""; resultElement("result-body").hidden = false;
    resultElement("result-original").hidden = true; resultElement("result-retry").hidden = true; resultElement("result-retry").disabled = true;
    resultElement("result-discuss").hidden = true;
    resultElement("result-use-status").textContent = "";
    resultElement("result-copy-text").hidden = true;
    resultElement("result-download").hidden = true;
    clearResultComparison(resultElement("result-diff"));
    if (restore && view && sameSession(view.generation, view.roomId, view.memberId)) {
      if (view.fromResults) {
        const row = [...$("#room-results-list").querySelectorAll("[data-result-work-id]")].find(node => node.dataset.resultWorkId === view.workItemId);
        (row?.querySelector("[data-read-result]") || ($("#settings-dialog").classList.contains("results-only") ? $("#room-results-list") : $("#results-panel > summary"))).focus({ preventScroll: true });
        return;
      }
      const card = workRecord(view.workItemId); focusRecord(card?.querySelector("[data-read-result]") || card);
    }
  }
  resultElement("close-result").addEventListener("click", () => closeResult());
  resultElement("result-copy-text").textContent = uiText("result.copyText");
  resultElement("result-download").textContent = uiText("result.download");
  resultElement("result-copy-text").addEventListener("click", async () => {
    const view = resultView;
    if (!usableText(view) || view.copying) return;
    view.copying = true; resultStatus();
    resultElement("result-use-status").textContent = "";
    try {
      let timer;
      try {
        await Promise.race([navigator.clipboard.writeText(view.body), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error()), 1500);
        })]);
      } finally { clearTimeout(timer); }
      if (usableText(view)) resultElement("result-use-status").textContent = uiText("result.copied");
    } catch {
      if (usableText(view)) resultElement("result-use-status").textContent = uiText("result.copyFailed");
    } finally {
      view.copying = false;
      if (resultView === view) resultStatus();
    }
  });
  resultElement("result-download").addEventListener("click", () => {
    const view = resultView;
    if (!usableText(view)) return;
    const url = URL.createObjectURL(new Blob([view.body], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "result.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  resultElement("result-discuss").textContent = uiText("result.discuss");
  resultElement("result-discuss").addEventListener("click", async () => {
    const view = resultView;
    if (!view || view.resolving || !canDiscuss()) return;
    if (needsConversation(view)) {
      view.resolving = true; resultStatus();
      resultElement("result-use-status").textContent = uiText("result.loadingConversation");
      try {
        await client.refresh(null, { fill: true });
      } catch {
        if (usableText(view)) resultElement("result-use-status").textContent = uiText("result.conversationUnavailable");
        return;
      } finally {
        view.resolving = false;
        if (resultView === view) resultStatus();
      }
    }
    if (resultView !== view || !usableText(view) || !canDiscuss()) return;
    const message = resultDiscussionMessage(view);
    if (!message) { resultElement("result-use-status").textContent = uiText("result.conversationUnavailable"); return; }
    resultElement("result-use-status").textContent = "";
    if (onDiscuss(message) === false) return;
    closeResult(false);
  });
  resultElement("result-original").addEventListener("click", () => {
    const view = resultView;
    if (!view?.loaded || isBusy() || !sameSession(view.generation, view.roomId, view.memberId)
      || !getState().messages.some(message => message.id === view.originalId && message.workItemId === view.workItemId)) return;
    closeResult(false);
    onOriginal(view.originalId);
  });
  resultReader.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeResult(); }
  });
  function loadExactResult(view) {
    const owns = () => resultView === view && sameSession(view.generation, view.roomId, view.memberId);
    client.workResult(view.workItemId, { completionEventId: view.receipt.completionEventId }).then(value => {
      if (!owns()) return;
      if (value?.result?.receipt?.eventId !== view.receipt.completionEventId
        || value.result.receipt.evidenceVersion !== view.receipt.evidenceVersion) throw new Error("Pinned version changed");
      // Text taken out of the room is served as an absence, so say so rather
      // than showing an empty box: the result was still reported and verified,
      // and the receipt still names what it was verified against.
      view.withdrawn = value.result.text.withdrawnAt ? { by: value.result.text.withdrawnBy, at: value.result.text.withdrawnAt } : null;
      resultElement("result-body").textContent = view.withdrawn ? "" : value.result.text.body;
      resultElement("result-body").hidden = Boolean(view.withdrawn);
      const message = getState().messages.find(message => message.id === value.result.text.messageId && message.workItemId === view.workItemId
        && message.body === value.result.text.body);
      view.discussionId = message?.id; view.body = value.result.text.body;
      view.textMessageId = value.result.text.messageId;
      const original = getState().messages.find(original => original.id === message?.replyToId && original.workItemId === view.workItemId && original.proposal);
      view.originalId = original?.id; resultElement("result-original").hidden = !original;
      view.loaded = true; view.retrying = false;
      if (document.activeElement === resultElement("result-retry")) resultElement("close-result").focus({ preventScroll: true });
      resultStatus();
      if (!view.withdrawn) loadResultComparison(view.workItemId, view.previousCompletionEventId, value.result.text,
        resultElement("result-diff"), () => owns() && !view.withdrawn);
    }).catch(() => { if (owns()) { view.error = true; view.retrying = false; resultStatus(); } });
  }
  resultElement("result-retry").addEventListener("click", () => {
    const view = resultView;
    if (!view?.error || isBusy() || !sameSession(view.generation, view.roomId, view.memberId)) return;
    if (document.activeElement === resultElement("result-retry")) resultElement("close-result").focus({ preventScroll: true });
    view.error = false; view.retrying = true; resultStatus();
    loadExactResult(view);
  });
  function readResult(e) {
    const read = e.target.closest("[data-read-result]");
    if (read && getState() && !isBusy()) {
      const item = getState().workItems[read.dataset.readResult], receipt = item?.receipt;
      if (!receipt?.nativeText) return true;
      const fromResults = Boolean(read.closest("#room-results-list"));
      if (fromResults && !currentResult(item)) return true;
      const view = { generation: client.generation, roomId: getSession().roomId, memberId: getSession().member.id, workItemId: item.id,
        fromResults, previousCompletionEventId: receipt.nativeText.previousCompletionEventId, receipt: { completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion }, reportedById: receipt.reportedById }; resultView = view;
      resultElement("result-title").textContent = item.title; resultElement("result-status").textContent = "Loading exact text…"; resultElement("result-body").textContent = ""; resultElement("result-body").hidden = false;
      resultElement("result-original").hidden = true;
      resultElement("result-discuss").hidden = true;
      resultElement("result-copy-text").hidden = true;
      resultElement("result-download").hidden = true;
      resultElement("result-use-status").textContent = "";
      const diffBox = resultElement("result-diff"); diffBox.hidden = true; diffBox.innerHTML = "";
      resultElement("result-retry").hidden = true; resultElement("result-retry").disabled = true;
      mountResultReader(); resultReader.hidden = false;
      resultElement("result-title").focus();
      loadExactResult(view);
      return true;
    }
    return false;
  }

  new MutationObserver(() => { if (resultView && $("#main").hidden) closeResult(false); })
    .observe($("#main"), { attributes: true, attributeFilter: ["hidden"] });
  return { close: closeResult, sync: resultStatus, preserveFocus: preserveResultFocus, read: readResult };
}
