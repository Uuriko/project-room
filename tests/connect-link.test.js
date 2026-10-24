import test from "node:test";
import assert from "node:assert/strict";
import { connectLinkFor, connectHintFrom, consentContextFor, validConnectCode, normalizeConnectCode } from "../server/connect-link.mjs";

const code = "RM-0123456789ABCDEF";

test("each invite gets its own page and MCP URL carrying only the code", () => {
  const link = connectLinkFor({ origin: "https://room.example.test/", code });
  assert.equal(link.pageUrl, `https://room.example.test/a/${code}`);
  assert.equal(link.mcpUrl, `https://room.example.test/mcp?connect=${code}`);
  for (const command of Object.values(link.commands)) {
    assert.ok(command.includes(link.mcpUrl));
    assert.doesNotMatch(command, /Bearer|SECRET|token/i);
  }
});

test("codes follow the invite module's shape and folding", () => {
  assert.equal(normalizeConnectCode(" rm-o123456789abcdef "), code, "lowercase and O->0 fold like redeem()");
  assert.equal(normalizeConnectCode("RM-ABCDEFGH"), "RM-ABCDEFGH", "legacy 8-symbol codes");
  for (const bad of ["", "abc", "RM-<script>", "RM-a b", null, "RM-" + "A".repeat(200), "RM-0123456789ABCDEU"]) {
    assert.equal(validConnectCode(bad), false, String(bad));
    assert.throws(() => connectLinkFor({ code: bad }));
  }
});

test("the hint is read from /mcp or from the OAuth resource parameter", () => {
  assert.equal(connectHintFrom(`https://h/mcp?connect=${code}`), code);
  const authorize = `https://h/oauth/authorize?client_id=x&resource=${encodeURIComponent(`https://h/mcp?connect=${code}`)}`;
  assert.equal(connectHintFrom(authorize), code);
  assert.equal(connectHintFrom("https://h/mcp?connect=RM-%3Cx%3E"), null);
  assert.equal(connectHintFrom("https://h/mcp"), null);
  assert.equal(connectHintFrom("::not a url"), null);
});

// Fixture is the exact shape AgentInvites.preview() returns.
const preview = { roomId: "rm_8f2c1a", roomTitle: "Launch room", permissions: ["chat", "work"], profile: "contribute", expiresAt: Date.now() + 60000, inviterDisplayName: "Potter" };

test("consent opens on the invited room and hides dead codes", () => {
  const ctx = consentContextFor(preview, code);
  assert.equal(ctx.heading, "Connect this agent to Launch room");
  assert.equal(ctx.invitedBy, "Potter");
  assert.match(ctx.line, /take tasks/);
  assert.equal(consentContextFor({ ...preview, expiresAt: Date.now() - 1 }, code), null);
  assert.equal(consentContextFor(null, code), null);
  assert.equal(consentContextFor(preview, "nope"), null);
});

test("room text is flattened before it reaches the consent heading", () => {
  const ctx = consentContextFor({ ...preview, roomTitle: "Line\nbreak\u0007" }, code);
  assert.equal(ctx.heading, "Connect this agent to Line break");
});

test("the /a/<code> page does not advertise the hint before /mcp reads it", async () => {
  const { renderAgentConnectMarkdown } = await import("../server/routes/agent-connect.mjs");
  const text = renderAgentConnectMarkdown({ origin: "https://room.example.test", code, roomId: "launch", title: "Launch", purpose: "", profile: "contribute", permissions: [], expiresAt: Date.now() + 600000, claims: [] });
  assert.doesNotMatch(text, /\?connect=/);
});
