// Polite live announcements for attention arrivals: new notifications, new
// activity (mentions, replies, reactions), and due reminders. Their badges
// update silently today, so a screen reader user never learns anything
// arrived. This module owns one shared sr-only region (#attention-announcement,
// role=status aria-live=polite in index.html); badge renderers call it with
// the delta. Polite, never assertive: arrivals are not errors and must not
// interrupt what the user is doing. (Errors keep using the #status toast,
// which is assertive by design.)
const REGION_ID = "attention-announcement";

function liveRegion() {
  return globalThis.document?.getElementById(REGION_ID) ?? null;
}

// Post text to the shared region. Repeating the identical text still deserves
// one fresh announcement, so clear first and re-set on a microtask — the same
// pattern notice() uses for the #status toast.
export function announceAttention(text) {
  const region = liveRegion();
  if (!region || !text) return;
  const set = () => { region.textContent = text; };
  if (region.textContent === text) { region.textContent = ""; queueMicrotask(set); }
  else set();
}

// Delta announcer for a badge count. The first sighting sets the baseline
// silently (pre-existing unread is not news); only growth announces, via
// format(delta). Decreases, resets to zero, and repeats stay silent.
export function trackIncrease(format) {
  let prev = 0, initialized = false;
  return count => {
    if (!initialized) { initialized = true; prev = count; return; }
    if (count > prev) announceAttention(format(count - prev));
    prev = count;
  };
}
