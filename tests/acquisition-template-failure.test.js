// Issue #2971: a failed template acquisition intent was never cleared, so
// every account-home render retried the same failing room-creation POST.
// runAcquisitionIntent lives in the browser monolith src/app.js, which cannot
// be imported under node, so this suite extracts the acquisition functions
// verbatim from app.js and runs them against stubbed storage/DOM/session
// dependencies (the extraction precedent is tests/agent-write-guide.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const app = readFileSync(join(ROOT, "src/app.js"), "utf8");

const ACQUISITION_KEY = app.match(/const ACQUISITION_KEY = "([^"]+)";/)?.[1];
const TEMPLATE_ROOM_KEY = app.match(/const TEMPLATE_ROOM_KEY = "([^"]+)";/)?.[1];
assert.ok(ACQUISITION_KEY, "app.js declares ACQUISITION_KEY");
assert.ok(TEMPLATE_ROOM_KEY, "app.js declares TEMPLATE_ROOM_KEY");

// Return the full source of one top-level function declaration, or null when
// the function does not exist. Brace matching skips strings and comments.
function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] ?? "";
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function memoryStorage(start = {}) {
  const data = new Map(Object.entries(start));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

// Build the real runAcquisitionIntent (plus the real storage helpers it
// calls) with only its external collaborators stubbed.
async function buildRunner({ storage, startRoomFromTemplate, showAgentInvitePicker }) {
  const helpers = ["readAcquisition", "clearAcquisition", "clearTemplateRoom"]
    .map(name => extractFunction(app, name))
    .filter(Boolean);
  const runSource = extractFunction(app, "runAcquisitionIntent");
  assert.ok(runSource, "app.js defines runAcquisitionIntent");
  const factory = new AsyncFunction(
    "window", "$", "state", "accountClient", "inboxUI", "receiptReferrer",
    "startRoomFromTemplate", "showAgentInvitePicker",
    `const ACQUISITION_KEY = ${JSON.stringify(ACQUISITION_KEY)};\n`
    + `const TEMPLATE_ROOM_KEY = ${JSON.stringify(TEMPLATE_ROOM_KEY)};\n`
    + helpers.join("\n") + "\n" + runSource + "\nreturn runAcquisitionIntent;",
  );
  const nodes = new Map();
  const nodeFor = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: "", value: "", open: false });
    return nodes.get(selector);
  };
  const run = await factory(
    { sessionStorage: storage },
    nodeFor,
    null,
    { session: { authenticated: true } },
    { showRoomList() {} },
    () => "",
    startRoomFromTemplate,
    showAgentInvitePicker ?? (async () => {}),
  );
  return { run, nodeFor };
}

function templateIntentStorage() {
  return memoryStorage({
    [ACQUISITION_KEY]: JSON.stringify({ kind: "template", template: "bug-bash" }),
    [TEMPLATE_ROOM_KEY]: "room-poisoned1",
  });
}

test("a definitive template failure clears the intent and the stashed room id (#2971)", async () => {
  const storage = templateIntentStorage();
  let calls = 0;
  const failure = new Error("Check the room name, purpose and your name.");
  failure.status = 422;
  failure.code = "invalid_template";
  const { run, nodeFor } = await buildRunner({
    storage,
    startRoomFromTemplate: async () => { calls++; throw failure; },
  });
  await run();
  assert.equal(calls, 1);
  assert.equal(nodeFor("#account-rooms-status").textContent, "Couldn’t finish that. Refresh and try again.");
  assert.equal(storage.getItem(ACQUISITION_KEY), null, "the failed template intent is consumed, not left for the next render");
  assert.equal(storage.getItem(TEMPLATE_ROOM_KEY), null, "the failed attempt's room id is dropped with the intent");
  // The next account-home render must not retry the same failing POST.
  await run();
  assert.equal(calls, 1, "a later render does not retry the failed template creation");
});

test("a network template failure clears the intent and the stashed room id (#2971)", async () => {
  const storage = templateIntentStorage();
  let calls = 0;
  const { run } = await buildRunner({
    storage,
    startRoomFromTemplate: async () => { calls++; throw new TypeError("Failed to fetch"); },
  });
  await run();
  assert.equal(calls, 1);
  assert.equal(storage.getItem(ACQUISITION_KEY), null, "the failed template intent is consumed after a network failure");
  assert.equal(storage.getItem(TEMPLATE_ROOM_KEY), null, "the failed attempt's room id is dropped after a network failure");
  await run();
  assert.equal(calls, 1, "a later render does not retry after a network failure");
});

test("a successful template acquisition still runs once and clears the intent", async () => {
  const storage = templateIntentStorage();
  let calls = 0;
  const { run } = await buildRunner({
    storage,
    startRoomFromTemplate: async slug => {
      calls++;
      assert.equal(slug, "bug-bash");
      storage.removeItem(TEMPLATE_ROOM_KEY); // startRoomFromTemplate drops its id once the room opens
    },
  });
  await run();
  assert.equal(calls, 1);
  assert.equal(storage.getItem(ACQUISITION_KEY), null);
  await run();
  assert.equal(calls, 1, "a consumed success is not replayed");
});

test("a request intent is still consumed before the form is populated", async () => {
  const storage = memoryStorage({
    [ACQUISITION_KEY]: JSON.stringify({ kind: "request", roomId: "commons" }),
  });
  let templateCalls = 0;
  const { run, nodeFor } = await buildRunner({
    storage,
    startRoomFromTemplate: async () => { templateCalls++; },
  });
  await run();
  assert.equal(templateCalls, 0);
  assert.equal(storage.getItem(ACQUISITION_KEY), null);
  assert.equal(nodeFor("#account-request-room").value, "commons");
  assert.equal(nodeFor("#account-request-access").open, true);
});
