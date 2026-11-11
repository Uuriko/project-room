import test from "node:test";
import assert from "node:assert/strict";
import { startLocal, runJourney, isExpectedReply } from "../scripts/qa-friend-agent-e2e.mjs";

test("journey output requires the expected content, not a failure or unrelated receipt", () => {
  for (const body of [null, "(turn failed: connection closed)", "echo: unrelated", "echo: wanted\n(turn failed: interrupted)"]) assert.equal(isExpectedReply(body, "wanted"), false);
  assert.equal(isExpectedReply("echo: wanted", "wanted"), true);
});
for (const fakeMode of ["echo", "crash-mid-turn"]) {
  test(`friend journey ${fakeMode} cannot count failure receipts as useful output`, { timeout: 90000 }, async t => {
    const room = await startLocal();
    t.after(() => room.close());
    const result = await runJourney({ ...room, fakeMode, print: () => {} });
    assert.equal(result.ok, fakeMode === "echo");
    assert.equal(result.steps.length, 6);
    assert.equal(result.steps[3].ok, fakeMode === "echo");
    assert.equal(result.steps[5].ok, fakeMode === "echo");
  });
}
