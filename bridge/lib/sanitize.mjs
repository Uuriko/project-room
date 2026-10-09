/**
 * bridge/lib/sanitize.mjs — THE single shared ANSI sanitizer.
 *
 * Applied at the readPane trust boundary in the bridge: no unsanitized pane
 * text ever leaves the bridge. Worker-side defense-in-depth re-sanitizing is
 * encouraged but the bridge is the enforcing layer (threat-model P2).
 *
 * Policy:
 *  - OSC sequences (ESC ] ... terminated by BEL or ESC \\) are dropped
 *    entirely. OSC 52 (clipboard write) is a hard drop — its payload never
 *    survives, even as visible text.
 *  - CSI sequences (ESC [ params final) are stripped entirely (cursor tricks,
 *    colors, erasures cannot reach a renderer).
 *  - Any surviving ESC / C0 / C1 control byte is removed (lone ESC becomes the
 *    visible glyph U+241B so truncation is noticeable, not exploitable).
 *  - Newlines normalized to \n; \t kept; other whitespace controls removed.
 */
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Lone ESC not part of a sequence above, plus C1 controls:
const STRAY_ESC_RE = /\x1b/g;
const C1_RE = /[\x80-\x9f]/g;
// C0 controls except \n (\x0a) and \t (\x09):
const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function sanitizePaneText(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  out = out.replace(OSC_RE, '');      // hyperlinks, titles, clipboard — gone
  out = out.replace(CSI_RE, '');      // cursor/color/erase tricks — gone
  out = out.replace(STRAY_ESC_RE, '␛'); // surviving ESC rendered visible
  out = out.replace(C1_RE, '');
  out = out.replace(C0_RE, '');
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return out;
}
