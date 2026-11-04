// Ctrl/Cmd-K palette extras: switch rooms and claim a task from the keyboard.
// Both reuse existing paths (the room list and the Board's own claim button),
// so the palette adds navigation only, never a new write or permission.
export const PALETTE_EXTRA_ENTRIES = Object.freeze([
  Object.freeze({ id: "switch-room", label: "Go to room", words: "rooms switch open other room list", always: true }),
  Object.freeze({ id: "claim-task", label: "Claim a task", words: "claim take start board task work", always: true })
]);

// Insert the extras right after the Board entry (or at the end) once each.
export function withPaletteExtras(entries) {
  const out = entries.filter(entry => !PALETTE_EXTRA_ENTRIES.some(extra => extra.id === entry.id));
  const at = out.findIndex(entry => entry.id === "board");
  out.splice(at < 0 ? out.length : at + 1, 0, ...PALETTE_EXTRA_ENTRIES);
  return out;
}

// The first enabled Claim button on the open Board, so Enter claims it.
export function firstClaimButton(root) {
  return [...(root?.querySelectorAll?.('[data-claim-action="claim"]') ?? [])].find(button => !button.disabled && !button.closest("[hidden]")) ?? null;
}
