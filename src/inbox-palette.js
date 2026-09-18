/**
 * inbox-palette.js — Cmd+K command palette registry + keyboard-shortcut map
 * for inbox triage actions (Superhuman-style speed).
 *
 * Client-side, no DOM framework assumptions: the registry and shortcut map
 * are pure, and installPalette() only touches the DOM through an injected
 * target (defaults to globalThis.document when present, so the module also
 * imports cleanly in node). Matches the plain-function style of inbox-ui.js.
 */

const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const check = (condition, code, message) => {
  if (!condition) fail(code, message);
};

/** Triage actions and their default single-key shortcuts (Superhuman-style). */
export const TRIAGE_SHORTCUTS = Object.freeze({
  "triage.next": "j",
  "triage.prev": "k",
  "triage.open": "o",
  "triage.archive": "e",
  "triage.snooze": "h",
  "triage.send-later": "t",
  "triage.flag": "f",
  "triage.mark-read": "r",
  "triage.mark-unread": "u",
  "triage.reply": "Enter",
  "triage.snippet": ";",
  "triage.nudge": "n",
  "triage.summary": "s",
  "triage.priority-queue": "p",
  "triage.search": "/",
  "triage.help": "?",
});

/** Built-in command descriptors. `run` is filled by the installer. */
export const DEFAULT_COMMANDS = Object.freeze([
  { id: "triage.next", title: "Next thread", hint: "j" },
  { id: "triage.prev", title: "Previous thread", hint: "k" },
  { id: "triage.open", title: "Open thread", hint: "o" },
  { id: "triage.archive", title: "Archive thread", hint: "e" },
  { id: "triage.snooze", title: "Snooze thread", hint: "h" },
  { id: "triage.send-later", title: "Schedule send", hint: "t" },
  { id: "triage.flag", title: "Flag thread", hint: "f" },
  { id: "triage.mark-read", title: "Mark read", hint: "r" },
  { id: "triage.mark-unread", title: "Mark unread", hint: "u" },
  { id: "triage.reply", title: "Reply", hint: "Enter" },
  { id: "triage.snippet", title: "Insert snippet…", hint: ";" },
  { id: "triage.nudge", title: "Remind me if no reply", hint: "n" },
  { id: "triage.summary", title: "Summarize thread", hint: "s" },
  { id: "triage.priority-queue", title: "Show priority queue", hint: "p" },
  { id: "palette.toggle", title: "Toggle command palette", hint: "⌘K" },
  { id: "palette.dismiss", title: "Close palette", hint: "Esc" },
]);

const checkCommand = command => {
  check(command !== null && typeof command === "object" && !Array.isArray(command), "PALETTE_INVALID_COMMAND", "command must be an object");
  check(typeof command.id === "string" && command.id.length > 0 && command.id.length <= 128, "PALETTE_INVALID_COMMAND", "command id must be 1..128 characters");
  check(typeof command.title === "string" && command.title.length > 0 && command.title.length <= 160, "PALETTE_INVALID_COMMAND", "command title must be 1..160 characters");
  if (command.hint !== undefined) check(typeof command.hint === "string" && command.hint.length <= 32, "PALETTE_INVALID_COMMAND", "command hint must be a short string");
  if (command.run !== undefined && command.run !== null) check(typeof command.run === "function", "PALETTE_INVALID_COMMAND", "command run must be a function");
  return command;
};

/**
 * Fuzzy-ish search score for one command against a query: substring matches
 * score higher, prefix and word-boundary matches score higher still, title
 * matches beat id matches. Returns -1 when there is no match.
 */
export function matchCommand(command, query) {
  checkCommand(command);
  check(typeof query === "string", "PALETTE_INVALID_INPUT", "query must be a string");
  const q = query.trim().toLowerCase();
  if (!q) return 1; // empty query lists everything
  const title = command.title.toLowerCase();
  const id = command.id.toLowerCase();
  let score = -1;
  if (title === q) score = 100;
  else if (title.startsWith(q)) score = 80;
  else if (id.startsWith(q)) score = 70;
  else if (title.split(/[\s-]+/).some(word => word.startsWith(q))) score = 60;
  else if (title.includes(q)) score = 40;
  else if (id.includes(q)) score = 30;
  return score;
}

/** Create a command registry: register / unregister / list / search / run. */
export function createPalette(builtin = DEFAULT_COMMANDS) {
  check(Array.isArray(builtin), "PALETTE_INVALID_INPUT", "builtin commands must be a list");
  const commands = new Map();
  for (const command of builtin) {
    checkCommand(command);
    commands.set(command.id, { ...command });
  }

  const palette = {
    register(command) {
      checkCommand(command);
      check(!commands.has(command.id), "PALETTE_DUPLICATE", `Command '${command.id}' is already registered`);
      commands.set(command.id, { ...command });
      return palette.command(command.id);
    },
    unregister(id) {
      check(typeof id === "string", "PALETTE_INVALID_INPUT", "id must be a string");
      check(commands.delete(id), "PALETTE_UNKNOWN_COMMAND", `Unknown command '${id}'`);
      return true;
    },
    command(id) {
      const command = commands.get(id);
      return command ? Object.freeze({ ...command }) : null;
    },
    list() {
      return Object.freeze([...commands.values()].map(command => Object.freeze({ ...command })));
    },
    /** Search commands by query, best match first (frozen). */
    search(query) {
      check(typeof query === "string", "PALETTE_INVALID_INPUT", "query must be a string");
      const ranked = [];
      for (const command of commands.values()) {
        const score = matchCommand(command, query);
        if (score >= 0) ranked.push({ command, score });
      }
      ranked.sort((a, b) => b.score - a.score || (a.command.title < b.command.title ? -1 : 1));
      return Object.freeze(ranked.map(({ command }) => Object.freeze({ ...command })));
    },
    /** Run a command by id; throws PALETTE_UNKNOWN_COMMAND when missing. */
    run(id, ...args) {
      const command = commands.get(id);
      check(command, "PALETTE_UNKNOWN_COMMAND", `Unknown command '${id}'`);
      check(typeof command.run === "function", "PALETTE_NO_RUNNER", `Command '${id}' has no runner`);
      return command.run(...args);
    },
    count() {
      return commands.size;
    },
  };

  return Object.freeze(palette);
}

/**
 * Resolve a KeyboardEvent to a triage action id via the shortcut map.
 * Returns null for modified keys, editable targets, or unknown keys so the
 * caller falls through to normal handling.
 */
export function shortcutForEvent(event, shortcutMap = TRIAGE_SHORTCUTS) {
  if (!event || typeof event !== "object") return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const target = event.target;
  const tag = typeof target?.tagName === "string" ? target.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return null;
  const key = event.key;
  if (typeof key !== "string" || key.length === 0) return null;
  for (const [action, shortcut] of Object.entries(shortcutMap)) {
    if (shortcut === key) return action;
  }
  return null;
}

/** True when the event is the Cmd/Ctrl+K palette toggle chord. */
export function isPaletteToggle(event) {
  if (!event || typeof event !== "object") return false;
  return Boolean((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
    && typeof event.key === "string" && event.key.toLowerCase() === "k");
}

/**
 * Install the palette: Cmd/Ctrl+K toggles, single-key shortcuts fire triage
 * actions, Esc closes. All DOM access goes through `target` (a document or a
 * stub in tests). Returns { palette, destroy, open, close, isOpen }.
 */
export function installPalette({
  target = typeof globalThis.document !== "undefined" ? globalThis.document : null,
  commands = DEFAULT_COMMANDS,
  shortcutMap = TRIAGE_SHORTCUTS,
  onCommand = () => {},
  onOpen = () => {},
  onClose = () => {},
} = {}) {
  check(target !== null && typeof target.addEventListener === "function", "PALETTE_INVALID_INPUT", "target must provide addEventListener");
  const palette = createPalette(commands);
  let open = false;

  const openPalette = () => {
    if (open) return;
    open = true;
    onOpen();
  };
  const closePalette = () => {
    if (!open) return;
    open = false;
    onClose();
  };
  const onKeyDown = event => {
    if (isPaletteToggle(event)) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      open ? closePalette() : openPalette();
      return;
    }
    if (open && event.key === "Escape") {
      closePalette();
      return;
    }
    if (open) return; // palette consumes everything else while open
    const action = shortcutForEvent(event, shortcutMap);
    if (!action) return;
    const command = palette.command(action);
    if (!command) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof command.run === "function") command.run();
    onCommand(action, command);
  };

  target.addEventListener("keydown", onKeyDown);
  return Object.freeze({
    palette,
    open: openPalette,
    close: closePalette,
    isOpen: () => open,
    destroy: () => target.removeEventListener("keydown", onKeyDown),
  });
}
