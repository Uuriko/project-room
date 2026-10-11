// Tab-trap decision for the modal dialogs in src/app.js (invitation, work,
// action, result, room-actions, decision, board, catchup, settings).
//
// Pure (no DOM globals beyond what the caller passes), so it is unit-testable
// in tests/dialog-focus-trap.test.js.
//
// The trap keeps Tab inside the open dialog. The one case it must NOT wrap:
// focus is inside the dialog but not on a tabbable control — e.g. a
// claim-card h4 (tabindex=-1) focused programmatically by board j/k
// navigation (src/board-keyboard.mjs) or by board-ui.js's focus restore after
// an action. The old check ("active is not one of the tabbable controls")
// treated that as "focus left the dialog" and yanked Tab to the first/last
// control, teleporting the keyboard user to the top of the dialog instead of
// continuing from the card. Only focus that has actually left the dialog
// wraps back in.
export function tabTarget(controls, dialog, active, shiftKey) {
  const list = Array.isArray(controls) ? controls : [];
  const first = list[0] ?? null;
  const last = list.length ? list[list.length - 1] : null;
  if (!first) return { wrap: true, target: null };
  // Focus escaped the dialog (or there is none): pull it back to the wrap edge.
  if (!active || typeof dialog?.contains !== "function" || !dialog.contains(active)) {
    return { wrap: true, target: shiftKey ? last : first };
  }
  // Focus is inside the dialog. Wrap only on the boundary control; anywhere
  // else (a tabbable control mid-list, or a programmatically focused
  // non-control like a card heading) Tab flows naturally in DOM order.
  if (shiftKey ? active === first : active === last) {
    return { wrap: true, target: shiftKey ? last : first };
  }
  return { wrap: false, target: null };
}
