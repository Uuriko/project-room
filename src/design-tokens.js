// One design system for Project Room.
//
// The room app (src/styles.css) is the base: dark charcoal, Inter, indigo.
// Other surfaces used to ship their own palettes (clay/serif door, acid door,
// paper/terracotta offers, cream/blue about, and generic system-ui pages).
// Those pages embed DARK_DECLARATIONS and LIGHT_DECLARATIONS verbatim.
// Light is opt-in via [data-theme="light"] so the product stays dark unless
// someone chooses otherwise. Do not auto-switch the app on
// prefers-color-scheme: browser tests run in light mode and would flip it.

export const DARK = Object.freeze({
  "--bg": "#202127",
  "--panel": "#191a20",
  "--panel-raised": "#292b33",
  "--panel-hover": "#34363f",
  "--line": "#393b45",
  "--line-soft": "#30323a",
  "--text": "#eeedf1",
  "--muted": "#aaaab7",
  "--blue": "#a9b9ff",
  "--blue-strong": "#5555bd",
  "--blue-strong-hover": "#6a6ad4",
  "--on-accent": "#ffffff",
  "--amber": "#ffbf69",
  "--green": "#4fd09b",
  "--red": "#ff7b7b",
  "--violet": "#ad8cff",
  "--card": "#191a20",
  "--border": "#393b45",
  "--shadow": "0 20px 70px rgb(0 0 0 / 32%)",
  "--radius-sm": ".35rem",
  "--radius-md": ".45rem",
  "--radius-lg": ".85rem",
  "--radius-xl": "1rem",
  "--space-1": ".25rem",
  "--space-2": ".5rem",
  "--space-3": ".75rem",
  "--space-4": "1rem",
  "--space-5": "1.5rem",
  "--space-6": "2rem",
  "--text-xs": ".75rem",
  "--text-sm": ".875rem",
  "--text-md": "1rem",
  "--text-lg": "1.25rem",
  "--font-sans": "Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif"
});

export const LIGHT = Object.freeze({
  "--bg": "#f4f3f8",
  "--panel": "#fffbff",
  "--panel-raised": "#e8e7ef",
  "--panel-hover": "#dddce6",
  "--line": "#c9c8d4",
  "--line-soft": "#dddce6",
  "--text": "#1c1b22",
  "--muted": "#5c5b6a",
  "--blue": "#33339a",
  "--blue-strong": "#3f3fad",
  "--blue-strong-hover": "#33338f",
  "--on-accent": "#ffffff",
  "--amber": "#8a4b00",
  "--green": "#0f6b45",
  "--red": "#a32020",
  "--violet": "#5b3d99",
  "--card": "#fffbff",
  "--border": "#c9c8d4",
  "--shadow": "0 16px 40px rgb(28 27 34 / 12%)"
});

export function declarations(tokens) {
  return Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(";");
}

export const DARK_DECLARATIONS = declarations(DARK);
export const LIGHT_DECLARATIONS = declarations(LIGHT);

function channel(hex, index) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(char => char + char).join("") : h;
  return parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
}

function linearize(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const [r, g, b] = [0, 1, 2].map(index => linearize(channel(hex, index)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

// WCAG 2.2 AA: 4.5:1 for text, 3:1 for large text and UI components.
export const CONTRAST_PAIRS = Object.freeze([
  ["dark text on background", DARK["--text"], DARK["--bg"], 4.5],
  ["dark muted on background", DARK["--muted"], DARK["--bg"], 4.5],
  ["dark muted on panel", DARK["--muted"], DARK["--panel"], 4.5],
  ["dark muted on raised panel", DARK["--muted"], DARK["--panel-raised"], 4.5],
  ["dark link on background", DARK["--blue"], DARK["--bg"], 4.5],
  ["dark accent label on background", DARK["--on-accent"], DARK["--blue-strong"], 4.5],
  ["dark accent label on hover", DARK["--on-accent"], DARK["--blue-strong-hover"], 4.5],
  ["dark text on secondary button", DARK["--text"], DARK["--panel-raised"], 4.5],
  ["light text on background", LIGHT["--text"], LIGHT["--bg"], 4.5],
  ["light muted on background", LIGHT["--muted"], LIGHT["--bg"], 4.5],
  ["light muted on raised panel", LIGHT["--muted"], LIGHT["--panel-raised"], 4.5],
  ["light link on background", LIGHT["--blue"], LIGHT["--bg"], 4.5],
  ["light accent label", LIGHT["--on-accent"], LIGHT["--blue-strong"], 4.5],
  ["light accent label on hover", LIGHT["--on-accent"], LIGHT["--blue-strong-hover"], 4.5],
  ["avatar initials on tile base", DARK["--text"], DARK["--panel-raised"], 4.5]
]);

// Default agent avatar tiles (DESIGN SYNC): initials on token-colored
// geometric tiles (SVG, no faces). The tile base stays dark so initials in
// --text keep WCAG AA on the dark default; the per-agent accent is a
// decorative geometric mark in a vivid token color. avatarTilePick hashes the
// member id so every agent gets a stable, distinct tile.
export const AVATAR_TILE_BASE = DARK["--panel-raised"];
export const AVATAR_TILE_ACCENTS = Object.freeze([
  DARK["--violet"],
  DARK["--green"],
  DARK["--amber"],
  DARK["--blue"],
  DARK["--red"]
]);
export const AVATAR_TILE_SHAPES = Object.freeze([
  "corner-circle",
  "corner-triangle",
  "corner-diamond",
  "top-bar"
]);

// djb2 over code points: deterministic across processes, no seeding.
function tileHash(key) {
  let hash = 5381;
  for (const char of String(key ?? "")) {
    hash = ((hash << 5) + hash + char.codePointAt(0)) >>> 0;
  }
  return hash;
}

export function avatarTilePick(key) {
  const hash = tileHash(key);
  return {
    accent: AVATAR_TILE_ACCENTS[hash % AVATAR_TILE_ACCENTS.length],
    shape: AVATAR_TILE_SHAPES[(hash >>> 4) % AVATAR_TILE_SHAPES.length]
  };
}
