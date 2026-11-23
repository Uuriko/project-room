import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { readProject, safeName } from "../paths.mjs";
import { bearerHeader } from "../auth.mjs";
import { connection, parseArgs } from "./code.mjs";
import { artifactDigest, workspaceArtifactLink, workspaceArtifactSelection } from "../../src/workspace-artifact-link.js";
import { runWorkspaceServer } from "../workspace-dev-server.mjs";
import { RoomAgentClient } from "../../client/room-agent.mjs";
import { agentSigninRecord } from "../../src/record-link.js";
import { edgeDoorApiPath } from "../../server/agent-discovery.mjs";

const usage = `room workspace start --path DIRECTORY [--base REF] [--from-work URL] [--connection NAME]
room workspace continue --link URL --path DIRECTORY [--fetch-from REMOTE] [--connection NAME]
room workspace run [--cwd DIRECTORY] [--port PORT] [--log FILE.log] -- COMMAND [ARGS...]
room workspace list
room workspace publish --id ID --title TITLE --base COMMIT --file PREVIEW.html [--include-changes yes] [--output RUN.log] [--share-with MEMBER_ID]
room workspace watch --id ID --title TITLE --base COMMIT --file PREVIEW.html [--include-changes yes] [--output RUN.log] [--share-with MEMBER_ID]
room workspace changes --id ID [--file PATH | --raw yes]
room workspace changes --link URL
room workspace output --id ID
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

function hasCommit(cwd, head) {
  try { return pinned(cwd, head) === head; }
  catch { return false; }
}

function fetchWorkspaceCommit(cwd, remote, head) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(remote) || !git(cwd, "remote").split("\n").includes(remote))
    throw new Error("Choose a configured Git remote with --fetch-from");
  const fetched = spawnSync("git", [
    "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--refmap=", "--", remote, head,
  ], { cwd, timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: "ignore" });
  if (fetched.status !== 0 || !hasCommit(cwd, head))
    throw new Error(`Could not fetch commit ${head} from ${remote}. Check repository access or ask the publisher to push it.`);
}

function savedWorkspaceConnection(cwd) {
  const configured = readProject(cwd)?.connection;
  if (configured) return configured;
  const tree = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (tree.status !== 0) return undefined;
  const atRoot = readProject(tree.stdout.trim())?.connection;
  if (atRoot) return atRoot;
  const name = workspaceMarker(cwd)?.connection;
  return name ? safeName(name) : undefined;
}

function workspaceMarker(cwd) {
  const marker = resolve(git(cwd, "rev-parse", "--absolute-git-dir"), "project-room-workspace.json");
  return existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
}

function selectedWorkThread(value, conn) {
  const link = URL.parse(value);
  const record = link && agentSigninRecord(link);
  if (!record?.hash.startsWith("#pr-record/work/") || link.username || link.password
      || link.origin !== new URL(conn.origin).origin || link.searchParams.size !== 1 || record.roomId !== conn.roomId)
    throw new Error("Choose a Work Thread link for the connected Room");
  const workItemId = decodeURIComponent(record.hash.slice("#pr-record/work/".length));
  return { workItemId, roomId: record.roomId, link: link.href };
}

function launch(cwd, flags, name, source) {
  if (!flags.path) throw new Error("--path is required");
  const path = resolve(cwd, flags.path);
  if (existsSync(path)) throw new Error("Choose a new worktree directory");
  const base = pinned(cwd, flags.base ?? "HEAD");
  const id = randomBytes(16).toString("hex");
  const branch = "room/" + id;
  git(cwd, "worktree", "add", "-b", branch, "--", path, base);
  if (name || source) {
    const marker = resolve(git(path, "rev-parse", "--absolute-git-dir"), "project-room-workspace.json");
    writeFileSync(marker, JSON.stringify({ connection: name, ...(source && { attemptId: id, source }) }) + "\n", { mode: 0o600, flag: "wx" });
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
  const base = pinned(cwd, flags.base), head = pinned(cwd, "HEAD");
  const input = { id: flags.id, title: flags.title, base, head, html: readFileSync(file, "utf8") };
  if (flags["share-with"] !== undefined) input.recipientId = flags["share-with"];
  if (flags["include-changes"] !== undefined) {
    if (flags["include-changes"] !== "yes") throw new Error("Use --include-changes yes to share the committed patch");
    const patch = spawnSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color", base, head, "--"], {
      cwd: root, encoding: "utf8", maxBuffer: 192 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    if (patch.status !== 0) throw new Error("Could not read the committed patch within the 192 KiB limit");
    input.patch = patch.stdout;
  }
  if (flags.output) {
    const output = realpathSync(resolve(cwd, flags.output));
    const within = relative(root, output);
    if (within === ".." || within.startsWith(".." + sep) || !/\.(?:txt|log)$/i.test(within))
      throw new Error("Choose a plain-text run log within this worktree");
    const info = statSync(output);
    if (!info.isFile() || info.size > 24 * 1024) throw new Error("Choose a plain-text run log up to 24 KiB");
    input.output = readFileSync(output, "utf8");
  }
  return input;
}

async function connect(io, cwd, name) {
  const env = io.env ?? process.env;
  const fromEnvironment = env.ROOM_ORIGIN && env.ROOM_ID && env.PROJECT_ROOM_SECRET;
  const inherited = fromEnvironment ? undefined : (name ?? savedWorkspaceConnection(cwd));
  const conn = await connection({ env, cwd, name: inherited });
  const path = edgeDoorApiPath(conn.origin, `/api/rooms/${encodeURIComponent(conn.roomId)}/workspace-previews`);
  const call = async (method = "GET", data, query = "") => {
    const response = await (io.fetch ?? fetch)(conn.origin + path + query, {
      method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: bearerHeader(conn.secret), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error?.message ?? `Room request failed (${response.status})`);
    return value;
  };
  return { call, conn, inherited };
}

function artifactFromConnection(value, conn) {
  const link = URL.parse(value ?? "");
  const target = link && workspaceArtifactSelection(link.hash);
  if (!target?.head) throw new Error("Copy a current artifact link from Workspace and pass it with --link");
  if (link.username || link.password || link.origin !== new URL(conn.origin).origin
    || link.searchParams.get("room") !== conn.roomId)
    throw new Error("Choose the saved connection for the artifact's Room");
  return { target, hash: link.hash };
}

export async function workspaceCommand(argv, io = {}) {
  const separator = argv.indexOf("--");
  const { positional, flags } = parseArgs(separator === -1 ? argv : argv.slice(0, separator));
  const [action, ...extra] = positional;
  const out = data => (io.out ?? console.log)(JSON.stringify(data));
  const cwd = io.cwd ?? process.cwd();
  if (flags["from-work"] !== undefined && action !== "start") throw new Error("--from-work is available with workspace start");
  if (flags.cwd !== undefined && action !== "run") throw new Error("--cwd is available with workspace run");
  if (action === "run" && !extra.length && separator !== -1 && argv[separator + 1]) {
    const gitDir = git(cwd, "rev-parse", "--absolute-git-dir");
    const commonDir = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (realpathSync(gitDir) === realpathSync(commonDir)) throw new Error("Start a separate Git worktree before running a preview");
    const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
    const workingDirectory = flags.cwd === undefined ? root : realpathSync(resolve(root, flags.cwd));
    const within = relative(root, workingDirectory);
    if (within === ".." || within.startsWith(".." + sep) || within.startsWith(sep) || !statSync(workingDirectory).isDirectory())
      throw new Error("Choose a working directory inside this worktree");
    const [command, ...args] = argv.slice(separator + 1);
    return runWorkspaceServer({ cwd: root, workingDirectory, command, args, requestedPort: flags.port, logPath: flags.log, out, env: io.env });
  }
  if (extra.length || separator !== -1 || !["start", "list", "publish", "watch", "remove", "changes", "output", "continue"].includes(action)) throw new Error(usage);
  if (action === "start") {
    const name = flags.connection ? safeName(flags.connection) : savedWorkspaceConnection(cwd);
    if (flags["from-work"] === undefined) {
      out(launch(cwd, flags, name));
      return 0;
    }
    const conn = await connection({ cwd, name, env: io.env });
    const source = selectedWorkThread(flags["from-work"], conn);
    const client = new RoomAgentClient({ ...conn, token: conn.secret, fetchImpl: io.fetch });
    const { work, next } = await client.workContext(source.workItemId, { signal: AbortSignal.timeout(15000) });
    if (next.action === "superseded") throw new Error("This Work Thread was superseded. Open its replacement before starting.");
    source.revision = work.revision;
    out({ ...launch(cwd, flags, name, source), workThread: source,
      brief: { title: work.title, definitionOfDone: work.definitionOfDone, untrusted: true } });
    return 0;
  }
  const { call, conn, inherited } = await connect(io, cwd, flags.connection);
  const list = async () => (await call()).items;
  if (action === "list") { out(await list()); return 0; }
  if (action === "continue") {
    if (!flags.path) throw new Error("--path is required");
    const { target } = artifactFromConnection(flags.link, conn);
    if (existsSync(resolve(cwd, flags.path))) throw new Error("Choose a new worktree directory");
    const verify = async () => {
      const item = (await list()).find(row => row.id === target.id);
      if (!item || item.revision !== target.revision || item.publisherId !== target.publisherId
        || item.head !== target.head || artifactDigest(item, target.panel) !== target.digest)
        throw new Error("This workspace artifact has changed or is unavailable");
    };
    await verify();
    const fetched = !hasCommit(cwd, target.head);
    if (fetched) {
      const remote = flags["fetch-from"];
      if (!remote)
        throw new Error(`Commit ${target.head} is unavailable here. Run again with --fetch-from and a configured Git remote, or ask the publisher to push it.`);
      fetchWorkspaceCommit(cwd, remote, target.head);
      await verify();
    }
    const worktree = launch(cwd, { path: flags.path, base: target.head }, inherited && safeName(inherited));
    out({ ...worktree, source: target, fetched });
    return 0;
  }
  if (action === "changes" && flags.link) {
    if (flags.id || flags.file || flags.raw) throw new Error("Choose --link or the ID and file options");
    const { target, hash } = artifactFromConnection(flags.link, conn);
    if (target.panel !== "changes") throw new Error("Choose a Changes artifact link");
    const query = new URLSearchParams({ id: target.id, changes: "1", artifact: hash, view: target.file ? "file" : "summary" });
    if (target.file) query.set("path", target.file);
    const { changes } = await call("GET", undefined, `?${query}`);
    out(changes);
    return 0;
  }
  if (!validId.test(flags.id ?? "")) throw new Error("--id must be the ID from room workspace start");
  if (action === "output") {
    const query = new URLSearchParams({ id: flags.id, output: "1" });
    const { run } = await call("GET", undefined, `?${query}`);
    out(run);
    return 0;
  }
  if (action === "changes") {
    const query = new URLSearchParams({ id: flags.id, changes: "1" });
    if (flags.raw !== undefined && (flags.raw !== "yes" || flags.file)) throw new Error("Choose --file PATH or --raw yes");
    if (!flags.raw) query.set("view", flags.file ? "file" : "summary");
    if (flags.file) query.set("path", flags.file);
    const { changes } = await call("GET", undefined, `?${query}`);
    out(changes);
    return 0;
  }
  let expectedRevision = (await list()).find(row => row.id === flags.id)?.revision ?? 0;
  if (action === "remove") { out(await call("DELETE", { id: flags.id, expectedRevision })); return 0; }
  if (!flags.file || !flags.title || !flags.base) throw new Error("--file, --title, and --base are required");
  const marker = workspaceMarker(cwd);
  const workThread = marker?.attemptId === flags.id && marker.source?.roomId === conn.roomId
    && URL.parse(marker.source.link)?.origin === new URL(conn.origin).origin ? marker.source : null;
  const publish = async () => {
    const value = await call("POST", { ...previewInput(cwd, flags), expectedRevision });
    expectedRevision = value.revision;
    const links = {};
    for (const panel of ["preview", "changes", "output"]) {
      const link = workspaceArtifactLink(conn.origin, conn.roomId, value, panel);
      if (link) links[panel] = link;
    }
    out({ ...value, links, ...(workThread && { workThread }) });
  };
  if (action === "publish") { await publish(); return 0; }
  // Watch the containing directory so build tools can atomically replace the file.
  const files = [flags.file, flags.output].filter(Boolean).map(name => resolve(cwd, name));
  const watchers = [];
  let timer, failure = null, running = Promise.resolve();
  const stop = error => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    failure ??= error ?? null;
  };
  const queue = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(() => { if (!failure && files.every(existsSync)) return publish(); }).catch(stop);
    }, 125);
  };
  try {
    for (const folder of new Set(files.map(dirname))) {
      const watcher = watch(folder, (_event, changed) => {
        if (changed === null || files.includes(resolve(folder, changed))) queue();
      });
      watcher.on("error", stop);
      watchers.push(watcher);
    }
  } catch (error) { stop(error); throw error; }
  const closed = Promise.all(watchers.map(watcher => new Promise(resolveClose => watcher.once("close", resolveClose))));
  running = publish().catch(stop);
  await closed;
  await running;
  if (failure) throw failure;
  return 0;
}
