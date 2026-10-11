import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const runner = new URL("../scripts/native-host-request-run.mjs", import.meta.url).pathname;

test("native-host runner refuses invalid invocations without starting a host", () => {
  for (const args of [[], ["unknown", "unused", "review", "unused"], ["claude", "unused", "unknown", "unused"]]) {
    const r = spawnSync(process.execPath, [runner, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /Choose host, fixture metadata, phase/);
  }
});

test("existing native evidence refuses before model execution and remains untouched", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-native-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = join(directory, "fixture.json"), output = join(directory, "evidence.json");
  writeFileSync(metadata, JSON.stringify({ origin: "http://127.0.0.1:1", directory, participants: [{ memberId: "reviewer",
    configDirectory: join(directory, "missing-config"), attentionDirectory: join(directory, "missing-attention") }] }));
  writeFileSync(output, "Original evidence");
  for (const host of ["codex", "claude"]) {
    const r = spawnSync(process.execPath, [runner, host, metadata, "review", output], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 1); assert.match(r.stderr, /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), "Original evidence");
  }
});

// Exercise the actual runner with a local stand-in, never an installed agent,
// provider, Room server, saved identity or network endpoint.
function runSyntheticHost(t, { host = "codex", stdout, code = 0, signal = null }) {
  const directory = mkdtempSync(join(tmpdir(), "room-native-terminal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metadata = join(directory, "fixture.json"), output = join(directory, "evidence.json");
  const binary = join(directory, "synthetic-host");
  writeFileSync(metadata, JSON.stringify({ origin: "http://127.0.0.1:1", directory, participants: [{ memberId: "reviewer",
    configDirectory: join(directory, "missing-config"), attentionDirectory: join(directory, "missing-attention") }] }));
  const stderr = "private diagnostic must stay in evidence";
  writeFileSync(binary, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});${signal ? `process.kill(process.pid, ${JSON.stringify(signal)});` : `process.exitCode=${code};`}});\n`);
  chmodSync(binary, 0o700);
  const result = spawnSync(process.execPath, [runner, host, metadata, "review", output], {
    encoding: "utf8", timeout: 5000,
    env: { PATH: "", ROOM_NATIVE_CODEX_BIN: binary, ROOM_NATIVE_CLAUDE_BIN: binary }
  });
  assert.equal(result.error, undefined);
  const evidence = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(evidence.stdout, stdout, "terminal diagnostics must not rewrite raw stdout");
  assert.equal(evidence.stderr, stderr, "failed runs must retain private diagnostics");
  assert.equal(evidence.code, signal ? null : code);
  assert.equal(evidence.signal, signal);
  assert.equal(result.stdout.includes(stderr), false);
  assert.equal(result.stderr.includes(stderr), false);
  return { ...result, summary: JSON.parse(result.stdout.trim().split("\n").at(-1)) };
}
const started = [{ type: "thread.started", thread_id: "private-thread-id" }, { type: "turn.started" }];
const completed = { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
const jsonl = events => events.map(event => JSON.stringify(event)).join("\r\n");

for (const [name, events, disposition] of [
  ["EOF before terminal", started, "incomplete"],
  ["failed turn", [...started, { type: "turn.failed", error: { message: "private failure" } }], "failed"],
  ["fatal stream error", [...started, { type: "error", message: "private error" }, completed], "failed"],
  ["malformed terminal", [...started, { type: "turn.completed", usage: {} }], "incomplete"],
  ["wrong dialect", [...started, { jsonrpc: "2.0", method: "turn/completed", params: {} }, completed], "incomplete"]
]) test(`Codex acceptance rejects exit zero with ${name} after preserving evidence`, t => {
  const result = runSyntheticHost(t, { stdout: jsonl(events) });
  assert.equal(result.status, 1, "process exit zero alone is not terminal evidence");
  assert.equal(result.summary.codexEvidence.turn.disposition, disposition);
  assert.equal(result.stdout.includes("private-thread-id"), false);
});

test("Codex acceptance distinguishes completed tools and turns from independently verified work", t => {
  const events = [...started, { type: "item.completed", item: { id: "private-item", type: "command_execution",
    command: "private command", aggregated_output: "private output", status: "failed", exit_code: 7 } },
    { type: "future.optional", payload: "private unknown payload" }, completed];
  const result = runSyntheticHost(t, { stdout: jsonl(events) });
  assert.equal(result.status, 0);
  const evidence = result.summary.codexEvidence;
  assert.equal(evidence.turn.disposition, "completed");
  assert.equal(evidence.items.failed, 1);
  assert.equal(evidence.events.unknown, 1);
  assert.equal(evidence.verification.roomAcceptance, "not_established");
  assert.equal(evidence.verification.tests, "not_established");
  assert.equal(/private-(?:thread|item)|private (?:command|output|unknown)/.test(result.stdout), false);
});

for (const termination of [{ code: 7 }, { signal: "SIGTERM" }])
  test(`Codex acceptance rejects completed evidence with process ${JSON.stringify(termination)}`, t => {
    const result = runSyntheticHost(t, { stdout: jsonl([...started, completed]), ...termination });
    assert.equal(result.status, 1);
    assert.equal(result.summary.codexEvidence.turn.disposition, "completed");
    assert.notEqual(result.summary.codexEvidence.process.disposition, "exited_zero");
  });

test("Claude acceptance retains its existing process-exit contract", t => {
  for (const code of [0, 7]) {
    const result = runSyntheticHost(t, { host: "claude", stdout: "synthetic Claude output", code });
    assert.equal(result.status, code === 0 ? 0 : 1);
    assert.equal(Object.hasOwn(result.summary, "codexEvidence"), false);
  }
});

test("Codex progress omits malformed and unapproved labels without rewriting evidence", t => {
  const sentinel = "PRIVATE_PROGRESS_PAYLOAD";
  const item = { id: "tool-1", type: "mcp_tool_call", server: "room", tool: "room_read_work", status: "completed" };
  for (const event of [
    { type: "item.completed", item: { ...item, tool: { secret: sentinel } } },
    { type: "item.completed", item: { ...item, status: { secret: sentinel } } },
    { type: { secret: sentinel }, item },
    { type: "item.completed", item: { ...item, tool: sentinel } }
  ]) {
    const result = runSyntheticHost(t, { stdout: jsonl([...started, event, completed]) });
    assert.equal((result.stdout + result.stderr).includes(sentinel), false, "untrusted progress labels are private data");
    assert.equal(result.stdout.trim().split("\n").length, 1, "only the redacted final summary is public");
  }
});

test("Codex progress keeps known tool labels and omits tool payloads", t => {
  const sentinel = "PRIVATE_TOOL_PAYLOAD";
  const result = runSyntheticHost(t, { stdout: jsonl([...started, { type: "item.completed", item: {
    id: "tool-1", type: "mcp_tool_call", server: "room", tool: "room_read_work", status: "completed",
    arguments: { secret: sentinel }, result: { content: [{ type: "text", text: sentinel }] }
  } }, completed]) });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.split("\n")[0]), {
    host: "codex", phase: "review", event: "item.completed", tool: "room_read_work", status: "completed"
  });
  assert.equal((result.stdout + result.stderr).includes(sentinel), false);
});

test("Claude progress exposes only existing allowlisted tool names", t => {
  const sentinel = "PRIVATE_CLAUDE_PROGRESS";
  const stdout = jsonl([{ type: "assistant", message: { content: [null,
    { type: "tool_use", name: { secret: sentinel } }, { type: "tool_use", name: sentinel },
    { type: "tool_use", name: "mcp__room__room_read_work", input: { secret: sentinel } }
  ] } }, { type: "result" }]);
  const result = runSyntheticHost(t, { host: "claude", stdout });
  assert.equal(result.status, 0);
  assert.equal((result.stdout + result.stderr).includes(sentinel), false);
  assert.equal(result.stdout.trim().split("\n").length, 2);
  assert.deepEqual(JSON.parse(result.stdout.split("\n")[0]), {
    host: "claude", phase: "review", event: "tool_use", tool: "mcp__room__room_read_work"
  });
});
