// M-08 (mobile navigation): the fixed mobile bottom bar reserves its own space
// via var(--workspace-nav-height, 3.5rem) on the app shell. The 3.5rem fallback
// under-covers phones whose home-indicator safe area pushes the bar taller
// (1px border + .25rem padding + 44px min-height + ~34px safe area ≈ 83px),
// so the bar occludes the last ~30px of the inbox list / room composer.
// syncWorkspaceNavHeight keeps the reserved space glued to the measured bar.
import test from "node:test";
import assert from "node:assert/strict";
import { syncWorkspaceNavHeight } from "../src/room-layout.js";

const stubShell = () => {
  const props = {};
  return { props, style: { setProperty(k, v) { props[k] = v; } } };
};

test("the reserved bottom space mirrors the measured nav height", () => {
  const shell = stubShell();
  const px = syncWorkspaceNavHeight(shell, { hidden: false, offsetHeight: 83 });
  assert.equal(px, 83);
  assert.equal(shell.props["--workspace-nav-height"], "83px");
});

test("a hidden nav reserves no space", () => {
  const shell = stubShell();
  syncWorkspaceNavHeight(shell, { hidden: true, offsetHeight: 0 });
  assert.equal(shell.props["--workspace-nav-height"], "0px");
});

test("missing nodes are a no-op, not a crash", () => {
  const shell = stubShell();
  assert.equal(syncWorkspaceNavHeight(shell, null), 0);
  assert.equal(syncWorkspaceNavHeight(null, { hidden: false, offsetHeight: 60 }), 0);
  assert.deepEqual(shell.props, {});
});
