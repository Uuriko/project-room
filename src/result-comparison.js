import { exactResultHref } from "./room-deep-link.js";
import { diffResultLines, diffResultSummary } from "./workflow.js";
import { uiText } from "./strings.js";

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
      if ([comparison.currentId, comparison.previousId].some(id => getState()?.messages.find(message => message.id === id)?.deletedAt)) {
        clearResultComparison(box);
        box.textContent = uiText("result.comparisonWithdrawn"); box.hidden = false;
      } else if (comparison.evidenceIds && getState()?.messages.some(message =>
        (message.deletedAt || message.editedAt) && comparison.evidenceIds.has(message.id))) {
        box.querySelector("[data-previous-release-checks]")?.remove();
        comparison.evidenceIds = null;
      }
    }
  }
  function loadResultComparison(workItemId, previousId, text, box, owns) {
    clearResultComparison(box);
    if (!previousId) return;
    const comparison = { currentId: text.messageId, previousId: null, owns };
    resultComparisons.set(box, comparison);
    const current = () => owns() && resultComparisons.get(box) === comparison;
    client.workResult(workItemId, { completionEventId: previousId }).then(previous => {
      if (!current()) return;
      if (!previous) throw new Error("previous_result_unavailable");
      comparison.previousId = previous.result?.text?.messageId;
      syncResultComparisons();
      if (!current()) return;
      if (previous.result?.receipt?.eventId !== previousId) throw new Error("Pinned previous version changed");
      const before = previous.result?.text?.body;
      if (previous.result?.text?.withdrawnAt || text.withdrawnAt) {
        box.innerHTML = `<p class="form-hint"><strong>Resubmitted result.</strong> ${
          previous.result?.text?.withdrawnAt ? "The previous version's text has been withdrawn, so the two cannot be compared."
            : "This version's text has been withdrawn, so the two cannot be compared."
        } Previous approval never carries over.</p>`;
        box.hidden = false;
        return;
      }
      if (typeof before !== "string") throw new Error("Previous version has no exact text");
      const rows = diffResultLines(before, text.body);
      const note = "Previous approval never carries over; review the exact new text.";
      box.innerHTML = rows === null
        ? `<p class="form-hint"><strong>Resubmitted result.</strong> The previous version differs but is too large to compare line by line. ${esc(note)}</p>`
        : (() => { const summary = diffResultSummary(rows);
            const body = rows.length > 200 ? rows.slice(0, 200) : rows;
            return `<p class="form-hint"><strong>Resubmitted result.</strong> ${esc(uiText("result.comparisonSummary", { removed: summary.removedLines, added: summary.addedLines }))}</p>` +
              (summary.changedBytes ? `<pre class="result-diff">${body.map(row => `<span class="diff-${row.type}">${esc(row.type === "added" ? "+ " : row.type === "removed" ? "- " : "  ")}${esc(row.text)}</span>`).join("\n")}${rows.length > 200 ? `<span class="form-hint">… ${rows.length - 200} more rows</span>` : ""}</pre>` : `<p class="form-hint">No text changes from the previous version.</p>`);
          })();
      const earlierLink = exactResultHref({ roomId: previous.roomId, workItemId, completionEventId: previousId });
      if (earlierLink) {
        const paragraph = document.createElement("p");
        const link = document.createElement("a");
        link.href = earlierLink;
        link.textContent = uiText("result.openEarlier");
        paragraph.append(link);
        box.append(paragraph);
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
          box.insertAdjacentHTML("afterbegin", `<p data-previous-release-checks class="form-hint"><strong>${esc(uiText("result.previousReleaseChecks", { revision: report.candidateRevision.slice(0, 12) }))}</strong> ${links.join(" · ")}</p>`);
          syncResultComparisons();
        }
      }
      box.hidden = false;
    }).catch(() => {
      if (!current()) return;
      box.innerHTML = `<p class="form-hint"><strong>Resubmitted result.</strong> The earlier version could not be loaded for comparison. Previous approval never carries over; review the exact new text.</p>`;
      box.hidden = false;
    });
  }
  return { clear: clearResultComparison, sync: syncResultComparisons, load: loadResultComparison };
}
