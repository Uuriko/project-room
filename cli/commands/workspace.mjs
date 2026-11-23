import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { readProject, safeName } from "../paths.mjs";
import { bearerHeader } from "../auth.mjs";
import { connection, parseArgs } from "./code.mjs";
import { runWorkspaceServer } from "../workspace-dev-server.mjs";
import { edgeDoorApiPath } from "../../server/agent-discovery.mjs";

const usage = `room workspace start --path DIRECTORY [--base REF] [--connection NAME]
room workspace run [--port PORT] -- COMMAND [ARGS...]
room workspace list
room workspace publish --id ID --title TITLE --base COMMIT --file PREVIEW.html
room workspace watch --id ID --title TITLE --base COMMIT --file PREVIEW.html
room workspace remove --id ID
Pass --connection NAME to choose a saved connection explicitly.`;
const validId = /^[a-f0-9]{32}$/;

function git(cwd, ...args) {
  const output = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (output.error) throw output.error;
  if (output.status !== 0) throw new Error(output.stderr.trim() || "Git command failed");
  return output.stdout.trim();
}
function pinned(cwd, ref) {
  return git(cwd, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}");
}

function savedWorkspaceConnection(cwd) {
  const configured = readProject(cwd)?.connection;
  if (configured) return configured;
  const tree = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (tree.status !== 0) return undefined;
  const atRoot = readProject(tree.stdout.trim())?.connection;
  if (atRoot) return atRoot;
  const marker = resolve(git(cwd, "rev-parse", "--absolute-git-dir"), "project-room-workspace.json");
  if (existsSync(marker)) return safeName(JSON.parse(readFileSync(marker, "utf8")).connection);
  return undefined;
}

function launch(cwd, flags) {
  if (!flags.path) throw new Error("--path is required");
  const path = resolve(cwd, flags.path);
  if (existsSync(path)) throw new Error("Choose a new worktree directory");
  const base = pinned(cwd, flags.base ?? "HEAD");
  const name = flags.connection ? safeName(flags.connection) : savedWorkspaceConnection(cwd);
  const id = randomBytes(16).toString("hex");
  const branch = "room/" + id;
  git(cwd, "worktree", "add", "-b", branch, "--", path, base);
  if (name) {
    const marker = resolve(git(path, "rev-parse", "--absolute-git-dir"), "project-room-workspace.json");
    writeFileSync(marker, JSON.stringify({ connection: name }) + "\n", { mode: 0o600, flag: "wx" });
  }
  return { id, branch, path, base, ...(name && { connection: name }) };
}

function previewInput(cwd, flags) {
  const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
  const file = realpathSync(resolve(cwd, flags.file));
  const location = relative(root, file);
  if (location.startsWith(".." + sep) || location === ".." || location.startsWith(sep) || !/\.html?$/i.test(location))
    throw new Error("Choose an HTML build artifact inside this worktree");
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 384 * 1024) throw new Error("Choose a standalone HTML file up to 384 KiB");
  return { id: flags.id, title: flags.title, base: pinned(cwd, flags.base), head: pinned(cwd, "HEAD"), html: readFileSync(file, "utf8") };
}

async function connect(io, cwd, name) {
  const env = io.env ?? process.env;
  const inherited = name ?? ((env.ROOM_ORIGIN && env.ROOM_ID && env.PROJECT_ROOM_SECRET) ? undefined : savedWorkspaceConnection(cwd));
  const conn = await connection({ env, cwd, name: inherited });
  const path = edgeDoorApiPath(conn.origin, `/api/rooms/${encodeURIComponent(conn.roomId)}/workspace-previews`);
  return async (method = "GET", data) => {
    const response = await (io.fetch ?? fetch)(conn.origin + path, {
      method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: bearerHeader(conn.secret), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error?.message ?? `Room request failed (${response.status})`);
    return value;
  };
}

export async function workspaceCommand(argv, io = {}) {
  const separator = argv.indexOf("--");
  const { positional, flags } = parseArgs(separator === -1 ? argv : argv.slice(0, separator));
  const [action, ...extra] = positional;
  const out = data => (io.out ?? console.log)(JSON.stringify(data));
  const cwd = io.cwd ?? process.cwd();
  if (action === "run" && !extra.length && separator !== -1 && argv[separator + 1]) {
    const gitDir = git(cwd, "rev-parse", "--absolute-git-dir");
    const commonDir = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (realpathSync(gitDir) === realpathSync(commonDir)) throw new Error("Start a separate Git worktree before running a preview");
    const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
    const [command, ...args] = argv.slice(separator + 1);
    return runWorkspaceServer({ cwd: root, command, args, requestedPort: flags.port, out, env: io.env });
  }
  if (extra.length || separator !== -1 || !["start", "list", "publish", "watch", "remove"].includes(action)) throw new Error(usage);
  if (action === "start") { out(launch(cwd, flags)); return 0; }
  const call = await connect(io, cwd, flags.connection);
  const list = async () => (await call()).items;
  if (action === "list") { out(await list()); return 0; }
  if (!validId.test(flags.id ?? "")) throw new Error("--id must be the ID from room workspace start");
  let expectedRevision = (await list()).find(row => row.id === flags.id)?.revision ?? 0;
  if (action === "remove") { out(await call("DELETE", { id: flags.id, expectedRevision })); return 0; }
  if (!flags.file || !flags.title || !flags.base) throw new Error("--file, --title, and --base are required");
  const publish = async () => {
    const value = await call("POST", { ...previewInput(cwd, flags), expectedRevision });
    expectedRevision = value.revision;
    out(value);
  };
  if (action === "publish") { await publish(); return 0; }
  // Watch the containing directory so build tools can atomically replace the file.
  const file = resolve(cwd, flags.file);
  let timer, failure = null, running = Promise.resolve();
  const stop = error => {
    clearTimeout(timer);
    watcher.close();
    failure ??= error ?? null;
  };
  const queue = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(() => { if (!failure && existsSync(file)) return publish(); }).catch(stop);
    }, 125);
  };
  const watcher = watch(dirname(file), (_event, changed) => {
    if (changed === null || resolve(dirname(file), changed) === file) queue();
  });
  watcher.on("error", stop);
  const closed = new Promise(resolveClose => watcher.once("close", resolveClose));
  running = publish().catch(stop);
  await closed;
  await running;
  if (failure) throw failure;
  return 0;
}
