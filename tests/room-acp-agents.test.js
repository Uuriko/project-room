// room-acp B1: argument parsing, agent detection and the initialize probe
// against the scripted fake ACP agent.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../room-acp/src/args.mjs";
import { candidates, probe, splitCommand, spawnAgent, childEnvFor, KNOWN_AGENTS } from "../room-acp/src/agents.mjs";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
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

test("spawnAgent excludes unnamed ambient credential variables (RES-0151/RES-0145, one site)", async t => {
  // Dummy sentinels only; nothing here is a real credential.
  const env = {
    PATH: process.env.PATH, HOME: "/tmp/fakehome", CODEX_PATH: "/opt/codex", FAKE_ACP_MODE: "echo",
    OPENAI_API_KEY: "DUMMY-openai", ANTHROPIC_API_KEY: "DUMMY-anthropic", GH_TOKEN: "DUMMY-gh",
    GITHUB_TOKEN: "DUMMY-github", AWS_SECRET_ACCESS_KEY: "DUMMY-aws", AWS_SESSION_TOKEN: "DUMMY-awssession",
    STRIPE_SECRET_KEY: "DUMMY-stripe", NPM_TOKEN: "DUMMY-npm", CUSTOM_UNLISTED_SECRET: "DUMMY-custom",
    ROOM_AGENT_TOKEN: "DUMMY-roomagent", PROJECT_ROOM_SECRET: "DUMMY-projectroom",
    ROOM_TOKEN: "DUMMY-roomtoken", ROOM_CREDENTIAL: "DUMMY-roomcred", ROOM_ACP_X: "DUMMY-roomacp",
  };
  assert.deepEqual(Object.keys(childEnvFor(env)).sort(), ["CODEX_PATH", "FAKE_ACP_MODE", "HOME", "PATH"]);
  const dir = mkdtempSync(pathJoin(tmpdir(), "room-acp-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { child, peer } = spawnAgent(
    { id: "dump", label: "Dump", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('env-dump.json', JSON.stringify(process.env))"] },
    { cwd: dir, env },
  );
  await new Promise(resolve => child.once("exit", resolve));
  peer.close();
  const seen = JSON.parse(readFileSync(pathJoin(dir, "env-dump.json"), "utf8"));
  for (const key of ["PATH", "HOME", "CODEX_PATH", "FAKE_ACP_MODE"]) assert.equal(seen[key], env[key], key);
  for (const key of Object.keys(env)) if (!["PATH", "HOME", "CODEX_PATH", "FAKE_ACP_MODE"].includes(key)) assert.equal(seen[key], undefined, `${key} crossed to the child`);
});

test("spawnAgent preserves an explicitly selected Codex configuration directory", async t => {
  const dir = mkdtempSync(pathJoin(tmpdir(), "room-acp-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = pathJoin(dir, "home"), custom = pathJoin(dir, "custom-codex");
  mkdirSync(pathJoin(home, ".codex"), { recursive: true });
  mkdirSync(custom);
  writeFileSync(pathJoin(home, ".codex", "config.toml"), "default synthetic profile");
  writeFileSync(pathJoin(custom, "config.toml"), "selected synthetic profile");
  const script = "const fs=require('node:fs'),p=require('node:path');fs.writeFileSync('selected-profile.txt',fs.readFileSync(p.join(process.env.CODEX_HOME||p.join(process.env.HOME,'.codex'),'config.toml')))";
  const { child, peer } = spawnAgent({ id: "config", command: process.execPath, args: ["-e", script] },
    { cwd: dir, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: custom } });
  await new Promise(resolve => child.once("exit", resolve));
  peer.close();
  assert.equal(readFileSync(pathJoin(dir, "selected-profile.txt"), "utf8"), "selected synthetic profile");
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
  const dir = mkdtempSync(pathJoin(tmpdir(), "room-acp-path-"));
  writeFileSync(pathJoin(dir, "claude"), "#!/bin/sh\n"); chmodSync(pathJoin(dir, "claude"), 0o755);
  const lines = [];
  const code = await main(["doctor"], { print: line => lines.push(line), env: { PATH: dir } });
  const text = lines.join("\n");
  assert.equal(code, 1);
  assert.match(text, /claude is installed but does not speak ACP by itself/);
  assert.match(text, /npm i -g @agentclientprotocol\/claude-agent-acp/);
  assert.match(text, /npm i -g @agentclientprotocol\/codex-acp@2\.5\.0/);
  assert.match(text, /--agent-cmd/);
});

test("spawnAgent preserves exact locale/location/fixture names and excludes arbitrary prefixed context", async t => {
  const exact = ["LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
    "FAKE_ACP_MODE", "FAKE_ACP_DELAY_MS", "FAKE_ACP_TRACE"];
  const excluded = ["LC_ROOM_TOKEN", "XDG_GITHUB_TOKEN", "FAKE_ACP_OPENAI_API_KEY", "LC_ALL_EXTRA", "XDG_CONFIG_HOME_TOKEN", "FAKE_ACP_MODE_SECRET"];
  const env = { HOME: "/synthetic/home", CODEX_HOME: "/synthetic/chosen-codex", CODEX_PATH: "/synthetic/codex" };
  for (const name of [...exact, ...excluded]) env[name] = "synthetic-placeholder-" + name.toLowerCase();
  const dir = mkdtempSync(pathJoin(tmpdir(), "room-acp-exact-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { child, peer } = spawnAgent({ command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('observed.json',JSON.stringify(process.env))"] }, { cwd: dir, env });
  t.after(() => { peer.close(); child.kill(); });
  const code = await new Promise((resolve, reject) => child.once("exit", resolve).once("error", reject));
  assert.equal(code, 0);
  const observed = JSON.parse(readFileSync(pathJoin(dir, "observed.json"), "utf8"));
  for (const name of [...exact, "HOME", "CODEX_HOME", "CODEX_PATH"]) assert.equal(observed[name], env[name], name);
  for (const name of excluded) assert.equal(Object.hasOwn(observed, name), false, `${name} crossed to child`);
});
