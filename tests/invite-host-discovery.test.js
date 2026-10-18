import test from "node:test";
import assert from "node:assert/strict";
import { llmsTxt, llmsFullTxt, ROOM_ORIGIN } from "../server/agent-discovery.mjs";

for (const [name, packet] of [["short", llmsTxt], ["full", llmsFullTxt]]) {
  test(`${name} discovery packet gives humans the app-host invite example`, () => {
    const line = packet().split("\n").find(text => text.startsWith("Humans: open this invite link"));
    assert.ok(line);
    assert.ok(line.includes(`${ROOM_ORIGIN}/#join/`));
    assert.doesNotMatch(line, /getdasha\.com/);
    assert.match(line, /#room\/\{roomId\} is not an invite/);
  });
}
