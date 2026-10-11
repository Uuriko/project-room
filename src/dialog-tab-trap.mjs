// Dialog Tab-focus management (shared by the room page's dialogs).
//
// The dialogs (board, work, catchup, settings, room-actions, …) trap Tab so
// keyboard users cycle through the dialog's controls instead of tabbing out
// into the page behind. The trap must NOT swallow the position of
// programmatically-focused, non-tabbable landmarks inside the dialog: the
// board's j/k navigation focuses a claim-card heading (h4 with tabindex="-1"),
// and Tab from there must continue tab order from that card — the card's own
// action buttons (Claim, Renew, Done, Release) — instead of wrapping to the
// dialog's first control and losing the user's place.
//
// DOM-order constants (same numeric values as Node.DOCUMENT_POSITION_*) so
// this module needs no browser global at import time.
const FOLLOWING = 4;
const PRECEDING = 2;

const TABBABLE_SELECTOR =
  "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])";

export function tabControls(dialog) {
  return [...dialog.querySelectorAll(TABBABLE_SELECTOR)]
    .filter(element => element.getClientRects().length > 0);
}

// First tabbable control at or after `anchor` in document order (forward), or
// at or before `anchor` (backward). Falls back to the nearest dialog edge so
// focus never leaves the dialog.
function nearestControl(controls, anchor, backward) {
  const candidates = backward ? [...controls].reverse() : controls;
  const wanted = backward ? PRECEDING : FOLLOWING;
  const near = candidates.find(control => (anchor.compareDocumentPosition(control) & wanted) !== 0);
  return near ?? (backward ? candidates.at(-1) : candidates[0]);
}

// Handles a Tab keydown inside an open dialog. `options.document` is the
// document (injectable for tests); `options.emptyFallback` is focused when the
// dialog has no tabbable controls at all (defaults to the dialog itself).
export function handleDialogTabKey(event, { dialog, document, emptyFallback } = {}) {
  const controls = tabControls(dialog);
  const active = document?.activeElement ?? null;
  if (!controls.length) {
    event.preventDefault();
    (emptyFallback ?? dialog)?.focus();
    return;
  }
  const first = controls[0];
  const last = controls.at(-1);
  if (!controls.includes(active)) {
    // Focus sits on something non-tabbable. Keyboard-navigated landmarks
    // (claim-card headings) live inside the dialog: continue tab order from
    // the landmark instead of teleporting to the dialog header. Focus outside
    // the dialog keeps the old wrap-to-header behavior.
    event.preventDefault();
    if (dialog.contains(active)) {
      nearestControl(controls, active, event.shiftKey)?.focus();
    } else {
      (event.shiftKey ? last : first)?.focus();
    }
    return;
  }
  if (event.shiftKey ? active === first : active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  }
  // Mid-list Tab is left to the browser's native tab order.
}
