import test from "node:test";
import assert from "node:assert/strict";
import { talkPolicySelect } from "../src/talk-policy-ui.js";

test("#5384 who-can-talk select marks the current policy and escapes the member id", () => {
  const html = talkPolicySelect('a"b', "owner");
  assert.match(html, /data-talk-policy="a&quot;b"/);
  assert.match(html, /<option value="owner" selected>/);
  assert.doesNotMatch(html, /value="members"/);
});
test("#5384 an unknown or missing policy shows the legacy room default", () => {
  assert.match(talkPolicySelect("m", undefined), /<option value="room" selected>/);
  assert.match(talkPolicySelect("m", "members"), /<option value="members" selected>/);
});
