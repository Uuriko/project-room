// Gap A7: MCP vs REST parity notes.
//
// tools.md and references/errors.md teach agents how to detect failures. Over
// HTTP the door answers real status codes; over MCP every tools/call answers
// JSON-RPC 200 and failures hide inside the result envelope. An MCP agent that
// checks the transport status sees "200 OK" for a 429 budget refusal and
// mints into the void. This test pins the two doc sentences that teach the
// detection rule (isError + embedded status/code/message, and the
// room_identity_mint 429 note) against the real handler, so if the server
// ever changes the envelope — or the docs drift from it — CI fails instead
// of agents failing silently at runtime.
//
// Behavior coverage already exists (tests/mcp-identity-mint.test.js asserts
// isError on the 422/428 paths); nothing there pins the *doc sentences*.
// This file owns the docs-vs-handler contract and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleIdentityMintMcp } from "../server/mcp-identity-mint.mjs";
import { ServiceError } from "../server/service-error.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => readFileSync(join(root, rel), "utf8");

const call = (store, args = { displayName: "Parity Probe" }) => handleIdentityMintMcp(store, {
  jsonrpc: "2.0",
  id: "parity-probe",
  method: "tools/call",
  params: { name: "room_identity_mint", arguments: args },
}, { remoteAddress: "203.0.113.7" });

const throwingStore = (status, code, message, detail) => ({
  identities: {
    create() { throw new ServiceError(status, code, message, null, detail); },
  },
});

test("tools.md teaches the MCP isError detection rule", () => {
  const text = read("skills/project-room/references/tools.md");
  assert.ok(/isError/.test(text),
    "tools.md must document checking result.isError on MCP tool calls");
  assert.ok(/structuredContent/.test(text),
    "tools.md must name structuredContent as the embedded-body carrier");
});

test("tools.md warns that room_identity_mint refuses arrive as 200 + isError", () => {
  const text = read("skills/project-room/references/tools.md");
  const section = text.match(/MCP vs REST parity([\s\S]*?)(?:\n## |\n# |$)/);
  assert.ok(section, "tools.md must have an MCP vs REST parity section");
  assert.ok(/room_identity_mint/.test(section[1]),
    "the parity section must name room_identity_mint");
  assert.ok(/429/.test(section[1]),
    "the parity section must document the embedded 429 budget refusal");
});

test("embedded 429 keeps status/code/message and no JSON-RPC error member", () => {
  const reply = call(throwingStore(429, "rate_limited", "Identity mint network budget reached"));
  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.error, undefined,
    "tool failures must not become JSON-RPC error members — the envelope stays 200");
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.structuredContent.status, 429);
  assert.equal(reply.result.structuredContent.code, "rate_limited");
  assert.equal(reply.result.structuredContent.message, "Identity mint network budget reached");
  assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent,
    "content[0].text must carry the same embedded body as structuredContent");
});

test("Retry-After never reaches the MCP door on the embedded 429", () => {
  // The limiter raises ServiceError with the retry window in the HTTP
  // *headers* (4th constructor arg); the MCP envelope serializes only
  // status/code/message/detail, so a docs sentence that says "wait for the
  // Retry-After header" is unusable over MCP and must be qualified.
  const err = new ServiceError(429, "rate_limited", "Identity mint network budget reached",
    { "Retry-After": "3600" });
  const reply = call({ identities: { create() { throw err; } } });
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.structuredContent.headers, undefined,
    "the embedded body must not carry HTTP headers");
});

test("errors.md qualifies the rate_limited Retry-After advice for MCP", () => {
  const text = read("skills/project-room/references/errors.md");
  const row = text.match(/[^\n]*rate_limited[^\n]*/);
  assert.ok(row, "errors.md must keep a rate_limited row");
  assert.ok(/MCP/i.test(row[0]),
    "the rate_limited row must qualify the advice for MCP callers");
  assert.ok(/Retry-After/i.test(row[0]),
    "the rate_limited row must name the Retry-After header it discusses");
});
