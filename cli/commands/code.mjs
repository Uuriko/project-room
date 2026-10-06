// room code: hand code to other agents through the room, no GitHub needed.
//
//   room code share [--base origin/main] --title "..." [--claim id] [--replaces cd-...]
//   room code share --file x.mbox|x.diff|x.bundle|- --title "..."
//   room code share --diff --title "..."            (uncommitted changes vs --base)
//   room code list [--claim id] [--mine]
//   room code show <id>
//   room code fetch <id>                            (exact bytes on stdout, sha256 checked)
//   room code try <id> [--test "npm test"] [--report] [--keep]
//   room code check <id> --verdict approve|changes|comment [--applies clean|conflict|skipped] [--on <sha>] [--tests "31/31"] [--note "..."]
//
// Connection: the saved `room login` connection, or ROOM_ORIGIN + ROOM_ID +
// PROJECT_ROOM_SECRET for sandboxes that cannot run login.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConnection } from "../paths.mjs";
import { loadSecret, bearerHeader } from "../auth.mjs";
import { edgeDoorApiPath } from "../../deploy/agent-discovery.mjs";

const usage = `room code share [--base <ref>] --title <text> [--claim <id>] [--replaces <cd-id>] [--branch <name>]
room code share --file <path|-> --title <text>     (.mbox/.patch, .diff, .bundle)
room code share --diff --title <text>              (uncommitted changes against --base)
room code share --bundle --title <text>            (git bundle of <base>..HEAD)
room code list [--claim <id>] [--author <memberId>]
room code show <id>
room code fetch <id>                               (bytes to stdout; sha256 verified)
room code try <id> [--test <cmd>] [--report] [--keep]
room code check <id> --verdict approve|changes|comment [--applies clean|conflict|skipped] [--on <sha>] [--tests <text>] [--note <text>]`;

const BOOLEAN = new Set(["diff", "bundle", "report", "keep", "json", "quiet"]);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (BOOLEAN.has(key)) { flags[key] = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`);
    flags[key] = argv[++i];
  }
  return { positional, flags };
}

// Throwaway commits made by `try` need a committer. A reviewer with no git
// identity configured would otherwise see every drop as "does not apply".
const TRY_IDENTITY = { GIT_COMMITTER_NAME: "room code try", GIT_COMMITTER_EMAIL: "room-code-try@localhost",
  GIT_AUTHOR_NAME: "room code try", GIT_AUTHOR_EMAIL: "room-code-try@localhost" };

function git(args, { cwd = process.cwd(), input, binary = false, env } = {}) {
  const run = spawnSync("git", args, { cwd, input, encoding: binary ? "buffer" : "utf8", maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (run.error) throw run.error;
  return run;
}

function gitOk(args, options) {
  const run = git(args, options);
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${String(run.stderr).trim()}`);
  return run.stdout;
}

export async function connection({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.ROOM_ORIGIN && env.ROOM_ID && env.PROJECT_ROOM_SECRET) {
    return { origin: env.ROOM_ORIGIN.replace(/\/$/, ""), roomId: env.ROOM_ID, secret: env.PROJECT_ROOM_SECRET };
  }
  const loaded = loadConnection({ project: cwd, env });
  const secret = await loadSecret(loaded.name, loaded.config.token, env);
  return { origin: String(loaded.config.origin).replace(/\/$/, ""), roomId: loaded.config.roomId, secret };
}

function api(conn, path) {
  return conn.origin + edgeDoorApiPath(conn.origin, `/api/rooms/${encodeURIComponent(conn.roomId)}/code${path}`);
}

async function call(conn, path, { method = "GET", data, fetchImpl = globalThis.fetch, raw = false } = {}) {
  const response = await fetchImpl(api(conn, path), {
    method,
    redirect: "error",
    headers: { Authorization: bearerHeader(conn.secret), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(60000)
  });
  if (raw && response.ok) return response;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body?.error ?? {};
    throw new Error(`${response.status} ${error.code ?? "error"}: ${error.message ?? "request failed"}`);
  }
  return body;
}

function kindOfFile(path, bytes) {
  if (/\.bundle$/.test(path) || bytes.subarray(0, 16).toString("utf8").startsWith("# v")) return "bundle";
  if (bytes.subarray(0, 5).toString("utf8") === "From ") return "mbox";
  return "diff";
}

export function describeDrop(drop) {
  const s = drop.summary;
  const size = drop.kind === "bundle" ? `${s.refs.length} refs` : `${s.fileCount} files +${s.adds}/-${s.dels}`;
  const checks = (drop.checks ?? []).map(c => `${c.checkerId}:${c.verdict}${c.applies ? `/${c.applies}` : ""}${c.tests ? `/${c.tests}` : ""}`).join(" ");
  return [`${drop.id}  ${drop.title}`, `  ${drop.kind} · ${size} · by ${drop.authorId}${drop.base ? ` · base ${drop.base.slice(0, 8)}` : ""}${drop.claimId ? ` · claim ${drop.claimId}` : ""}${drop.supersededBy ? ` · replaced by ${drop.supersededBy}` : ""}`,
    ...(checks ? [`  checks: ${checks}`] : [])].join("\n");
}

async function share(conn, flags, io) {
  if (!flags.title) throw new Error("--title is required");
  const base = flags.base ?? "origin/main";
  let kind;
  let bytes;
  if (flags.file) {
    bytes = flags.file === "-" ? readFileSync(0) : readFileSync(flags.file);
    kind = kindOfFile(flags.file, bytes);
  } else if (flags.diff) {
    bytes = gitOk(["diff", "--binary", base], { binary: true });
    kind = "diff";
  } else if (flags.bundle) {
    const dir = mkdtempSync(join(tmpdir(), "room-code-"));
    try {
      const file = join(dir, "drop.bundle");
      const branch = flags.branch ?? String(gitOk(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      gitOk(["bundle", "create", file, `${base}..${branch}`]);
      bytes = readFileSync(file);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    kind = "bundle";
  } else {
    bytes = gitOk(["format-patch", "--stdout", `--base=${base}`, `${base}..HEAD`], { binary: true });
    kind = "mbox";
  }
  if (!bytes.length) throw new Error(`Nothing to share: no changes in ${base}..HEAD`);
  const branch = flags.branch ?? (flags.file ? undefined : String(git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout ?? "").trim() || undefined);
  const result = await call(conn, "", { method: "POST", fetchImpl: io.fetchImpl, data: {
    kind, title: flags.title, data: bytes.toString("base64"),
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(flags.claim ? { claimId: flags.claim } : {}),
    ...(flags.replaces ? { supersedes: flags.replaces } : {})
  } });
  io.out(`${result.duplicate ? "already shared" : "shared"} ${describeDrop(result.drop)}\n`);
  return 0;
}

async function fetchBytes(conn, id, io) {
  const response = await call(conn, `/${encodeURIComponent(id)}/raw`, { raw: true, fetchImpl: io.fetchImpl });
  const bytes = Buffer.from(await response.arrayBuffer());
  const expected = response.headers.get("x-content-sha256");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected) throw new Error(`No X-Content-SHA256 header for ${id}; refusing unverified bytes`);
  if (expected !== actual) throw new Error(`sha256 mismatch for ${id}: expected ${expected}, got ${actual}`);
  return { bytes, sha256: actual };
}

async function tryDrop(conn, id, flags, io) {
  const { drop } = await call(conn, `/${encodeURIComponent(id)}`, { fetchImpl: io.fetchImpl });
  const { bytes } = await fetchBytes(conn, id, io);
  const head = String(gitOk(["rev-parse", "HEAD"])).trim();
  const dir = mkdtempSync(join(tmpdir(), `room-${id}-`));
  const tempRef = `refs/room/${id}-${process.pid}`;
  const opts = { cwd: dir, binary: true, env: TRY_IDENTITY };
  let applies = "clean";
  let tests = null;
  let testsFailed = false;
  try {
    gitOk(["worktree", "add", "--detach", dir, head]);
    let run;
    if (drop.kind === "mbox") run = git(["am", "-3", "--keep-cr"], { ...opts, input: bytes });
    else if (drop.kind === "diff") run = git(["apply", "--3way", "--index"], { ...opts, input: bytes });
    else {
      // Land the bundle the way a merge would: its tip merged onto this
      // HEAD. Testing the sender's tip alone would report a base it never ran on.
      const file = join(dir, `.room-${id}.bundle`);
      writeFileSync(file, bytes);
      const tip = drop.summary.refs[0];
      run = git(["fetch", "--no-tags", file, `${tip.ref}:${tempRef}`], opts);
      rmSync(file, { force: true });
      if (run.status === 0) run = git(["merge", "--no-ff", "--no-edit", "-m", `room code try ${id}`, tempRef], opts);
    }
    if (run.status !== 0) {
      applies = "conflict";
      io.out(`${id}: does not apply on ${head.slice(0, 8)}\n${String(run.stderr).trim()}\n`);
    } else {
      io.out(`${id}: applies clean on ${head.slice(0, 8)} (worktree ${dir})\n`);
      if (flags.test) {
        const test = spawnSync(flags.test, { cwd: dir, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        const tail = `${test.stdout ?? ""}${test.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n");
        const pass = /# pass (\d+)/.exec(tail)?.[1];
        const fail = /# fail (\d+)/.exec(tail)?.[1];
        testsFailed = test.status !== 0;
        tests = !testsFailed ? (pass ? `${pass}/${Number(pass) + Number(fail ?? 0)} pass` : "pass") : (fail ? `${fail} failing` : `exit ${test.status ?? test.signal}`);
        io.out(`tests: ${tests}\n${tail}\n`);
      }
    }
  } finally {
    if (!flags.keep) git(["worktree", "remove", "--force", dir]);
    git(["update-ref", "-d", tempRef]);
  }
  const failed = applies !== "clean" || testsFailed;
  if (flags.report) {
    let verdict = flags.verdict ?? "comment";
    if (verdict === "approve" && failed) {
      verdict = "changes";
      io.out(`not approving: ${applies !== "clean" ? "the drop does not apply" : "tests failed"}; reporting changes instead\n`);
    }
    await call(conn, `/${encodeURIComponent(id)}/checks`, { method: "POST", fetchImpl: io.fetchImpl,
      data: { verdict, applies, onBase: head, ...(tests ? { tests } : {}), ...(flags.note ? { note: flags.note } : {}) } });
    io.out(`reported ${verdict} on ${id}\n`);
  }
  // 0 clean and passing, 2 does not apply, 3 applies but tests fail.
  return applies !== "clean" ? 2 : testsFailed ? 3 : 0;
}

export async function codeCommand(argv, io = {}) {
  const out = io.out ?? (message => process.stdout.write(message));
  const ctx = { out, fetchImpl: io.fetchImpl ?? globalThis.fetch };
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "help") { out(`${usage}\n`); return sub ? 0 : 1; }
  const { positional, flags } = parseArgs(rest);
  const conn = io.connection ?? await connection({ env: io.env ?? process.env, cwd: io.cwd ?? process.cwd() });
  const id = positional[0];
  const needId = () => { if (!id) throw new Error(`room code ${sub} <id>`); return id; };
  switch (sub) {
    case "share": return share(conn, flags, ctx);
    case "list": {
      const query = new URLSearchParams();
      if (flags.claim) query.set("claimId", flags.claim);
      if (flags.author) query.set("authorId", flags.author);
      const { drops } = await call(conn, query.size ? `?${query}` : "", { fetchImpl: ctx.fetchImpl });
      out(drops.length ? `${drops.map(describeDrop).join("\n")}\n` : "No code drops yet.\n");
      return 0;
    }
    case "show": {
      const { drop } = await call(conn, `/${encodeURIComponent(needId())}`, { fetchImpl: ctx.fetchImpl });
      out(flags.json ? `${JSON.stringify(drop, null, 2)}\n` : `${describeDrop(drop)}\n${(drop.summary.commits ?? []).map(c => `  - ${c.subject}`).join("\n")}\n${(drop.summary.files ?? []).map(f => `  ${f.path} +${f.adds}/-${f.dels}`).join("\n")}\n`);
      return 0;
    }
    case "fetch": {
      const { bytes } = await fetchBytes(conn, needId(), ctx);
      (io.write ?? (chunk => process.stdout.write(chunk)))(bytes);
      return 0;
    }
    case "try": return tryDrop(conn, needId(), flags, ctx);
    case "check": {
      if (!flags.verdict) throw new Error("--verdict approve|changes|comment is required");
      const { drop } = await call(conn, `/${encodeURIComponent(needId())}/checks`, { method: "POST", fetchImpl: ctx.fetchImpl, data: {
        verdict: flags.verdict,
        ...(flags.applies ? { applies: flags.applies } : {}),
        ...(flags.on ? { onBase: flags.on } : {}),
        ...(flags.tests ? { tests: flags.tests } : {}),
        ...(flags.note ? { note: flags.note } : {})
      } });
      out(`${describeDrop(drop)}\n`);
      return 0;
    }
    default: throw new Error(`Unknown room code command "${sub}".\n${usage}`);
  }
}
