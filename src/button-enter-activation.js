// Enter-key button activation rescue (UT27 14-1, WCAG 2.1.1).
//
// The app's buttons are native <button> elements, and a hardware Enter
// activates them natively (verified in a real browser: Playwright
// keyboard.press("Enter") on an offer card fires its request). But an
// Enter key event that arrives WITHOUT the browser's native activation
// step — synthesized key events injected by assistive switch/voice tools
// and automation drivers (the CDP Input.dispatchKeyEvent shape lane 14
// measured in production: Enter fired zero requests on offer cards and
// on the agent sign-in Continue button, while Space and click worked) —
// leaves the button dead, because the app binds activation to click and
// a synthesized Enter on its own produces no click.
//
// This module closes exactly that gap, and nothing else: when an Enter
// keydown lands on a button (or a button-type input), it waits for the
// event dispatch to finish and, if no click on that control arrived —
// i.e. native activation did not happen — fires the control's click()
// exactly once. When native activation DID happen (hardware keyboards),
// the click is already counted and the rescue stays inert, so a real
// Enter can never double-activate a control. An Enter the app itself
// refused (a handler called preventDefault, e.g. a menu or mention
// chooser) is never rescued. Space is untouched: its native activation
// (keyup) already works in both worlds.
//
// Installed per document by the button-bearing entry points
// (src/project-offers-ui.js, src/agent-signin-page.js, src/app.js).

const ACTIVATABLE = "button, input[type='button'], input[type='submit'], input[type='reset']";
const installed = new WeakSet();

// The control a keyboard event is aimed at: the event target may be a
// child node inside the button, so resolve through closest() when the
// target offers it.
export function enterActivatable(target) {
  if (!target || typeof target !== "object") return null;
  const el = typeof target.closest === "function" ? target.closest(ACTIVATABLE) : target;
  if (!el || typeof el.click !== "function") return null;
  const tag = String(el.tagName ?? "").toUpperCase();
  if (tag === "BUTTON") return el.disabled ? null : el;
  if (tag === "INPUT" && ["button", "submit", "reset"].includes(String(el.type ?? "").toLowerCase())) {
    return el.disabled ? null : el;
  }
  return null;
}

// doc is injectable so unit tests can drive the listener with a fake DOM
// whose buttons model the synthesized-Enter world (keydown, no native
// click). schedule is injectable for the same reason; the browser default
// runs the check as a task right after the keydown dispatch completes,
// which is after the native default action would have fired its click.
export function installButtonEnterActivation(doc = globalThis.document, { schedule } = {}) {
  if (!doc || typeof doc.addEventListener !== "function" || installed.has(doc)) return false;
  installed.add(doc);
  const run = typeof schedule === "function" ? schedule : callback => setTimeout(callback, 0);
  const clicks = new WeakMap();
  const count = el => clicks.get(el) ?? 0;
  doc.addEventListener("click", event => {
    const el = enterActivatable(event?.target);
    if (el) clicks.set(el, count(el) + 1);
  }, true);
  doc.addEventListener("keydown", event => {
    if (!event || event.key !== "Enter") return;
    const el = enterActivatable(event.target);
    if (!el) return;
    const before = count(el);
    run(() => {
      // The app refused this Enter on purpose, or native activation (or
      // any other click) already fired: the rescue must not add a second.
      if (event.defaultPrevented) return;
      if (count(el) !== before) return;
      if (enterActivatable(el) !== el) return; // disabled or removed since
      el.click();
    });
  });
  return true;
}
