import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, createReadStream, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { validId } from "../src/events.js";

const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const runFile = promisify(execFile);
async function git(cwd, args) {
  try {
    return (await runFile("/usr/bin/git", args, { cwd, timeout: 15000, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" })).stdout;
  } catch (error) {
    throw Error(error.killed ? `git_${args[0]}_timeout` : `git_${args[0]}_failed`);
  }
}
const revision = async (cwd, ref) => (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).toString().trim();

async function source(cwd) {
  const head = await revision(cwd, "HEAD");
  const diff = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--binary", head, "--"]);
  const names = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
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

async function runAffected(cwd, base, signal) {
  signal?.throwIfAborted();
  const start = performance.now();
  active = spawn(process.execPath, [join(cwd, "scripts/verify-affected.mjs"), `--base=${base}`], {
    cwd, detached: true, stdio: ["ignore", "pipe", "ignore"],
    env: Object.fromEntries(["HOME", "PATH", "LANG", "TMPDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  });
  const timeout = setTimeout(stop, 285000);
  signal?.addEventListener("abort", stop, { once: true });
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
  } finally {
    clearTimeout(timeout); signal?.removeEventListener("abort", stop); lines.close(); active = null;
  }
}

const networkCodes = ["ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"];
const retryable = error => error.name === "TimeoutError" || networkCodes.includes(error.cause?.code ?? error.code);

export async function inspectAffectedCheckout({ worktree, base: baseRef, expectedHead }) {
  const cwd = realpathSync((await git(worktree, ["rev-parse", "--show-toplevel"])).toString().trimEnd());
  if (expectedHead && cwd !== worktree) throw Error("worktree_mismatch");
  const before = await source(cwd);
  if (expectedHead && (before.head !== expectedHead || before.dirty)) throw Error("checkout_not_pinned_clean_head");
  const requestedBase = await revision(cwd, baseRef);
  const base = (await git(cwd, ["merge-base", requestedBase, before.head])).toString().trim();
  if (expectedHead && base !== baseRef) throw Error("baseline_not_ancestor");
  return { cwd, before, base };
}

export async function collectAffectedEvidence({ worktree, base: baseRef, expectedHead, workRevision, signal, onStage = () => {} }) {
  onStage("inspect_worktree");
  const { cwd, before, base } = await inspectAffectedCheckout({ worktree, base: baseRef, expectedHead });
  onStage("run_tests", before.head);
  const outcome = await runAffected(cwd, base, signal);
  signal?.throwIfAborted();
  onStage("recheck_worktree");
  if ((await source(cwd)).fingerprint !== before.fingerprint) outcome.status = "stale";
  return { kind: "desktop_affected_tests", workRevisionAtStart: workRevision,
    head: before.head, base, dirty: before.dirty, worktreeFingerprint: `sha256:${before.fingerprint}`, ...outcome };
}

let stage = "read_input";
async function main() {
  let bytes = "";
  for await (const chunk of process.stdin) { bytes += chunk; if (bytes.length > 16384) throw Error("invalid_input"); }
  const input = JSON.parse(bytes);
  if (!validId(input.workItemId) || typeof input.base !== "string" || !/^[a-z\d_][\w./-]{0,255}$/i.test(input.base)) throw Error("invalid_input");
  stage = "read_connection";
  const connection = readAgentConnection(input.connection);
  if (["origin", "roomId", "memberId"].some(key => connection[key] !== input[key])) throw Error("room_connection_changed");
  const client = new RoomAgentClient(connection);
  stage = "read_work_item";
  const readWork = () => client.workContext(input.workItemId, { signal: AbortSignal.timeout(13000) });
  let work;
  try { work = await readWork(); }
  catch (error) {
    if (!retryable(error)) throw error;
    work = await readWork();
  }
  const evidence = await collectAffectedEvidence({ worktree: input.worktree, base: input.base, workRevision: work.work.revision,
    onStage: (name, head) => {
      stage = name;
      if (name === "run_tests") emit({ phase: "running", head, roomId: connection.roomId });
    } });
  const id = `desktop-affected-${randomUUID()}`;
  const command = { id, type: "message.posted", data: { messageId: id, workItemId: input.workItemId,
    body: `Local affected tests. ${evidence.status}. ${evidence.elapsedMs} ms.\n${JSON.stringify(evidence)}\nEvidence from this Mac’s selected checkout.` } };
  const send = () => client.command(command, { signal: AbortSignal.timeout(10000) });
  let receipt;
  try { receipt = await send(); }
  catch { try { receipt = await send(); } catch { /* recover by exact operation ID */ } }
  const recorded = receipt?.event?.actorId === connection.memberId && receipt.event.data?.messageId === id
    && receipt.event.data?.workItemId === input.workItemId && receipt.event.data?.body === command.data.body;
  emit({ phase: "finished", evidence, operationId: id, recorded: Boolean(recorded), sequence: recorded ? receipt.sequence : null });
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.once("SIGTERM", () => { stop(); process.exit(143); });
  process.once("SIGINT", () => { stop(); process.exit(130); });
  main().catch(error => {
    const safe = ["invalid_input", "unsupported_worktree_entry", "room_connection_changed", "access_ended", "identity_mismatch", "config_not_found", "config_not_private"];
    const code = error.code ?? error.cause?.code ?? error.message;
    const diagnostic = /^git_(rev-parse|diff|ls-files|merge-base)_(timeout|failed)$/.test(code) || [...safe, ...networkCodes, "work_not_found", "invalid_response"].includes(code) ? code
      : error.name === "TimeoutError" ? "timeout" : "unavailable";
    emit({ phase: "error", code: `${stage}: ${diagnostic}` });
    process.exitCode = 1;
  });
}
