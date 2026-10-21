import test from "node:test";
import assert from "node:assert/strict";
import { connectLinkFor, connectHintFrom, consentContextFor, validConnectCode } from "../server/connect-link.mjs";

const code = "RM-abc123XYZ";

test("each invite gets its own page and MCP URL carrying only the code", () => {
  const link = connectLinkFor({ origin: "https://room.example.test/", code });
  assert.equal(link.pageUrl, "https://room.example.test/a/RM-abc123XYZ");
  assert.equal(link.mcpUrl, "https://room.example.test/mcp?connect=RM-abc123XYZ");
  for (const command of Object.values(link.commands)) {
    assert.ok(command.includes(link.mcpUrl));
    assert.doesNotMatch(command, /Bearer|SECRET|token/i);
  }
});

test("malformed codes are rejected, never embedded", () => {
  for (const bad of ["", "abc", "RM-<script>", "RM-a b", null, "RM-" + "a".repeat(200)]) {
    assert.equal(validConnectCode(bad), false);
    assert.throws(() => connectLinkFor({ code: bad }));
  }
});

test("the hint is read from /mcp or from the OAuth resource parameter", () => {
  assert.equal(connectHintFrom("https://h/mcp?connect=RM-abc123XYZ"), code);
  const authorize = `https://h/oauth/authorize?client_id=x&resource=${encodeURIComponent("https://h/mcp?connect=RM-abc123XYZ")}`;
  assert.equal(connectHintFrom(authorize), code);
  assert.equal(connectHintFrom("https://h/mcp?connect=RM-%3Cx%3E"), null);
  assert.equal(connectHintFrom("https://h/mcp"), null);
  assert.equal(connectHintFrom("::not a url"), null);
});

test("consent opens on the invited connection and hides dead codes", () => {
  const live = { roomId: "launch", title: "Launch room", profile: "contribute", displayName: "Codex", expiresAt: Date.now() + 60000 };
  const ctx = consentContextFor(live, code);
  assert.equal(ctx.heading, "Connect Codex to Launch room");
  assert.match(ctx.line, /take tasks/);
  assert.equal(consentContextFor({ ...live, expiresAt: Date.now() - 1 }, code), null);
  assert.equal(consentContextFor(null, code), null);
  assert.equal(consentContextFor(live, "nope"), null);
});

test("room text is flattened before it reaches the consent heading", () => {
  const ctx = consentContextFor({ roomId: "r", title: "Line\nbreak\u0007", profile: "chat" }, code);
  assert.equal(ctx.heading, "Connect this agent to Line break");
});

test("the /a/<code> page names this invite's MCP URL", async () => {
  const { renderAgentConnectMarkdown } = await import("../server/routes/agent-connect.mjs");
  const text = renderAgentConnectMarkdown({ origin: "https://room.example.test", code, roomId: "launch", title: "Launch", purpose: "", profile: "contribute", permissions: [], expiresAt: Date.now() + 600000, claims: [] });
  assert.ok(text.includes("MCP URL for this invite: https://room.example.test/mcp?connect=RM-abc123XYZ"));
});
