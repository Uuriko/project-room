// room-acp: join without a listener, set up an MCP host without putting the
// credential in the host's config, and check the saved connection.
import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { parseArgs } from "../room-acp/src/args.mjs";
import { main, mcpHostLines } from "../room-acp/src/cli.mjs";
import { loadConnection, mcpHeadersFile } from "../room-acp/src/credentials.mjs";
import { startRoom } from "./room-acp-fixture.mjs";

const run = async (argv, io) => { const lines = []; const code = await main(argv, { print: line => lines.push(line), ...io }); return { code, text: lines.join("\n") }; };

test("args: --no-listen, --mcp, mcp-config and doctor --connection are accepted only where they mean something", () => {
  assert.equal(parseArgs(["https://x.example/a/RM-ABCDEFGHJKMNPQRS", "--no-listen"]).noListen, true);
  assert.equal(parseArgs(["https://x.example/a/RM-ABCDEFGHJKMNPQRS", "--mcp", "claude"]).mcp, "claude");
  assert.equal(parseArgs(["mcp-config", "--mcp", "codex"]).command, "mcp-config");
  assert.equal(parseArgs(["doctor", "--connection"]).connection, true);
  assert.throws(() => parseArgs(["run", "--no-listen"]), /--no-listen applies only/);
  assert.throws(() => parseArgs(["mcp-config"]), /needs --mcp/);
  assert.throws(() => parseArgs(["status", "--mcp", "claude"]), /--mcp applies only/);
  assert.throws(() => parseArgs(["status", "--connection"]), /--connection applies only/);
  assert.throws(() => parseArgs(["mcp-config", "--mcp", "emacs"]), /claude or codex/);
});

test("join --no-listen saves the connection without probing for an ACP adapter", async t => {
  const room = await startRoom(t);
  const { link } = room.invite();
  // No agent flags and no fake adapter: the old path would try to find one and refuse.
  const { code, text } = await run([link, "--name", "Coder", "--no-listen"], { env: { ...room.env, PATH: "" } });
  assert.equal(code, 0, text);
  assert.match(text, /Joined room commons/);
  assert.equal(loadConnection({}, room.env).roomId, "commons");
});

test("join --mcp claude writes a private header file and prints a command with no secret in it", async t => {
  const room = await startRoom(t);
  const { link, code: inviteCode } = room.invite();
  const { code, text } = await run([link, "--name", "Coder", "--mcp", "claude"], { env: room.env });
  assert.equal(code, 0, text);
  const saved = loadConnection({}, room.env);
  const file = mcpHeadersFile("commons", room.env);
  const headers = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(headers), ["Authorization"]);
  assert.match(headers.Authorization, /^Bearer pri_/);
  assert.equal(headers.Authorization, `Bearer ${saved.identitySecret}`);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const secret of [saved.credential, saved.identitySecret, inviteCode]) assert.ok(!text.includes(secret), "the printed setup must not contain a secret");
  assert.match(text, /claude mcp add-json project-room /);
  assert.match(text, /headersHelper/);
  assert.ok(text.includes(`${room.origin}/mcp?profile=full`));
  // The header file is not mistaken for a saved connection.
  assert.equal(readdirSync(room.home).filter(name => name.endsWith(".json")).length, 1);
  assert.equal(loadConnection({}, room.env).roomId, "commons");
  // The header the host will send is accepted by the Room's /mcp endpoint.
  const response = await fetch(`${room.origin}/mcp`, { method: "POST", headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });
  assert.equal(response.status, 200);
});

test("mcp-config codex prints a TOML block and reuses the saved connection; logout removes the header file", async t => {
  const room = await startRoom(t);
  const { link } = room.invite();
  assert.equal((await run([link, "--name", "Coder", "--no-listen"], { env: room.env })).code, 0);
  const { code, text } = await run(["mcp-config", "--mcp", "codex"], { env: room.env });
  assert.equal(code, 0, text);
  assert.match(text, /\[mcp_servers\.project-room\]/);
  assert.match(text, /http_headers_helper = /);
  assert.ok(text.includes(`${room.origin}/mcp?profile=full`));
  assert.ok(!text.includes(loadConnection({}, room.env).identitySecret));
  assert.ok(statSync(mcpHeadersFile("commons", room.env)).isFile());
  assert.equal((await run(["logout"], { env: room.env })).code, 0);
  assert.throws(() => statSync(mcpHeadersFile("commons", room.env)), { code: "ENOENT" });
});

test("mcp-config without a saved connection says how to join instead of failing silently", async t => {
  const room = await startRoom(t);
  const { code, text } = await run(["mcp-config", "--mcp", "claude"], { env: room.env });
  assert.equal(code, 1);
  assert.match(text, /Not joined/);
});

test("mcpHostLines quotes a path with spaces and a single quote safely", () => {
  const connection = { apiBase: "https://room.example.net/" };
  const [, line] = mcpHostLines(connection, "claude", "/home/a b/it's/x.headers.json", "linux");
  assert.ok(line.includes("https://room.example.net/mcp?profile=full"));
  assert.ok(!line.includes("net//mcp"));
  // Round trip through a real shell: the JSON the host receives must hold the exact reader command.
  if (process.platform !== "win32") {
    const argv = JSON.parse(execFileSync("bash", ["-c", `printf %s ${line.trim().split("add-json project-room ")[1].replace(/ --scope user$/, "")}`], { encoding: "utf8" }));
    assert.equal(argv.headersHelper, "cat '/home/a b/it'\\''s/x.headers.json'");
    assert.equal(execFileSync("bash", ["-c", `printf %s ${JSON.stringify(argv.headersHelper)} | sed 's/^cat //'`], { encoding: "utf8" }), "'/home/a b/it'\\''s/x.headers.json'");
  }
  const win = mcpHostLines(connection, "codex", "C:\\Users\\a b\\x.headers.json", "win32").join("\n");
  assert.match(win, /type \\"C:/);
});

test("doctor --connection confirms a working connection and reports a rejected one without printing the secret", async t => {
  const room = await startRoom(t);
  const { link } = room.invite();
  assert.equal((await run([link, "--name", "Coder", "--no-listen"], { env: room.env })).code, 0);
  const good = await run(["doctor", "--connection"], { env: room.env });
  assert.equal(good.code, 0, good.text);
  assert.match(good.text, /^ok   room commons/);
  const saved = loadConnection({}, room.env);
  const rejected = await run(["doctor", "--connection"], { env: room.env, fetchImpl: async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }) });
  assert.equal(rejected.code, 1);
  assert.match(rejected.text, /^fail room commons/);
  for (const secret of [saved.credential, saved.identitySecret]) assert.ok(!rejected.text.includes(secret));
  assert.equal((await run(["logout"], { env: room.env })).code, 0);
  const none = await run(["doctor", "--connection"], { env: room.env });
  assert.equal(none.code, 1);
  assert.match(none.text, /No saved connection/);
});
