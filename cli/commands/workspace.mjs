import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readProject, safeName } from "../paths.mjs";
import { bearerHeader } from "../auth.mjs";
import { connection, parseArgs } from "./code.mjs";
import { artifactDigest, workspaceArtifactLink, workspaceArtifactSelection } from "../../src/workspace-artifact-link.js";
import { runWorkspaceServer } from "../workspace-dev-server.mjs";
import { attachWorkspacePublisher, workspacePublisherEndpoint } from "../workspace-preview-publisher.mjs";
import { workspacePublisherAddress } from "../../server/workspace-publisher-address.mjs";
import { RoomAgentClient } from "../../client/room-agent.mjs";
import { agentSigninRecord } from "../../src/record-link.js";
import { edgeDoorApiPath } from "../../server/agent-discovery.mjs";

const usage = `room workspace start --path DIRECTORY [--base REF] [--from-work URL] [--connection NAME]
room workspace continue --link URL --path DIRECTORY [--repository-root DIRECTORY] [--fetch-from REMOTE] [--connection NAME]
room workspace run [--cwd DIRECTORY] [--port PORT] [--log FILE.log] -- COMMAND [ARGS...]
room workspace run --live ARTIFACT_URL [--publisher tls://HOST:PORT] [--publisher-ca FILE] -- COMMAND [ARGS...]
room workspace list
room workspace publish --id ID --title TITLE --base COMMIT --file PREVIEW.html [--include-changes yes] [--output RUN.log] [--share-with MEMBER_ID]
room workspace watch --id ID --title TITLE --base COMMIT --file PREVIEW.html [--include-changes yes] [--output RUN.log] [--share-with MEMBER_ID]
room workspace changes --id ID [--file PATH | --raw yes]
room workspace changes --link URL [--connection NAME] [--viewer MEMBER_ID]
room workspace inspect --link URL --viewer MEMBER_ID [--connection NAME]
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
function gitCommonDir(cwd) {
  return realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
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

function workspaceMarkerPath(cwd) {
  return resolve(git(cwd, "rev-parse", "--absolute-git-dir"), "project-room-workspace.json");
}

function workspaceMarker(cwd) {
  const marker = workspaceMarkerPath(cwd);
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

function recoverLaunch(cwd, path, base, scope) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return null;
  const gitRoot = gitCommonDir(cwd);
  try {
    if (entry.isDirectory() && realpathSync(git(path, "rev-parse", "--show-toplevel")) === realpathSync(path)
      && gitCommonDir(path) === gitRoot) {
      const launch = workspaceMarker(path)?.launch;
      const receipt = launch?.receipt;
      if (launch?.version === 1 && isDeepStrictEqual(launch.scope, scope) && receipt?.base === base
        && receipt.path === path && validId.test(receipt.id) && receipt.branch === `room/${receipt.id}`
        && git(path, "symbolic-ref", "--quiet", "HEAD") === `refs/heads/${receipt.branch}`
        && pinned(path, "HEAD") === base) return receipt;
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
  throw new Error("The worktree path is already in use and its original Workspace checkout could not be verified. Inspect it before choosing a different path.");
}

function launch(cwd, path, base, scope, details = {}) {
  // Reserve the directory before Git can create a branch. Concurrent launches
  // for the same path must never each reach `git worktree add`.
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(path);
  const id = randomBytes(16).toString("hex");
  const branch = "room/" + id;
  git(cwd, "worktree", "add", "-b", branch, "--", path, base);
  const { connection: name } = scope;
  const receipt = { id, branch, path, base, ...(name && { connection: name }), ...details };
  const marker = workspaceMarkerPath(path), pending = `${marker}.${id}.tmp`;
  writeFileSync(pending, JSON.stringify({ connection: name, launch: { version: 1, scope, receipt } }) + "\n",
    { mode: 0o600, flag: "wx", flush: true });
  renameSync(pending, marker);
  return receipt;
}

function roomCustody(packet, conn) {
  if (packet?.roomId !== conn.roomId || typeof packet.viewerId !== "string" || !packet.viewerId)
    throw new Error("Room did not confirm the identity for this Workspace checkout");
  return { origin: new URL(conn.origin).origin, roomId: packet.roomId, memberId: packet.viewerId,
    accountId: packet.viewerAccountId ?? null };
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
  const inherited = name ?? (fromEnvironment ? undefined : savedWorkspaceConnection(cwd));
  const conn = await connection({ env, cwd, name: inherited, useEnvironment: name === undefined });
  const path = edgeDoorApiPath(conn.origin, `/api/rooms/${encodeURIComponent(conn.roomId)}/workspace-previews`);
  const call = async (method = "GET", data, query = "", { suffix = "", signal } = {}) => {
    const timeout = AbortSignal.timeout(15000);
    const response = await (io.fetch ?? fetch)(conn.origin + path + suffix + query, {
      method, redirect: "error", signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { Authorization: bearerHeader(conn.secret), ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(value?.error?.message ?? `Room request failed (${response.status})`),
      { status: response.status, code: value?.error?.code });
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

async function livePublisher(io, cwd, root, flags) {
  if (!flags.live) throw new Error("Pass a directed preview link with --live");
  const suppliedAddress = flags.publisher === undefined ? undefined : workspacePublisherAddress(flags.publisher);
  const caFile = flags["publisher-ca"] && resolve(cwd, flags["publisher-ca"]);
  const { call, conn } = await connect(io, cwd, flags.connection);
  const room = new URL(conn.origin);
  if (room.protocol !== "https:" && !(room.protocol === "http:" && ["localhost", "127.0.0.1"].includes(room.hostname)))
    throw new Error("Live Workspace sharing requires a secure Room connection");
  const { target } = artifactFromConnection(flags.live, conn);
  const { id, revision, publisherId, head, panel, digest } = target;
  if (panel !== "preview" || pinned(root, "HEAD") !== head)
    throw new Error("Choose the published preview link for this worktree's current commit");
  const { item, viewerId } = await call("GET", undefined, "?id=" + id);
  if (item?.id !== id || item.revision !== revision || item.publisherId !== publisherId || publisherId !== viewerId
      || item.head !== head || item.digest !== digest || !item.recipientId)
    throw new Error("Choose your current directed preview in this Room");
  const link = workspaceArtifactLink(conn.origin, conn.roomId, item, "preview");
  return async ({ port, ownsPort, signal }) => {
    if (pinned(root, "HEAD") !== head) throw new Error("The worktree commit changed before publishing this preview");
    const selection = { roomId: conn.roomId, id, revision, publisherId };
    const grant = await call("POST", { id, revision }, "", { suffix: "/publisher-grant", signal });
    if (!grant || !/^[a-f0-9]{64}$/.test(grant.grant ?? "")
      || Object.entries(selection).some(([key, value]) => grant[key] !== value))
      throw new Error("Room returned a grant for a different publication");
    const roomAddress = grant.publisherAddress === undefined ? undefined : workspacePublisherAddress(grant.publisherAddress);
    if (roomAddress && suppliedAddress && roomAddress !== suppliedAddress)
      throw new Error("The publisher address differs from the one configured by this Room");
    if (!roomAddress && !suppliedAddress) throw new Error("This Room does not advertise a publisher address. Use --publisher with the operator's address.");
    const endpoint = workspacePublisherEndpoint(roomAddress ?? suppliedAddress, caFile);
    const publisher = await attachWorkspacePublisher({ endpoint, selection, grant: grant.grant, port, ownsPort, signal });
    return { ...publisher, live: { id, revision, link } };
  };
}

export async function workspaceCommand(argv, io = {}) {
  const separator = argv.indexOf("--");
  const { positional, flags } = parseArgs(separator === -1 ? argv : argv.slice(0, separator));
  const [action, ...extra] = positional;
  const out = data => (io.out ?? console.log)(JSON.stringify(data));
  const cwd = io.cwd ?? process.cwd();
  if (flags["repository-root"] !== undefined && action !== "continue") throw new Error("--repository-root is available with workspace continue");
  if (flags["from-work"] !== undefined && action !== "start") throw new Error("--from-work is available with workspace start");
  if (flags.cwd !== undefined && action !== "run") throw new Error("--cwd is available with workspace run");
  const shareLive = ["live", "publisher", "publisher-ca"].some(flag => flags[flag] !== undefined);
  if (shareLive && action !== "run") throw new Error("Live sharing is available with workspace run");
  if (action === "run" && !extra.length && separator !== -1 && argv[separator + 1]) {
    const gitDir = git(cwd, "rev-parse", "--absolute-git-dir");
    if (realpathSync(gitDir) === gitCommonDir(cwd)) throw new Error("Start a separate Git worktree before running a preview");
    const root = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
    let workingDirectory = root;
    if (flags.cwd !== undefined) {
      try { workingDirectory = realpathSync(resolve(root, flags.cwd)); }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
        throw new Error(`--cwd ${JSON.stringify(flags.cwd)} does not name an existing directory. Choose a path relative to the worktree root.`);
      }
    }
    const within = relative(root, workingDirectory);
    if (within === ".." || within.startsWith(".." + sep) || within.startsWith(sep) || !statSync(workingDirectory).isDirectory())
      throw new Error("Choose a working directory inside this worktree");
    const [command, ...args] = argv.slice(separator + 1);
    const attach = shareLive ? await livePublisher(io, cwd, root, flags) : undefined;
    return runWorkspaceServer({ cwd: root, workingDirectory, command, args, requestedPort: flags.port, logPath: flags.log, out, env: io.env, attach });
  }
  if (extra.length || separator !== -1 || !["start", "list", "publish", "watch", "remove", "changes", "output", "continue", "inspect"].includes(action)) throw new Error(usage);
  if (action === "start") {
    if (!flags.path) throw new Error("--path is required");
    const path = resolve(cwd, flags.path), base = pinned(cwd, flags.base ?? "HEAD");
    const name = flags.connection ? safeName(flags.connection) : savedWorkspaceConnection(cwd);
    const scope = { action, connection: name ?? null };
    if (flags["from-work"] === undefined) {
      out(recoverLaunch(cwd, path, base, scope) ?? launch(cwd, path, base, scope));
      return 0;
    }
    const conn = await connection({ cwd, name, env: io.env, useEnvironment: flags.connection === undefined });
    const source = selectedWorkThread(flags["from-work"], conn);
    const client = new RoomAgentClient({ ...conn, token: conn.secret, fetchImpl: io.fetch });
    const packet = await client.workContext(source.workItemId, { signal: AbortSignal.timeout(15000) });
    const { work, next } = packet;
    if (next.action === "superseded") throw new Error("This Work Thread was superseded. Open its replacement before starting.");
    source.revision = work.revision;
    Object.assign(scope, { room: roomCustody(packet, conn), source });
    const receipt = recoverLaunch(cwd, path, base, scope) ?? launch(cwd, path, base, scope, { workThread: source });
    out({ ...receipt, brief: { title: work.title, definitionOfDone: work.definitionOfDone, untrusted: true } });
    return 0;
  }
  const { call, conn, inherited } = await connect(io, cwd, flags.connection);
  const list = async () => (await call()).items;
  if (action === "list") { out(await list()); return 0; }
  if (action === "inspect") {
    if (!flags.viewer) throw new Error("Supply the expected Room member ID with --viewer");
    const { target } = artifactFromConnection(flags.link, conn);
    if (target.panel !== "preview") throw new Error("Choose a Preview artifact link");
    const { id, head, revision, publisherId, digest } = target;
    const verifyViewer = value => {
      if (value?.roomId !== conn.roomId || value.viewerId !== flags.viewer || value.viewerId === publisherId)
        throw new Error("Use the named viewer's independent saved Room connection.");
    };
    let read;
    try { read = await call("GET", undefined, "?" + new URLSearchParams({ id })); }
    catch (error) {
      if (error.status !== 404 || error.code !== "preview_not_found") throw error;
      // Verify the acting identity on an authorized Room response before
      // reporting that this selection was unavailable to it.
      verifyViewer(await call());
      out({ roomId: conn.roomId, viewerId: flags.viewer, id, head, revision, status: "unavailable" });
      return 0;
    }
    verifyViewer(read);
    const { item } = read;
    if (item?.id !== id || item.head !== head || item.revision !== revision || item.publisherId !== publisherId
        || item.digest !== digest || typeof item.html !== "string"
        || createHash("sha256").update(item.html).digest("hex") !== digest)
      throw new Error("This preview no longer matches the exact artifact link.");
    out({ roomId: conn.roomId, viewerId: flags.viewer, id, head, revision, publisherId, digest, status: "visible" });
    return 0;
  }
  if (action === "continue") {
    if (!flags.path) throw new Error("--path is required");
    const { target } = artifactFromConnection(flags.link, conn);
    const path = resolve(cwd, flags.path);
    const verify = async () => {
      const packet = await call();
      const room = roomCustody(packet, conn);
      const item = packet.items.find(row => row.id === target.id);
      if (!item || item.publisherId !== target.publisherId) throw new Error("This workspace artifact has changed or is unavailable");
      if (item.revision !== target.revision || item.head !== target.head || artifactDigest(item, target.panel) !== target.digest) {
        const current = workspaceArtifactLink(conn.origin, conn.roomId, item, target.panel)
          ?? workspaceArtifactLink(conn.origin, conn.roomId, item, "preview");
        if (current) throw new Error(`This workspace artifact has changed. Inspect commit ${item.head} or retry with current --link '${current}'`);
        throw new Error("This workspace artifact has changed or is unavailable");
      }
      return room;
    };
    const room = await verify();
    if (flags["repository-root"] !== undefined) {
      if (gitCommonDir(cwd) !== gitCommonDir(resolve(cwd, flags["repository-root"])))
        throw new Error("This checkout belongs to a different Git repository than --repository-root. Switch to the confirmed repository before continuing.");
    }
    const { anchor: _reviewPosition, ...source } = target;
    const scope = { action, connection: inherited ? safeName(inherited) : null, room, source };
    const recovered = recoverLaunch(cwd, path, target.head, scope);
    if (recovered) { out(recovered); return 0; }
    const fetched = !hasCommit(cwd, target.head);
    if (fetched) {
      const remote = flags["fetch-from"];
      if (!remote)
        throw new Error(`Commit ${target.head} is unavailable here. Run again with --fetch-from and a configured Git remote, or ask the publisher to push it.`);
      fetchWorkspaceCommit(cwd, remote, target.head);
      if (!isDeepStrictEqual(await verify(), room)) throw new Error("The Room identity changed while fetching this Workspace checkout");
    }
    out(launch(cwd, path, target.head, scope, { source, fetched }));
    return 0;
  }
  if (action === "changes" && flags.link) {
    if (flags.id || flags.file || flags.raw) throw new Error("Choose --link or the ID and file options");
    const { target, hash } = artifactFromConnection(flags.link, conn);
    if (target.panel !== "changes") throw new Error("Choose a Changes artifact link");
    const viewer = flags.viewer ?? conn.memberId;
    if (flags.viewer && conn.memberId && flags.viewer !== conn.memberId)
      throw new Error("Use the named viewer's saved Room connection.");
    const query = new URLSearchParams({ id: target.id, changes: "1", artifact: hash, view: target.file ? "file" : "summary" });
    if (target.file) query.set("path", target.file);
    const { changes, roomId, viewerId } = await call("GET", undefined, `?${query}`);
    if (viewer && (roomId !== conn.roomId || viewerId !== viewer))
      throw new Error("The Room returned Changes for a different viewer.");
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
  const starter = marker?.launch?.receipt;
  const source = starter?.workThread ?? marker?.source;
  const workThread = (starter?.id ?? marker?.attemptId) === flags.id && source?.roomId === conn.roomId
    && URL.parse(source.link)?.origin === new URL(conn.origin).origin ? source : null;
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
