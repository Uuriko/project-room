// Board keyboard navigation (BU-14 power-user slice).
//
// j/k move focus between claim cards on the work-claims board. Everything
// else stays on native controls (real buttons, native forms), so the
// focus-restore logic in src/board-ui.js is untouched — this module only adds
// a card-level navigation layer on top.
//
// Guard rails:
// - Ignored inside text-entry controls (INPUT/TEXTAREA/SELECT,
//   contenteditable) so typing URLs, notes, and file lists never triggers it.
// - Ignored with Ctrl/Cmd/Alt held (Cmd+K opens room actions; leave it alone).
// - The listener sits on #work-board itself, so board repaints (which replace
//   innerHTML) never drop it, and attachBoardKeyboard is idempotent.

const CARD_HEADING = "article.claim-card h4";
const NAV_KEYS = new Set(["j", "k"]);
const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditableTarget(target) {
  if (!target) return false;
  return EDITABLE_TAGS.has(String(target.tagName ?? "").toUpperCase()) || Boolean(target.isContentEditable);
}

export function shouldHandleBoardKey(event) {
  if (!event || event.defaultPrevented || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!NAV_KEYS.has(event.key)) return false;
  return !isEditableTarget(event.target);
}

// Pure index math for the tests: clamp at both ends, never wrap (a wrap
// would teleport a keyboard user across a five-column board).
export function cardNavIndex(count, currentIndex, direction) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const current = Number.isInteger(currentIndex) && currentIndex >= 0 ? currentIndex : -1;
  return Math.max(0, Math.min(count - 1, current + direction));
}

function currentHeadingIndex(headings, doc) {
  const active = doc?.activeElement ?? null;
  const card = active?.closest?.("article.claim-card") ?? null;
  const heading = card?.querySelector?.("h4") ?? null;
  return heading ? headings.indexOf(heading) : -1;
}

// doc is injectable so unit tests can run without a browser DOM.
export function attachBoardKeyboard(root, doc = globalThis.document) {
  if (!root || root.dataset.boardKeynav) return false;
  root.dataset.boardKeynav = "1";
  root.addEventListener("keydown", event => {
    if (!shouldHandleBoardKey(event)) return;
    const headings = [...root.querySelectorAll(CARD_HEADING)];
    if (!headings.length) return;
    const next = cardNavIndex(headings.length, currentHeadingIndex(headings, doc), event.key === "j" ? 1 : -1);
    if (next < 0) return;
    event.preventDefault();
    const heading = headings[next];
    heading.focus();
    heading.scrollIntoView?.({ block: "nearest" });
  });
  return true;
}
