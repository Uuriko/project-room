import test from "node:test";
import assert from "node:assert/strict";
import {
  MATCHING_DESK_ORIGIN,
  MATCHING_DESK_TOOL_NAME,
  matchingDeskCall,
  matchingDeskDeepLink,
  matchingDeskFeeCopy,
  matchingDeskTool
} from "../src/matching-desk-tool.js";

test("matching desk tool is a deep-link, not a search or Compute job", () => {
  const tool = matchingDeskTool();
  assert.equal(tool.name, MATCHING_DESK_TOOL_NAME);
  assert.equal(tool.name.includes("DIE"), false);
  assert.match(tool.description, /mutual yes/i);
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = matchingDeskCall({ workItemId: "wi-hire", roomId: "commons" });
  assert.equal(result.href.startsWith(MATCHING_DESK_ORIGIN), true);
  assert.match(result.href, /work_item=wi-hire/);
  assert.match(result.href, /room=commons/);
  assert.equal(result.href.includes("/api"), false);
  assert.equal(result.sendsIdentity, false);
  assert.equal(result.startsSearch, false);
  assert.equal(result.compute, false);
  assert.equal(result.href.includes("getdasha.com/compute"), false);
  assert.match(matchingDeskFeeCopy(), /10% of first-year base/);
  assert.match(matchingDeskFeeCopy(), /Stripe-hosted/);
  assert.equal(matchingDeskDeepLink().includes("DIE"), false);
});
