// room-acp B1: argument parsing, agent detection and the initialize probe
// against the scripted fake ACP agent.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../room-acp/src/args.mjs";
import { candidates, probe, splitCommand, KNOWN_AGENTS } from "../room-acp/src/agents.mjs";
import { main } from "../room-acp/src/cli.mjs";

const fake = fileURLToPath(new URL("../room-acp/fixtures/fake-agent.mjs", import.meta.url));
const fakeCmd = `"${process.execPath}" "${fake}"`;

test("parseArgs: link, subcommands, options and errors", () => {
  assert.equal(parseArgs(["https://room.trydemigod.com/join/RM-ABC"]).command, "join");
  assert.equal(parseArgs(["doctor", "--agent", "codex"]).agent, "codex");
  assert.equal(parseArgs([]).command, "run");
  assert.equal(parseArgs(["--max-sessions", "2"]).maxSessions, 2);
  assert.throws(() => parseArgs(["--max-sessions", "0"]), /1\.\.32/);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["--agent"]), /needs a value/);
  assert.throws(() => parseArgs(["--respond-to", "everyone"]), /owner or anyone/);
});

test("known agents use the verified ACP commands", () => {
  const byId = Object.fromEntries(KNOWN_AGENTS.map(entry => [entry.id, entry]));
  assert.deepEqual(byId.claude.npx, ["-y", "@agentclientprotocol/claude-agent-acp"]);
  assert.deepEqual(byId.codex.npx, ["-y", "@agentclientprotocol/codex-acp@2.5.0"]);
  assert.deepEqual(byId.goose.args, ["acp"]);
  assert.deepEqual(byId.gemini.args, ["--acp"]);
});

test("candidates: custom command wins; npx fallback only when an agent is named", () => {
  assert.deepEqual(splitCommand('"/a b/node" x.mjs'), { command: "/a b/node", args: ["x.mjs"] });
  assert.equal(candidates({ agentCmd: fakeCmd })[0].id, "custom");
  assert.deepEqual(candidates({ env: { PATH: "" } }), []);
  assert.equal(candidates({ agent: "claude", env: { PATH: "" } })[0].command, "npx");
  assert.throws(() => candidates({ agent: "nope" }), /unknown agent/);
});

test("probe: initialize against the fake agent reports capabilities", async () => {
  const [candidate] = candidates({ agentCmd: fakeCmd });
  const result = await probe(candidate);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.capabilities.protocolVersion, 1);
  assert.equal(result.capabilities.loadSession, true);
});

test("probe: a missing binary fails without throwing", async () => {
  const result = await probe({ id: "x", label: "X", command: "/nonexistent/acp-agent", args: [] });
  assert.equal(result.ok, false);
});

test("doctor lists the fake agent's capabilities", async () => {
  const lines = [];
  const code = await main(["doctor", "--agent-cmd", fakeCmd], { print: line => lines.push(line) });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /ok\s+Custom agent \(custom\): protocol 1, loadSession yes/);
});

// KI-032: with no ACP agent installed, doctor names each adapter to install,
// and says plainly when plain `claude` is present but cannot speak ACP.
test("doctor with no ACP agent names the adapters and flags plain claude", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const dir = mkdtempSync(joinPath(tmpdir(), "room-acp-path-"));
  writeFileSync(joinPath(dir, "claude"), "#!/bin/sh\n"); chmodSync(joinPath(dir, "claude"), 0o755);
  const lines = [];
  const code = await main(["doctor"], { print: line => lines.push(line), env: { PATH: dir } });
  const text = lines.join("\n");
  assert.equal(code, 1);
  assert.match(text, /claude is installed but does not speak ACP by itself/);
  assert.match(text, /npm i -g @agentclientprotocol\/claude-agent-acp/);
  assert.match(text, /npm i -g @agentclientprotocol\/codex-acp@2\.5\.0/);
  assert.match(text, /--agent-cmd/);
});
