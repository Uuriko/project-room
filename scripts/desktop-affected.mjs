import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { validId } from "../src/events.js";

const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const git = (cwd, args) => execFileSync("/usr/bin/git", args, { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
const revision = (cwd, ref) => git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString().trim();

async function source(cwd) {
  const head = revision(cwd, "HEAD");
  const diff = git(cwd, ["diff", "--no-ext-diff", "--binary", head, "--"]);
  const names = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const hash = createHash("sha256").update(JSON.stringify([head, diff.length])).update(diff).update(names);
  for (const name of names.toString().split("\0").filter(Boolean)) {
    const file = join(cwd, name), stat = lstatSync(file);
    const contents = createHash("sha256");
    if (stat.isSymbolicLink()) contents.update(readlinkSync(file));
    else if (stat.isFile()) for await (const chunk of createReadStream(file)) contents.update(chunk);
    else throw Error("unsupported_worktree_entry");
    hash.update(JSON.stringify([name, stat.mode, contents.digest("hex")]));
  }
  return { head, dirty: diff.length > 0 || names.length > 0, fingerprint: hash.digest("hex") };
}

let active;
function stop() {
  if (active?.pid) try { process.kill(-active.pid, "SIGKILL"); } catch { /* already exited */ }
}
process.once("SIGTERM", () => { stop(); process.exit(143); });
process.once("SIGINT", () => { stop(); process.exit(130); });

async function runAffected(cwd, base) {
  const start = performance.now();
  active = spawn(process.execPath, [join(cwd, "scripts/verify-affected.mjs"), `--base=${base}`], {
    cwd, detached: true, stdio: ["ignore", "pipe", "ignore"],
    env: Object.fromEntries(["HOME", "PATH", "LANG", "TMPDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  });
  const timeout = setTimeout(stop, 285000);
  const lines = createInterface({ input: active.stdout });
  let selected = null, omitted = 0, tests = null, failed = null, terminalExit = null;
  lines.on("line", line => {
    const plan = /^verify:affected: \d+ changed file\(s\) vs [a-f0-9]+; (\d+) test file\(s\) selected/.exec(line);
    const skip = /^\s+(\d+) more related test file\(s\) skipped/.exec(line);
    const count = /^ℹ tests (\d+)$/.exec(line);
    const failures = /^ℹ fail (\d+)$/.exec(line);
    const finished = /^verify:affected: exit (\d+) in /.exec(line);
    if (plan) selected = Number(plan[1]);
    if (skip) omitted = Number(skip[1]);
    if (count) tests = Number(count[1]);
    if (failures) failed = Number(failures[1]);
    if (finished) terminalExit = Number(finished[1]);
  });
  try {
    const exitCode = await new Promise((resolve, reject) => { active.once("error", reject); active.once("close", resolve); });
    const status = exitCode === 0 && selected === 0 ? "not_run"
      : exitCode === 0 && terminalExit === 0 && tests > 0 && failed === 0 ? "passed"
        : exitCode !== 0 && failed > 0 ? "failed" : "incomplete";
    return { status, selected, omitted, tests, failed, exitCode, elapsedMs: Math.round(performance.now() - start) };
  } finally { clearTimeout(timeout); lines.close(); active = null; }
}

async function main() {
  let bytes = "";
  for await (const chunk of process.stdin) { bytes += chunk; if (bytes.length > 16384) throw Error("invalid_input"); }
  const input = JSON.parse(bytes);
  if (!validId(input.workItemId) || typeof input.base !== "string" || !/^[a-z\d_][\w./-]{0,255}$/i.test(input.base)) throw Error("invalid_input");
  const connection = readAgentConnection(input.connection);
  if (["origin", "roomId", "memberId"].some(key => connection[key] !== input[key])) throw Error("room_connection_changed");
  const client = new RoomAgentClient(connection);
  await client.checkConnection({ signal: AbortSignal.timeout(10000) });
  const work = await client.workContext(input.workItemId, { signal: AbortSignal.timeout(10000) });
  const cwd = realpathSync(git(input.worktree, ["rev-parse", "--show-toplevel"]).toString().trimEnd());
  const requestedBase = revision(cwd, input.base), before = await source(cwd);
  const base = git(cwd, ["merge-base", requestedBase, before.head]).toString().trim();
  emit({ phase: "running", head: before.head, roomId: connection.roomId });
  const outcome = await runAffected(cwd, base);
  if ((await source(cwd)).fingerprint !== before.fingerprint) outcome.status = "stale";
  const evidence = { kind: "desktop_affected_tests", workRevisionAtStart: work.work.revision,
    head: before.head, base, dirty: before.dirty, worktreeFingerprint: `sha256:${before.fingerprint}`, ...outcome };
  const id = `desktop-affected-${randomUUID()}`;
  const command = { id, type: "message.posted", data: { messageId: id, workItemId: input.workItemId,
    body: `Local affected tests. ${outcome.status}. ${outcome.elapsedMs} ms.\n${JSON.stringify(evidence)}\nEvidence from this Mac’s selected checkout.` } };
  const send = () => client.command(command, { signal: AbortSignal.timeout(10000) });
  let receipt;
  try { receipt = await send(); }
  catch { try { receipt = await send(); } catch { /* recover by exact operation ID */ } }
  const recorded = receipt?.event?.actorId === connection.memberId && receipt.event.data?.messageId === id
    && receipt.event.data?.workItemId === input.workItemId && receipt.event.data?.body === command.data.body;
  emit({ phase: "finished", evidence, operationId: id, recorded: Boolean(recorded), sequence: recorded ? receipt.sequence : null });
}

main().catch(error => {
  const safe = ["invalid_input", "unsupported_worktree_entry", "room_connection_changed", "access_ended", "identity_mismatch", "config_not_found", "config_not_private"];
  const code = error.code ?? error.message;
  emit({ phase: "error", code: safe.includes(code) ? code : "local_check_unavailable" });
  process.exitCode = 1;
});
