// One HTML escape for text and for double-quoted attributes.
// & is replaced in the same pass as the other characters, so a value
// cannot smuggle a second metacharacter through an entity.
// null and undefined render as empty. A backtick is not an HTML
// metacharacter; it is escaped so a value copied into a script or
// template later cannot close one.
const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, character => ESCAPES[character]);
}
