// Imported by both startup modules (entry.js and the legacy direct app.js
// path). The readable static fallback stays up until this sets
// data-entry-started. Deferred stylesheets are applied first, so the app
// shell is not revealed unstyled. With no deferred links, it reveals now.
const links = [...document.querySelectorAll("link[data-defer-css]")];
function reveal() {
  document.documentElement.dataset.entryStarted = "true";
}
if (links.length === 0) reveal();
else {
  let remaining = links.length;
  const done = () => { if (--remaining === 0) reveal(); };
  for (const link of links) {
    link.addEventListener("load", done, { once: true });
    link.addEventListener("error", done, { once: true });
    link.rel = "stylesheet";
  }
}
