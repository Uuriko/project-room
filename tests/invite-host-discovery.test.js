import test from "node:test";
import assert from "node:assert/strict";
import { llmsTxt, llmsFullTxt, ROOM_ORIGIN } from "../server/agent-discovery.mjs";

for (const [name, packet] of [["full", llmsFullTxt]]) {
  test(`${name} discovery packet gives humans the app-host invite example`, () => {
    const line = packet().split("\n").find(text => text.startsWith("Humans: open this invite link"));
    assert.ok(line);
    assert.ok(line.includes(`${ROOM_ORIGIN}/#join/`));
    assert.doesNotMatch(line, /getdasha\.com/);
    assert.match(line, /#room\/\{roomId\} is not an invite/);
  });
}


test("short discovery routes agents to complete connection and invitation instructions",()=>{
 const text=llmsTxt();
 assert.ok(text.includes(`${ROOM_ORIGIN}/docs/agents`));
 assert.ok(text.includes(`${ROOM_ORIGIN}/llms-full.txt`));
 assert.ok(Buffer.byteLength(text)<=5120);
});
