import { exactResultHref } from "./room-deep-link.js";
import { uiText } from "./strings.js";

export function previousReviewText(correction) {
  const summary = correction?.summary;
  if (typeof summary !== "string" || !summary) return "";
  const instruction = correction.nextAction?.trim();
  return instruction && instruction !== summary.trim()
    ? uiText("result.feedbackWithInstruction", { summary, instruction }) : summary;
}

// Show only the changed passages and their surrounding lines. Full versions
// stay accessible through the exact result links even if a rewrite is large.
function comparisonHtml(before, after, esc, structuredPatch, fromOpened) {
  const heading = summary => [
    '<p class="form-hint"><strong>', esc(uiText(fromOpened ? "result.openedRevisionHeading" : "result.revisionHeading")), "</strong> ", esc(summary), "</p>",
  ].join("");
  const patch = structuredPatch("", "", before, after, "", "", { context: 3, maxEditLength: 800 });
  if (!patch) return heading(uiText("result.rewrite"));
  if (!patch.hunks.length) return heading(uiText(fromOpened ? "result.sameOpenedText" : "result.sameRevisionText"));

  let removed = 0, added = 0, total = 0;
  const visible = [];
  for (const hunk of patch.hunks) {
    if (total < 200) visible.push(esc(uiText("result.revisionRange", { before: hunk.oldStart, after: hunk.newStart })));
    for (const line of hunk.lines) {
      if (line.startsWith("-")) removed++;
      if (line.startsWith("+")) added++;
      if (++total <= 200) {
        const kind = line.startsWith("-") ? "removed" : line.startsWith("+") ? "added" : "same";
        const display = kind === "same" ? line : [line[0], line.slice(1)].join(" ");
        visible.push(['<span class="diff-', kind, '">', esc(display), "</span>"].join(""));
      }
    }
  }
  if (total > 200) visible.push(esc(uiText("result.remainingPatchRows", { count: total - 200 })));
  return [heading(uiText("result.comparisonSummary", { removed, added })),
    '<pre class="result-diff">', visible.join("\n"), '</pre>'].join("");
}

// A comparison owns its pending read until cleared, replaced or invalidated.
export function createResultComparison({ client, getState, esc }) {
  // Both reading and reviewing compare the same pinned completion versions.
  // Each caller owns its dialog/session lifetime; late reads cannot fill a new view.
  const resultComparisons = new Map();
  function clearResultComparison(box) {
    resultComparisons.delete(box);
    box.hidden = true; box.replaceChildren();
  }
  function syncResultComparisons() {
    for (const [box, comparison] of resultComparisons) {
      if (!comparison.owns()) { clearResultComparison(box); continue; }
      const deleted = id => id && getState()?.messages.some(message => message.id === id && message.deletedAt);
      if (deleted(comparison.correctionSourceId)) box.querySelector(".result-correction")?.remove();
      if (deleted(comparison.currentId)) {
        clearResultComparison(box);
        box.textContent = uiText("result.comparisonWithdrawn"); box.hidden = false;
      } else if (!comparison.withdrawn && deleted(comparison.previousId)) {
        comparison.withdrawn = true;
        comparison.content.textContent = uiText("result.comparisonWithdrawn");
        box.hidden = false;
      } else if (comparison.evidenceIds && getState()?.messages.some(message =>
        (message.deletedAt || message.editedAt) && comparison.evidenceIds.has(message.id))) {
        box.querySelector("[data-previous-release-checks]")?.remove();
        comparison.evidenceIds = null;
      }
    }
  }
  function loadResultComparison(workItemId, predecessorId, text, box, owns, correction, compareFrom) {
    clearResultComparison(box);
    if (!predecessorId) return;
    const previousId = compareFrom || predecessorId;
    const content = document.createElement("div");
    box.append(content);
    const comparison = { currentId: text.messageId, previousId: null, owns, content, correctionSourceId: correction?.sourceMessageId };
    if (!text.withdrawnAt && correction?.completionEventId === predecessorId && typeof correction.summary === "string" && correction.summary) {
      const note = document.createElement("p"), label = document.createElement("strong");
      label.textContent = uiText("result.previousReview");
      note.className = "result-correction";
      note.append(label, " ", previousReviewText(correction));
      box.prepend(note);
      box.hidden = false;
    }
    resultComparisons.set(box, comparison);
    syncResultComparisons();
    const current = () => !comparison.withdrawn && owns() && resultComparisons.get(box) === comparison;
    Promise.all([client.workResult(workItemId, { completionEventId: previousId }), import("./vendor-jsdiff-patch.js")])
      .then(([previous, { structuredPatch }]) => {
      if (!current()) return;
      if (!previous) throw new Error("previous_result_unavailable");
      comparison.previousId = previous.result?.text?.messageId;
      syncResultComparisons();
      if (!current()) return;
      if (previous.result?.receipt?.eventId !== previousId) throw new Error("Pinned previous version changed");
      const before = previous.result?.text?.body;
      if (previous.result?.text?.withdrawnAt || text.withdrawnAt) {
        content.innerHTML = `<p class="form-hint"><strong>Resubmitted result.</strong> ${
          previous.result?.text?.withdrawnAt ? "The previous version's text has been withdrawn, so the two cannot be compared."
            : "This version's text has been withdrawn, so the two cannot be compared."
        } Previous approval never carries over.</p>`;
        box.hidden = false;
        return;
      }
      if (typeof before !== "string") throw new Error("Previous version has no exact text");
      content.innerHTML = comparisonHtml(before, text.body, esc, structuredPatch, previousId !== predecessorId);
      const earlierLink = exactResultHref({ roomId: previous.roomId, workItemId, completionEventId: previousId });
      if (earlierLink) {
        const paragraph = document.createElement("p");
        const link = document.createElement("a");
        link.href = earlierLink;
        link.textContent = uiText("result.openEarlier");
        paragraph.append(link);
        content.append(paragraph);
      }
      const report = previous.workThread?.releaseChecks;
      if (report?.completionEventId === previousId && typeof report.evidenceVersion === "string" && report.evidenceVersion.length > 0
        && report.evidenceVersion === previous.result.receipt.evidenceVersion
        && /^[0-9a-f]{40}$/.test(report.candidateRevision) && Array.isArray(report.checks)) {
        const links = [];
        for (const check of report.checks) {
          if (!["build", "browser", "deploy"].includes(check.stage) || !check.evidenceMessageId) continue;
          const href = "#pr-record/message/" + encodeURIComponent(check.evidenceMessageId);
          if (check.href === href) links.push(`<a href="${esc(href)}" target="_blank" rel="noopener">${esc(uiText("result.release." + check.stage))}</a>`);
        }
        if (links.length) {
          comparison.evidenceIds = new Set([report.messageId, ...report.checks.flatMap(check => [check.reportMessageId, check.evidenceMessageId])].filter(Boolean));
          content.insertAdjacentHTML("afterbegin", `<p data-previous-release-checks class="form-hint"><strong>${esc(uiText("result.previousReleaseChecks", { revision: report.candidateRevision.slice(0, 12) }))}</strong> ${links.join(" · ")}</p>`);
          syncResultComparisons();
        }
      }
      box.hidden = false;
    }).catch(() => {
      if (!current()) return;
      content.innerHTML = `<p class="form-hint"><strong>Resubmitted result.</strong> The earlier version could not be loaded for comparison. Previous approval never carries over; review the exact new text.</p>`;
      box.hidden = false;
    });
  }
  return { clear: clearResultComparison, sync: syncResultComparisons, load: loadResultComparison };
}
