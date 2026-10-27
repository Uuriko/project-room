// Inbound email stays off until a durable consumer is wired. Served discovery
// documents and the operator docs that describe mail must not say otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { durableInboundEmailConsumer } from "../server/email-routing-inbound.mjs";
import { llmsTxt, llmsFullTxt } from "../server/agent-discovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const liveClaim = /inbound email is (live|accepted|enabled|on)|email\(\) handler is not mounted|enable Email Routing/i;

test("inbound email is off, and served docs do not promise a live mailbox", () => {
  assert.equal(durableInboundEmailConsumer(), null);
  for (const packet of [llmsTxt(), llmsFullTxt()]) {
    assert.equal(liveClaim.test(packet), false);
  }
  for (const name of ["docs/ADMIN-GUIDE.md", "docs/CURRENT-ROOM.md", "docs/UNIFIED-INBOX.md", "docs/DATA-BOUNDARIES.md", "docs/analytics/EVENTS.md"]) {
    const text = readFileSync(join(root, name), "utf8");
    assert.match(text, /inbound email is off/i);
    assert.equal(liveClaim.test(text), false);
  }
});
