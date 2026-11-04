import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withPaletteExtras, firstClaimButton, PALETTE_EXTRA_ENTRIES } from "../src/palette-destinations.js";

test("Ctrl/Cmd-K palette lists Go to room and Claim a task right after Board, once", () => {
  const base = [{ id: "write" }, { id: "board" }, { id: "settings" }];
  const out = withPaletteExtras(withPaletteExtras(base));
  assert.deepEqual(out.map(e => e.id), ["write", "board", "switch-room", "claim-task", "settings"]);
  assert.deepEqual(withPaletteExtras([{ id: "write" }]).map(e => e.id), ["write", "switch-room", "claim-task"]);
  for (const e of PALETTE_EXTRA_ENTRIES) assert.equal(e.always, true);
});

test("Claim a task focuses the first usable Board claim button", () => {
  const mk = (disabled, hidden) => ({ disabled, closest: () => (hidden ? {} : null) });
  const a = mk(true, false), b = mk(false, true), c = mk(false, false);
  assert.equal(firstClaimButton({ querySelectorAll: () => [a, b, c] }), c);
  assert.equal(firstClaimButton({ querySelectorAll: () => [] }), null);
  assert.equal(firstClaimButton(null), null);
});

test("app wires the extras into the existing Ctrl/Cmd-K palette", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /roomActionEntries = \(\) => withPaletteExtras\(/);
  assert.match(app, /id === "switch-room"\) \{ closeRoomActions\(false\); workspaceUI\?\.showRoomList\(\)/);
  assert.match(app, /id === "claim-task"/);
  assert.match(app, /event\.key\.toLowerCase\(\) !== "k"/);
});
