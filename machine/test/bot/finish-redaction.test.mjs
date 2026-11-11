import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineBot } from "../../bot/loop.mjs";
import { createRoomApi } from "../../bot/room-api.mjs";

// Regression: finish() used to post its completion message via
// this.api.post(...) directly, bypassing the redaction wrapper in
// this.post() (the wrapper that passes the bot's registered secrets to
// room-api, which scrubs them from the body). The completion text was
// safe only because it happened to be pre-redacted at creation; any
// other text reaching the saved completion (a restored state file, a
// future free-text change) went to the room unscrubbed. finish() now
// routes through this.post(), which also forwards the completion's
// stable messageId so a retried finish stays idempotent.

const FAKE_PROVIDER_KEY = "sk-ant-FAKEPROVIDERKEY0000000000000001";
const FAKE_IDENTITY = "fake-identity-secret-0000000001";

async function fakeRoom(t) {
  const recorded = [];
  let failNext = false;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (failNext) {
        failNext = false;
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "fake_failure" } }));
        return;
      }
      recorded.push(JSON.parse(raw));
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    recorded,
    failNextPost() { failNext = true; },
  };
}

function finishingBot(t, room, { text, blobs = [], awaitingReview = false }) {
  const home = mkdtempSync(join(tmpdir(), "room-bot-finish-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bot = new MachineBot({ home, env: {}, waitMs: 0 });
  bot.config = { provider: null, roomOrigin: room.origin, label: "test" };
  bot.secret = FAKE_IDENTITY;
  // Same registry shape as production secrets(): [providerKey, identitySecret].
  bot.secrets = async () => [FAKE_PROVIDER_KEY, FAKE_IDENTITY];
  // State persistence is a separate surface; stub it so this test
  // isolates the completion post path (receipt and claims are likewise
  // pre-staged below, so finish() goes straight to its post).
  bot.saveState = async () => {};
  bot.api = createRoomApi({ origin: room.origin, secret: FAKE_IDENTITY, signal: bot.abort.signal });
  bot.active = {
    roomId: "room-finish",
    messageId: "parent-msg-1",
    leaseId: "lease-1",
    workId: "work-1",
    slot: "desk",
    updateId: null,
    basisToken: null,
    completion: {
      text,
      messageId: "completion-msg-1",
      updateRequestId: "upd-1",
      receipt: { ok: true, blobs, tags: ["machine-host", "lease", "slot-desk", "bot"] },
      leaseId: true,
      workId: awaitingReview ? "awaiting_review" : true,
    },
  };
  return bot;
}

test("finish posts its completion through the redaction wrapper", async (t) => {
  const room = await fakeRoom(t);
  const bot = finishingBot(t, room, {
    text: `Finished. Provider key ${FAKE_PROVIDER_KEY} and identity ${FAKE_IDENTITY} appear in this note.`,
  });
  const result = await bot.finish(bot.active.completion.text);
  assert.equal(result.done, true, JSON.stringify(result));
  assert.equal(room.recorded.length, 1);
  const posted = room.recorded[0];
  assert.equal(posted.type, "message.posted");
  assert.equal(posted.data.body.includes(FAKE_PROVIDER_KEY), false);
  assert.equal(posted.data.body.includes(FAKE_IDENTITY), false);
  assert.equal(posted.data.body, "Finished. Provider key [redacted] and identity [redacted] appear in this note.");
  // The stable completion messageId and the reply target survive the
  // wrapper, so a retried finish cannot duplicate the post.
  assert.equal(posted.data.messageId, "completion-msg-1");
  assert.equal(posted.data.replyToId, "parent-msg-1");
});

test("finish keeps today's clean completion bodies byte-identical", async (t) => {
  const room = await fakeRoom(t);
  const bot = finishingBot(t, room, {
    text: "Task complete. The screenshot was saved.",
    blobs: ["sha256:" + "a".repeat(64)],
    awaitingReview: true,
  });
  const result = await bot.finish(bot.active.completion.text);
  assert.equal(result.done, true, JSON.stringify(result));
  assert.equal(room.recorded.length, 1);
  assert.equal(
    room.recorded[0].data.body,
    "Task complete. The screenshot was saved.\nAwaiting review.\nReceipt sha256:" + "a".repeat(64),
  );
});

test("a failed finish post stays pending and retries with the same messageId, scrubbed", async (t) => {
  const room = await fakeRoom(t);
  const bot = finishingBot(t, room, {
    text: `Finished with ${FAKE_IDENTITY} in the note.`,
  });
  room.failNextPost();
  const failed = await bot.finish(bot.active.completion.text);
  assert.equal(failed.deliveryPending, true);
  assert.equal(failed.stage, "message");
  assert.equal(room.recorded.length, 0);
  const retried = await bot.finish(bot.active.completion.text);
  assert.equal(retried.done, true, JSON.stringify(retried));
  assert.equal(room.recorded.length, 1);
  assert.equal(room.recorded[0].data.messageId, "completion-msg-1");
  assert.equal(room.recorded[0].data.body.includes(FAKE_IDENTITY), false);
});
