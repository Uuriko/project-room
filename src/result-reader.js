import { exactResultHref } from "./room-deep-link.js";
import { clipboard } from "./clipboard.js";
import { canReplyToResult } from "./result-availability.js";
import { uiText } from "./strings.js";
import { WORK_STATES as S, isRoomArchived } from "./events.js";
import { matchesReceipt, nextWorkStep, workActions, reviewRuntimeLabel } from "./workflow.js";
import { currentResult } from "./work-selectors.js";

// Owns only the pinned reader view. Session, composer, and work mutations stay
// with their controllers; asynchronous responses must still own this view.
export function installResultReader({ client, getState, getSession, sameSession,
  isBusy, canDiscuss, memberLabel, workRecord, focusRecord,
  clearResultComparison, loadResultComparison, discussionMessage, loadDiscussion,
  onDiscuss, onOriginal, onWorkAction, onReturn, storage = null, recoveryScope = () => null }) {
  const $ = selector => document.querySelector(selector);
  let resultView = null, pointerSelection = null;
  const resultReader = $("#result-dialog"), resultParking = resultReader.parentElement;
  const wide = matchMedia("(min-width: 1100px)");
  const savedKey = "project-room:result-selection:v1";
  const selectionLifetime = 12 * 60 * 60 * 1000;
  const resize = $("#result-resize"), shell = $("#main");
  const widthKey = "project-room:preview-width:v1";
  let previewWidth = 340, dragging = null;
  try {
    const stored = Number(storage?.getItem(widthKey));
    if (Number.isFinite(stored) && stored >= 280 && stored <= 1600) previewWidth = stored;
  } catch { /* Width is a preference; storage is optional. */ }
  const widthLimit = () => Math.max(280, shell.clientWidth - 192 - 420);
  function applyWidth() {
    const value = Math.round(Math.max(280, Math.min(widthLimit(), previewWidth)));
    shell.style.setProperty("--result-width", `${value}px`);
    resize.setAttribute("aria-valuemin", "280");
    resize.setAttribute("aria-valuemax", String(Math.round(widthLimit())));
    resize.setAttribute("aria-valuenow", String(value));
  }
  function rememberWidth() {
    try { storage?.setItem(widthKey, String(previewWidth)); } catch { /* Optional preference. */ }
  }
  resize.setAttribute("aria-label", uiText("result.resize"));
  resize.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !wide.matches || !resultView) return;
    event.preventDefault();
    dragging = event.pointerId;
    resize.setPointerCapture(event.pointerId);
    shell.classList.add("preview-resizing");
  });
  resize.addEventListener("pointermove", event => {
    if (dragging !== event.pointerId) return;
    previewWidth = Math.max(280, Math.min(widthLimit(), shell.getBoundingClientRect().right - event.clientX));
    applyWidth();
  });
  const finishResize = () => {
    if (dragging === null) return;
    const pointer = dragging; dragging = null;
    if (resize.hasPointerCapture(pointer)) resize.releasePointerCapture(pointer);
    shell.classList.remove("preview-resizing");
    rememberWidth();
  };
  resize.addEventListener("pointerup", finishResize);
  resize.addEventListener("pointercancel", finishResize);
  resize.addEventListener("lostpointercapture", finishResize);
  resize.addEventListener("keydown", event => {
    const step = event.shiftKey ? 80 : 20;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    previewWidth = event.key === "Home" ? 280 : event.key === "End" ? widthLimit()
      : Math.max(280, Math.min(widthLimit(), Number(resize.getAttribute("aria-valuenow")) + (event.key === "ArrowLeft" ? step : -step)));
    applyWidth(); rememberWidth();
  });
  new ResizeObserver(applyWidth).observe(shell);
  function forgetSelection() { try { storage?.removeItem(savedKey); } catch { /* Reading works without storage. */ } }
  function saveSelection(view) {
    try {
      const scope = recoveryScope();
      if (!scope) return;
      storage?.setItem(savedKey, JSON.stringify({ scope, expires: Date.now() + selectionLifetime,
        workItemId: view.workItemId, receipt: view.receipt }));
    } catch { forgetSelection(); }
  }
  $("#result-options > summary").setAttribute("aria-label", uiText("result.previewActions"));
  const resultElement = id => id === "result-dialog" ? resultReader : resultReader.querySelector(`#${id}`);
  function showCorrection(correction, pending = false) {
    resultElement("result-correction-title").textContent = uiText(pending ? "result.pendingCorrection" : "result.previousReview");
    const text = typeof correction?.summary === "string" ? correction.summary : "";
    resultElement("result-correction-summary").textContent = text;
    resultElement("result-correction").hidden = !text;
  }
  function usableText(view) {
    return view && view === resultView && view.loaded && !view.withdrawn && !view.error
      && sameSession(view.generation, view.roomId, view.memberId)
      && !getState().messages.find(message => message.id === view.textMessageId)?.deletedAt;
  }
  function mountResultReader() {
    if (!resultView) return;
    const focused = resultView.focused === true;
    const docked = !focused && wide.matches;
    resultReader.classList.toggle("result-focused", focused);
    const checks = resultElement("result-release-checks");
    const checksBefore = resultElement(focused ? "result-work-context" : "result-work-action");
    if (checks.nextElementSibling !== checksBefore) checksBefore.before(checks);
    resultReader.classList.toggle("result-docked", docked);
    resultReader.classList.toggle("result-mobile", !docked && !focused);
    resultElement("close-result").hidden = focused;
    resize.hidden = !docked;
    applyWidth();
    const host = focused ? shell.querySelector(".room-main") : shell;
    if (host && resultReader.parentElement !== host) {
      const focused = resultReader.contains(document.activeElement) ? document.activeElement : null;
      host.append(resultReader);
      focused?.focus({ preventScroll: true });
    }
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
    const message = discussionMessage(view.textMessageId);
    return canReplyToResult(getState(), message) && message.workItemId === view.workItemId && message.body === view.body
      ? message : null;
  }
  function needsConversation(view) {
    return Boolean(usableText(view) && view.textMessageId && !isRoomArchived(getState()) && client.owesHistory
      && !discussionMessage(view.textMessageId));
  }
  // During a release, a cached page may lack the new reader controls.
  function selectedWorkAction(view, item) {
    if (!usableText(view) || !item || !matchesReceipt(view.receipt, item.receipt) || item.supersededBy) return null;
    const state = getState(), next = nextWorkStep(item, Date.now(), state.room.ownerId);
    const expected = next.action === "revise" && view.pendingCorrection?.action?.arguments.expectedRevision === item.revision
      ? "resolve" : next.action;
    if (!["verify", "decide", "resolve"].includes(expected)) return null;
    return workActions(item, state.members[getSession().member.id]).find(([action]) => action === expected) ?? null;
  }
  resultElement("result-work-action")?.addEventListener("click", () => {
    const view = resultView, item = view && getState()?.workItems[view.workItemId];
    const action = selectedWorkAction(view, item);
    if (action && !isBusy()) onWorkAction(item, action[0]);
  });
  const releaseLink = resultElement("result-release-link"), releasePanel = resultElement("result-release-checks");
  if (releaseLink && releasePanel) {
    releaseLink.textContent = uiText("result.releaseChecks");
    resultElement("result-release-title").textContent = uiText("result.releaseChecks");
    releaseLink.addEventListener("click", event => {
      event.preventDefault();
      releasePanel.hidden = !releasePanel.hidden;
      releaseLink.setAttribute("aria-expanded", String(!releasePanel.hidden));
      if (!releasePanel.hidden) resultElement("result-release-title").focus();
    });
  }
  function releaseEvidenceLink(href, label) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    if (resultView?.focused) { link.target = "_blank"; link.rel = "noopener"; }
    else link.addEventListener("click", () => closeResult(false));
    return link;
  }
  function showResultBody(text) {
    const body = resultElement("result-body");
    body.replaceChildren();
    // Keep exact text for copy, comparison, and passage selection. Only
    // canonical GitHub file links at a full commit SHA become navigable.
    const sourceLink = /(?<!\S)https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/blob\/[a-f0-9]{40}\/[a-z0-9_.%+~/-]+(?:#L[1-9]\d*(?:-L[1-9]\d*)?)?(?=$|\s)/gi;
    let offset = 0;
    for (const match of text.matchAll(sourceLink)) {
      const href = match[0];
      if (new URL(href).href !== href) continue;
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = href;
      body.append(text.slice(offset, match.index), link);
      offset = match.index + href.length;
    }
    body.append(text.slice(offset));
  }
  function showReleaseChecks(report) {
    if (!releaseLink || !releasePanel) return;
    const focused = resultView?.focused === true;
    releaseLink.hidden = !report || focused;
    releaseLink.setAttribute("aria-expanded", String(Boolean(focused && report)));
    releasePanel.hidden = !report || !focused;
    const list = resultElement("result-release-stages");
    list.replaceChildren();
    if (!report) return;
    resultElement("result-release-candidate").textContent = uiText("result.releaseCandidate", { revision: report.candidateRevision });
    for (const check of report.checks) {
      const row = document.createElement("li"), title = document.createElement("strong");
      title.textContent = uiText("result.releaseStage", { stage: uiText(`result.release.${check.stage}`), status: uiText(`result.release.${check.status}`) });
      row.dataset.status = check.status;
      let evidence = row;
      if (focused && (check.summary || check.evidenceDigest || check.href)) {
        evidence = document.createElement("details");
        const summary = document.createElement("summary");
        summary.append(title);
        evidence.append(summary);
        row.append(evidence);
      } else row.append(title);
      if (check.summary) { const summary = document.createElement("p"); summary.textContent = check.summary; evidence.append(summary); }
      if (check.evidenceDigest) { const digest = document.createElement("code"); digest.textContent = check.evidenceDigest; evidence.append(digest); }
      if (check.href) {
        evidence.append(" ", releaseEvidenceLink(check.href, uiText("result.releaseStageEvidence", { stage: uiText(`result.release.${check.stage}`) })));
      }
      list.append(row);
    }
    const source = resultElement("result-release-source");
    const note = releaseEvidenceLink(`#pr-record/message/${encodeURIComponent(report.messageId)}`, uiText("result.releaseRecord"));
    source.replaceChildren(document.createTextNode(uiText("result.releaseReporter", { name: memberLabel(report.reportedById) })), " ", note);
  }
  function resultStatus() {
    mountResultReader();
    const view = resultView;
    if (!view || !sameSession(view.generation, view.roomId, view.memberId)) return;
    resultElement("close-result").textContent = wide.matches ? "×" : uiText("result.backConversation");
    resultElement("close-result").setAttribute("aria-label", uiText(wide.matches ? "result.closePreview" : "result.backConversation"));
    if (!clipboard.busy && resultElement("result-use-status").textContent === uiText("clipboard.pending")) resultElement("result-use-status").textContent = "";
    if (clipboard.busy && !view.copying) resultElement("result-use-status").textContent = uiText("clipboard.pending");
    const focused = resultReader.contains(document.activeElement) ? document.activeElement : null;
    const textMessage = getState().messages.find(message => message.id === view.textMessageId);
    if (textMessage?.deletedAt) view.withdrawn = { by: textMessage.deletedBy, at: textMessage.deletedAt };
    if (view.withdrawn) {
      pointerSelection = null;
      view.body = "";
      if (view.linked) resultElement("result-title").textContent = "Result";
      showCorrection(null);
      showReleaseChecks(null);
      resultElement("result-body").textContent = "";
      resultElement("result-body").hidden = true;
      resultElement("result-original").hidden = true;
      resultElement("result-use-status").textContent = "";
      clearResultComparison(resultElement("result-diff"));
    }
    const item = getState().workItems[view.workItemId];
    const pending = !view.withdrawn && view.pendingCorrection && view.pendingCorrection.revision === item?.revision
      && view.pendingCorrection.verificationEventId === item?.blocker?.eventId ? view.pendingCorrection : null;
    showCorrection(view.withdrawn ? null : pending ?? view.previousCorrection, Boolean(pending));
    const earlier = item ? !matchesReceipt(view.receipt, item.receipt) || (!pending && item.state !== S.COMPLETED) || Boolean(item.supersededBy)
      : view.selectionStatus === "historical";
    resultElement("result-status").textContent = (earlier ? "Earlier result · " : "") + (view.error ? "Exact text unavailable. Retry this result or close."
      : view.withdrawn ? `Text withdrawn by ${memberLabel(view.withdrawn.by)} · reported by ${memberLabel(view.reportedById)}`
      : view.loaded ? `Submitted by ${memberLabel(view.reportedById)}` : "Loading exact text…");
    if (view.releaseChecks && getState().messages.some(message => (message.deletedAt || message.editedAt)
      && (message.id === view.releaseChecks.messageId || view.releaseChecks.checks.some(check => check.evidenceMessageId === message.id || check.reportMessageId === message.id)))) {
      view.releaseChecks = null;
      showReleaseChecks(null);
    }
    if (!earlier && view.loaded && !view.error && !view.withdrawn && item && !item.verification) {
      const runtime = reviewRuntimeLabel(view.reviewRuntime?.status, view.reviewRuntime?.webhook);
      if (runtime) resultElement("result-status").append(uiText("review.runtime.statusSuffix", {status: runtime}));
    }
    const context = resultElement("result-work-context");
    const current = view.loaded && !view.error && !view.withdrawn && !earlier;
    if (context) context.hidden = !current || !item;
    const verdict = resultElement("result-verdict");
    // A bounded snapshot can drop the selected work while its exact result
    // remains open. The server-confirmed verdict still belongs to that result.
    const finding = current && item && matchesReceipt(item.verification, item.receipt) ? item.verification
      : view.linked || (current && !item) ? view.selectedVerdict : null;
    verdict.hidden = !view.focused || (!current && !(view.linked && finding && usableText(view)));
    if (!verdict.hidden) {
      verdict.dataset.outcome = finding?.result ?? "pending";
      verdict.textContent = finding
        ? `Verification · ${finding.result === "pass" ? "Passed" : finding.result === "fail" ? "Failed" : "Recorded"}`
        : "Verification · Pending";
    }
    if (current && context && item) {
      const next = nextWorkStep(item, Date.now(), getState().room.ownerId);
      resultElement("result-work-criteria").textContent = item.definitionOfDone;
      resultElement("result-work-verification").textContent = finding?.summary ?? "";
      resultElement("result-work-verification-row").hidden = Boolean(pending) || !finding?.summary;
      const nextLabel = pending?.nextAction ?? next.label;
      resultElement("result-work-next").textContent = next.memberId
        ? uiText("work.thread.nextFor", { name: memberLabel(next.memberId), action: nextLabel })
        : nextLabel;
    }
    const workAction = resultElement("result-work-action");
    const action = current && item && selectedWorkAction(view, item);
    if (workAction) {
      workAction.hidden = !action;
      workAction.disabled = isBusy();
      workAction.textContent = action?.[1] ?? "";
    }
    const retry = resultElement("result-retry");
    resultElement("result-discuss").hidden = !resultDiscussionMessage(view) && !needsConversation(view);
    resultElement("result-discuss").disabled = !canDiscuss() || Boolean(view.resolving);
    retry.hidden = !view.error && !view.retrying;
    retry.disabled = !view.error;
    for (const action of ["result-copy-link", "result-copy-text", "result-download"]) {
      resultElement(action).hidden = !usableText(view);
      resultElement(action).disabled = action !== "result-download" && Boolean(view.copying || clipboard.busy);
    }
    if (focused && (!focused.getClientRects().length || focused.disabled)) resultElement(view.focused ? "result-title" : "close-result").focus({ preventScroll: true });
    if (resultReader.contains(document.activeElement)) document.activeElement.scrollIntoView({ block: "nearest" });
  }
  function closeResult(restore = true, preserveSaved = false) {
    pointerSelection = null;
    if (!preserveSaved) forgetSelection();
    const view = resultView;
    finishResize();
    resultView = null; resultReader.classList.remove("result-docked", "result-mobile", "result-focused"); resultReader.hidden = true; resultParking.append(resultReader); resultElement("result-title").textContent = "Result";
    showCorrection(null);
    showReleaseChecks(null);
    resultElement("result-verdict").hidden = true;
    resultElement("result-work-context")?.setAttribute("hidden", "");
    resultElement("result-work-action")?.setAttribute("hidden", "");
    resultElement("result-status").textContent = ""; resultElement("result-body").textContent = ""; resultElement("result-body").hidden = false;
    resultElement("result-original").hidden = true; resultElement("result-retry").hidden = true; resultElement("result-retry").disabled = true;
    resultElement("result-discuss").hidden = true;
    resultElement("result-use-status").textContent = "";
    resultElement("result-copy-link").hidden = true;
    resultElement("result-copy-text").hidden = true;
    resultElement("result-download").hidden = true;
    clearResultComparison(resultElement("result-diff"));
    if (restore && view && sameSession(view.generation, view.roomId, view.memberId)) {
      if (view.fromResults) {
        const row = [...$("#room-results-list").querySelectorAll("[data-result-work-id]")].find(node => node.dataset.resultWorkId === view.workItemId);
        (row?.querySelector("[data-read-result]") || $("#room-results-list")).focus({ preventScroll: true });
        return;
      }
      const card = workRecord(view.workItemId);
      if (view.restoreDetails && card?.querySelector(".work-details")) card.querySelector(".work-details").open = true;
      if (card) focusRecord(card.querySelector("[data-read-result]") || card);
      else $("#message-input").focus();
    }
  }
  resultElement("close-result").addEventListener("click", () => closeResult());
  resultElement("result-copy-link").textContent = uiText("result.copyLink");
  resultElement("result-copy-text").textContent = uiText("result.copyText");
  resultElement("result-download").textContent = uiText("result.download");
  async function copyResult(link) {
    const view = resultView;
    if (!usableText(view) || view.copying || clipboard.busy) return;
    const text = link ? exactResultHref({ ...view, completionEventId: view.receipt.completionEventId }) : view.body;
    if (!text) return;
    view.copying = true; resultStatus();
    resultElement("result-use-status").textContent = "";
    try {
      const outcome = await clipboard.copy(text);
      if (outcome === "failed") throw new Error("clipboard_failed");
      if (usableText(view)) resultElement("result-use-status").textContent = uiText(outcome === "copied" ? (link ? "result.linkCopied" : "result.copied") : "clipboard.pending");
    } catch {
      if (usableText(view)) resultElement("result-use-status").textContent = uiText(link ? "result.copyLinkFailed" : "result.copyFailed");
    } finally {
      view.copying = false;
      if (resultView === view) resultStatus();
    }
  }
  resultElement("result-copy-link").addEventListener("click", () => copyResult(true));
  resultElement("result-copy-text").addEventListener("click", () => copyResult(false));
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
  function selectedPassage() {
    const view = resultView, body = resultElement("result-body"), selection = window.getSelection();
    if (!usableText(view) || !selection?.rangeCount || selection.isCollapsed || body.textContent !== view.body) return null;
    const range = selection.getRangeAt(0);
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(body);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    return { body: view.body, start, end: start + range.toString().length };
  }
  // Pointer focus may collapse a text selection before click is dispatched.
  resultElement("result-discuss").addEventListener("pointerdown", () => {
    pointerSelection = { view: resultView, selection: selectedPassage() };
  });
  resultElement("result-discuss").addEventListener("pointercancel", () => { pointerSelection = null; });
  resultElement("result-discuss").addEventListener("click", async event => {
    const view = resultView;
    const selection = event.detail && pointerSelection?.view === view ? pointerSelection.selection : selectedPassage();
    pointerSelection = null;
    if (!view || view.resolving || !canDiscuss()) return;
    if (needsConversation(view)) {
      view.resolving = true; resultStatus();
      resultElement("result-use-status").textContent = uiText("result.loadingConversation");
      try {
        if (!await loadDiscussion(view.textMessageId)) {
          if (resultView === view && usableText(view)) resultElement("result-use-status").textContent = uiText("result.conversationUnavailable");
          return;
        }
      } catch {
        if (resultView === view && usableText(view)) resultElement("result-use-status").textContent = uiText("result.conversationUnavailable");
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
    if (onDiscuss(message, selection) === false) return;
    if (!view.focused && wide.matches && resultView === view) {
      view.fromResults = false;
      saveSelection(view);
      resultStatus();
    } else closeResult(false);
    $("#message-input").focus({ preventScroll: true });
  });
  resultElement("result-original").addEventListener("click", () => {
    const view = resultView;
    if (!view?.loaded || isBusy() || !sameSession(view.generation, view.roomId, view.memberId)
      || !getState().messages.some(message => message.id === view.originalId && message.workItemId === view.workItemId)) return;
    closeResult(false);
    onOriginal(view.originalId);
  });
  resultReader.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (resultView?.focused) onReturn(); else closeResult(); }
  });
  function loadExactResult(view) {
    const owns = () => resultView === view && sameSession(view.generation, view.roomId, view.memberId);
    client.workResult(view.workItemId, { completionEventId: view.receipt.completionEventId }).then(value => {
      if (!owns()) return;
      if (value?.result?.receipt?.eventId !== view.receipt.completionEventId
        || (view.receipt.evidenceVersion && value.result.receipt.evidenceVersion !== view.receipt.evidenceVersion)) throw new Error("Pinned version changed");
      view.receipt.evidenceVersion = value.result.receipt.evidenceVersion;
      view.selectionStatus = value.selection.status;
      view.selectedVerdict = matchesReceipt(value.workThread?.verdict, value.result.receipt) ? value.workThread.verdict : null;
      if (view.linked && !value.result.text.withdrawnAt) {
        resultElement("result-title").textContent = getState().workItems[view.workItemId]?.title ?? "Result";
      }
      view.reportedById = value.result.receipt.reportedById;
      view.reviewRuntime = value.reviewRuntime;
      view.previousCompletionEventId = value.result.receipt.nativeText?.previousCompletionEventId;
      // Text taken out of the room is served as an absence, so say so rather
      // than showing an empty box: the result was still reported and verified,
      // and the receipt still names what it was verified against.
      view.withdrawn = value.result.text.withdrawnAt ? { by: value.result.text.withdrawnBy, at: value.result.text.withdrawnAt } : null;
      view.previousCorrection = value.workThread?.correction;
      view.pendingCorrection = value.workThread?.pendingCorrection
        ? { ...value.workThread.pendingCorrection, revision: value.current.workRevision }
        : null;
      view.releaseChecks = value.workThread?.releaseChecks;
      showReleaseChecks(view.withdrawn ? null : view.releaseChecks);
      showResultBody(view.withdrawn ? "" : value.result.text.body);
      resultElement("result-body").hidden = Boolean(view.withdrawn);
      const message = getState().messages.find(message => message.id === value.result.text.messageId && message.workItemId === view.workItemId
        && message.body === value.result.text.body);
      // Ordinary answers already have an authorized, readable conversation
      // message. Keep saved historical selections in the exact-version reader.
      const item = getState().workItems[view.workItemId];
      const currentFirstResult = !view.previousCompletionEventId && item?.state === S.COMPLETED
        && !item.supersededBy && matchesReceipt(view.receipt, item.receipt);
      if (message && currentFirstResult && !view.withdrawn && !view.recovered && !view.focused && value.result.text.body.length <= 1200) {
        closeResult(false);
        onOriginal(message.id);
        return;
      }
      view.discussionId = message?.id; view.body = value.result.text.body;
      view.textMessageId = value.result.text.messageId;
      const original = getState().messages.find(original => original.id === message?.replyToId && original.workItemId === view.workItemId && original.proposal);
      view.originalId = original?.id; resultElement("result-original").hidden = !original;
      view.loaded = true; view.retrying = false;
      if (document.activeElement === resultElement("result-retry")) resultElement(view.focused ? "result-title" : "close-result").focus({ preventScroll: true });
      resultStatus();
      if (!view.withdrawn) loadResultComparison(view.workItemId, view.previousCompletionEventId, value.result.text,
        resultElement("result-diff"), () => owns() && !view.withdrawn);
    }).catch(() => { if (owns()) { view.error = true; view.retrying = false; resultStatus(); } });
  }
  resultElement("result-retry").addEventListener("click", () => {
    const view = resultView;
    if (!view?.error || isBusy() || !sameSession(view.generation, view.roomId, view.memberId)) return;
    if (document.activeElement === resultElement("result-retry")) resultElement(view.focused ? "result-title" : "close-result").focus({ preventScroll: true });
    view.error = false; view.retrying = true; resultStatus();
    loadExactResult(view);
  });
  function openResult(view, title, focus = true) {
      resultView = view;
      resultElement("result-verdict").hidden = true;
      showCorrection(null);
      showReleaseChecks(null);
      resultElement("result-work-context")?.setAttribute("hidden", "");
      resultElement("result-work-action")?.setAttribute("hidden", "");
      resultElement("result-options").open = false;
      resultElement("result-title").textContent = title; resultElement("result-status").textContent = "Loading exact text…"; resultElement("result-body").textContent = ""; resultElement("result-body").hidden = false;
      resultElement("result-original").hidden = true;
      resultElement("result-discuss").hidden = true;
      resultElement("result-copy-link").hidden = true;
      resultElement("result-copy-text").hidden = true;
      resultElement("result-download").hidden = true;
      resultElement("result-use-status").textContent = "";
      const diffBox = resultElement("result-diff"); diffBox.hidden = true; diffBox.innerHTML = "";
      resultElement("result-retry").hidden = true; resultElement("result-retry").disabled = true;
      if (view.restoreDetails) workRecord(view.workItemId).querySelector(".work-details").open = false;
      mountResultReader(); resultReader.hidden = false;
      if (focus) resultElement("result-title").focus();
      loadExactResult(view);
  }
  function restoreSelection() {
    if (resultView || !getState() || !getSession()) return;
    try {
      const raw = storage?.getItem(savedKey);
      if (!raw) return;
      if (raw.length > 4096) throw new Error("oversized selection");
      const saved = JSON.parse(raw), now = Date.now();
      const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 512;
      if (!recoveryScope() || saved.scope !== recoveryScope()
        || !Number.isFinite(saved.expires) || saved.expires <= now || saved.expires > now + selectionLifetime
        || !identifier(saved.workItemId) || !identifier(saved.receipt?.completionEventId)
        || !identifier(saved.receipt?.evidenceVersion)) throw new Error("invalid selection");
      const item = getState().workItems[saved.workItemId];
      if (!item) { forgetSelection(); return; }
      openResult({ generation: client.generation, roomId: getSession().roomId, memberId: getSession().member.id,
        workItemId: item.id, receipt: { completionEventId: saved.receipt.completionEventId, evidenceVersion: saved.receipt.evidenceVersion },
        fromResults: false, restoreDetails: false, recovered: true }, item.title, false);
    } catch { forgetSelection(); }
  }
  function readResult(e, { focused = false } = {}) {
    const read = e.target.closest("[data-read-result]");
    if (read && getState() && !isBusy()) {
      const item = getState().workItems[read.dataset.readResult], receipt = item?.receipt;
      const compact = receipt && typeof receipt.summary !== "string" && !receipt.evidenceUrl && receipt.eventId && receipt.evidenceVersion;
      if (!receipt?.nativeText && !compact) return true;
      const fromResults = Boolean(read.closest("#room-results-list"));
      if (fromResults && !currentResult(item)) return true;
      const view = { focused, generation: client.generation, roomId: getSession().roomId, memberId: getSession().member.id, workItemId: item.id,
        fromResults, restoreDetails: !fromResults && Boolean(workRecord(item.id)?.querySelector(".work-details")?.open), previousCompletionEventId: receipt.nativeText?.previousCompletionEventId, receipt: { completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion }, reportedById: receipt.reportedById };
      // Details are the entry path, not a second toolbar above the open result.
      // Restore them only when closing back to the originating control.
      forgetSelection();
      saveSelection(view);
      openResult(view, item.title);
      return true;
    }
    return false;
  }

  function openLinked({ roomId, workItemId, completionEventId }) {
    const session = getSession();
    if (!session || session.roomId !== roomId) return;
    if (resultView?.linked && resultView.roomId === roomId && resultView.workItemId === workItemId
      && resultView.receipt.completionEventId === completionEventId) return;
    forgetSelection();
    openResult({ linked: true, focused: true, generation: client.generation, roomId,
      memberId: session.member.id, workItemId, receipt: { completionEventId } }, "Result");
  }
  function closeLinked() {
    if (resultView?.linked) closeResult(false);
  }

  new MutationObserver(() => { if (resultView && $("#main").hidden) closeResult(false); })
    .observe($("#main"), { attributes: true, attributeFilter: ["hidden"] });
  wide.addEventListener("change", resultStatus);
  clipboard.subscribe(resultStatus);
  return { close: closeResult, sync: resultStatus, preserveFocus: preserveResultFocus, read: readResult, restore: restoreSelection, openLinked, closeLinked };
}
