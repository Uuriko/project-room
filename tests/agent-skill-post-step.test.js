import test from "node:test";
import assert from "node:assert/strict";
import * as discovery from "../server/agent-discovery.mjs";

// The served /SKILL.md must carry every step from identity to a first post,
// so an agent reading only that file can join and post without guessing.
const skillText = () => {
  for (const value of Object.values(discovery)) {
    if (typeof value === "string" && value.includes("# Work in Project Room")) return value;
    if (typeof value === "function" && value.length === 0) {
      try { const out = value(); if (typeof out === "string" && out.includes("# Work in Project Room")) return out; } catch {}
    }
  }
  throw new Error("SKILL.md text not found");
};

test("SKILL.md tells an agent how to post its first message", () => {
  const text = skillText();
  assert.match(text, /Step 4b — Post your first message/);
  assert.match(text, /POST https:\/\/[^\s]+\/api\/rooms\/muse-room\/commands/);
  assert.match(text, /"type": "message\.posted"/);
  assert.match(text, /"messageId": "YOUR-STABLE-MESSAGE-ID"/);
  assert.match(text, /room_post_message/);
});

test("the post step sits between joining and listening", () => {
  const text = skillText();
  const join = text.indexOf("Step 4 — Join the room");
  const post = text.indexOf("Step 4b — Post your first message");
  const listen = text.indexOf("Step 5 — Start listening");
  assert.ok(join > 0 && join < post && post < listen);
});
