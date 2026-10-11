// Small inline illustrations for empty states. Colors come from the theme
// tokens, so one drawing serves dark and light. Decorative only: hidden from
// assistive tech, since the words next to each one carry the meaning.

// A new room: an earlier message, and the empty one waiting for you, with a
// text caret. The caret blinks three times when the empty room first shows
// (styles.css, .room-art-caret), then stays; still under reduced motion.
export const EMPTY_ROOM_ART = `<svg class="room-art" viewBox="0 0 160 96" width="160" height="96" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">`
  + `<path d="M22 14h62a10 10 0 0 1 10 10v26a10 10 0 0 1-10 10H44l-14 12v-12h-8a10 10 0 0 1-10-10V24a10 10 0 0 1 10-10z" stroke="var(--muted)" stroke-width="2"/>`
  + `<path d="M28 30h46M28 42h30" stroke="var(--muted)" stroke-width="2" opacity=".55"/>`
  + `<path d="M76 40h62a10 10 0 0 1 10 10v20a10 10 0 0 1-10 10h-8v12l-14-12H76a10 10 0 0 1-10-10V50a10 10 0 0 1 10-10z" fill="var(--panel-raised)" stroke="var(--blue)" stroke-width="2"/>`
  + `<path class="room-art-caret" d="M86 52v16" stroke="var(--blue)" stroke-width="2"/>`
  + `</svg>`;
