#!/usr/bin/env node
// Self-host journey: boots the REAL `server.mjs` process on a fresh SQLite
// file (optionally behind real Caddy TLS) and runs one black-box journey with
// disposable synthetic fixtures. It reports each leg PASS / FAIL / NOT-RUN and
// never claims more than the mode it ran in.
//
//   node scripts/selfhost-journey.mjs [--mode local|production] [--proxy caddy|none]
//                                     [--caddy <binary>] [--json]
//
// Modes (always printed first, always labelled in the result):
//   local       server.mjs without NODE_ENV=production, ROOM_ORIGIN=https://localhost:<port>
//               behind Caddy's local CA. This is "local-mode over real Caddy TLS". It is NOT the
//               invite-only deployment: the server does not trust X-Real-IP in this mode.
//   production  NODE_ENV=production ROOM_DEPLOYMENT=invite-only, as docs/SELF-HOSTING.md requires.
//               If the build refuses to boot (for example the unsigned agent-card gate) every leg
//               is reported NOT-RUN with the refusal line; nothing is bypassed.
// Proxy:
//   caddy       real Caddy using deploy/Caddyfile.local (caddy on PATH, $CADDY, or --caddy).
//   none        plain loopback HTTP; the TLS leg is NOT-RUN.
//
// Exit: 0 every leg that ran passed and none were skipped by a prerequisite; 1 a leg failed;
//       3 blocked before the journey (boot refusal or missing prerequisite).
// Synthetic only: random display names, example.test text, no network beyond loopback, no secrets
// printed (keys stay in a private temp directory that is removed at exit).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { exportNdjsonText } from "../server/room-export.mjs";
import { reconcileRestoredAuthority } from "../server/backup.mjs";
import { textVersion } from "../server/text-results.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: opts } = parseArgs({ options: { mode: { type: "string", default: "local" }, proxy: { type: "string", default: "caddy" }, caddy: { type: "string" }, json: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
if (opts.help) { process.stdout.write("Usage: node scripts/selfhost-journey.mjs [--mode local|production] [--proxy caddy|none] [--caddy <binary>] [--json]\n"); process.exit(0); }
if (!["local", "production"].includes(opts.mode) || !["caddy", "none"].includes(opts.proxy)) { process.stderr.write("Unknown --mode or --proxy\n"); process.exit(2); }

const legs = [];
const say = text => { if (!opts.json) process.stdout.write(`${text}\n`); };
const dir = mkdtempSync(join(tmpdir(), "room-selfhost-journey-"));
// Output hygiene: never print this run's temporary directory or the checkout path.
const scrub = text => String(text).split(dir).join("<tmp>").split(root).join("<repo>");
const record = (status, name, detail = "") => { legs.push({ status, name, detail: scrub(detail) }); say(`${status.padEnd(7)} ${name}${detail ? ` - ${scrub(detail)}` : ""}`); return status === "PASS"; };
class Blocked extends Error {}
class LegFailure extends Error {}
const ensure = (condition, message) => { if (!condition) throw new LegFailure(message); };
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function freePort() {
  return await new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => done(port)); });
  });
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------
const children = new Set();
function launch(command, args, { env, cwd = root } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  const keep = chunk => { child.output = (child.output + chunk).slice(-20000); };
  child.stdout.on("data", keep); child.stderr.on("data", keep);
  child.exited = new Promise(done => child.once("exit", (code, signal) => { child.exitCode ??= code; child.exitSignal = signal; children.delete(child); done({ code, signal }); }));
  children.add(child);
  return child;
}
function cleanup() {
  for (const child of children) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cleanup(); process.exit(130); });

const baseEnv = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, NODE_OPTIONS: "" };
function serverEnv({ db, port, origin }) {
  const env = { ...baseEnv, ROOM_DB: db, HOST: "127.0.0.1", PORT: String(port), ROOM_ORIGIN: origin, ROOM_STREAM_INTERVAL_MS: "100" };
  if (opts.mode === "production") { env.NODE_ENV = "production"; env.ROOM_DEPLOYMENT = "invite-only"; }
  return env;
}

async function startServer({ db, port, origin }) {
  const child = launch(process.execPath, ["server.mjs"], { env: serverEnv({ db, port, origin }) });
  const outcome = await Promise.race([
    child.exited.then(() => "exited"),
    (async () => { for (let i = 0; i < 300; i++) { if (/Project Room (paused|invite-only pilot|local pilot):/.test(child.output)) return "ready"; await sleep(100); } return "timeout"; })()
  ]);
  if (outcome !== "ready") {
    const refusal = child.output.split("\n").find(line => /Refusing to boot|Error:/.test(line)) ?? child.output.trim().split("\n").at(-1) ?? "";
    child.kill("SIGKILL");
    throw new Blocked(`server.mjs did not start (${outcome}): ${scrub(refusal).slice(0, 400)}`);
  }
  return child;
}
async function stopServer(child) {
  child.kill("SIGTERM");
  const result = await Promise.race([child.exited, sleep(15000).then(() => null)]);
  if (result === null) { child.kill("SIGKILL"); throw new LegFailure("server did not exit within 15s of SIGTERM"); }
  return result;
}

// ---------------------------------------------------------------------------
// HTTP client (node:http / node:https so Caddy's local CA can be pinned per request)
// ---------------------------------------------------------------------------
let base, caPem = null;
function request(method, path, { token, body, ca = caPem, headers = {} } = {}) {
  const url = new URL(path, base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const client = url.protocol === "https:" ? https : http;
  const options = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, agent: false,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
    ...(url.protocol === "https:" ? { ca: ca ?? undefined, servername: url.hostname } : {}) };
  return new Promise((done, fail) => {
    const req = client.request(options, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json; try { json = JSON.parse(text); } catch { json = null; }
        done({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("request timeout")));
    req.once("error", fail);
    if (payload) req.write(payload);
    req.end();
  });
}
const sha = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

// ---------------------------------------------------------------------------
// Journey state
// ---------------------------------------------------------------------------
const roomId = "commons";
const suffix = randomUUID().slice(0, 6);
const who = { owner: { id: "owner", token: null }, agent: { name: `Journey Agent ${suffix}` }, reviewer: { name: `Journey Reviewer ${suffix}` } };
const command = (token, type, data, id = randomUUID()) => request("POST", `/api/rooms/${roomId}/commands`, { token, body: { id, type, data } }).then(res => ({ ...res, id }));
const roomRead = token => request("GET", `/api/rooms/${roomId}`, { token });
const digest = state => sha({ members: Object.fromEntries(Object.entries(state.members).map(([id, member]) => [id, { kind: member.kind, active: member.active, permissions: member.permissions }])),
  workItems: state.workItems, messages: state.messages.map(message => ({ id: message.id, authorId: message.authorId, body: message.body, workItemId: message.workItemId })) });

async function leg(name, body) {
  try { const detail = await body(); record("PASS", name, detail ?? ""); return true; }
  catch (error) {
    if (error instanceof Blocked) throw error;
    record("FAIL", name, error instanceof LegFailure ? error.message : `${error?.name ?? "Error"}: ${error?.message ?? error}`);
    return false;
  }
}
const skip = (name, why) => record("NOT-RUN", name, why);

const LEG_NAMES = [
  "TLS: HTTPS answers with a private-CA certificate; untrusted client is refused; HSTS set",
  "Human: provisioned owner credential reads the room; anonymous read is refused",
  "Invite: human mints invites; agent and reviewer redeem them",
  "Task: agent accepts, starts, posts a result and completes the work item",
  "Review: a separate reviewer records an exact-version PASS (independence confirmed)",
  "Changes: the human requests changes on the exact completion",
  "Revision: the agent restarts, delivers a new result version, the reviewer passes it",
  "Accept: the human approves the revised version",
  "Restart: graceful stop and boot on the same SQLite file preserves state and credentials",
  "Retry: redeem with the same requestId and a command with the same id are idempotent (across the restart)",
  "Backup: backupRoom snapshot of the live database verifies",
  "Revoke: after the backup the human removes the reviewer; the live server refuses its credential",
  "Restore: the stale backup brings the reviewer back; reconcile names it; it is re-applied before the server listens",
  "Reopen: the restored Room refuses the revoked reviewer, keeps the agent and the approved work, and lacks post-backup chat",
  "Import: export then replay into a fresh SQLite file verifies and boots with the same work state"
];

let appPort, db, origin, server, caddy;

async function main() {
  say(`self-host journey: mode=${opts.mode} proxy=${opts.proxy} node=${process.version}`);
  say(opts.mode === "local"
    ? "MODE LABEL: local-mode over " + (opts.proxy === "caddy" ? "real Caddy TLS" : "plain loopback HTTP") + " - NOT the invite-only deployment (no NODE_ENV=production; X-Real-IP not trusted)."
    : "MODE LABEL: production (NODE_ENV=production ROOM_DEPLOYMENT=invite-only).");

  // Prerequisite: Caddy.
  let caddyBin = null;
  if (opts.proxy === "caddy") {
    const candidate = opts.caddy ?? process.env.CADDY ?? "caddy";
    const probe = spawnSync(candidate, ["version"], { encoding: "utf8" });
    if (probe.status !== 0) throw new Blocked(`caddy binary not found or not runnable (${candidate}); install Caddy or pass --proxy none`);
    caddyBin = candidate;
    say(`caddy: ${probe.stdout.trim().split(" ")[0]}`);
  }

  appPort = await freePort();
  const edgePort = opts.proxy === "caddy" ? await freePort() : appPort;
  origin = opts.proxy === "caddy" ? `https://localhost:${edgePort}` : `http://127.0.0.1:${appPort}`;
  base = origin;
  mkdirSync(join(dir, "data"), { recursive: true, mode: 0o700 });
  db = join(dir, "data", "room.sqlite");

  // Provision a fresh room and an owner credential (private key file; never printed).
  const keyFile = join(dir, "owner.key");
  const provision = spawnSync(process.execPath, ["scripts/provision.mjs", "--init", "--room", roomId, "--member", "owner", "--account", "journey-owner", "--key-file", keyFile],
    { cwd: root, env: { ...baseEnv, ROOM_DB: db }, encoding: "utf8" });
  if (provision.status !== 0) throw new Blocked(`provision failed: ${scrub(provision.stderr).slice(0, 300)}`);
  who.owner.token = readFileSync(keyFile, "utf8").trim();
  rmSync(keyFile);

  // Boot the real server.
  server = await startServer({ db, port: appPort, origin });
  say(`server.mjs booted (${opts.mode} mode) on a fresh SQLite file, loopback only`);

  // Caddy in front.
  if (caddyBin) {
    const caddyfile = join(dir, "Caddyfile");
    writeFileSync(caddyfile, readFileSync(join(root, "deploy", "Caddyfile.local"), "utf8"));
    const dataHome = join(dir, "caddy-data");
    caddy = launch(caddyBin, ["run", "--config", caddyfile, "--adapter", "caddyfile"], { env: { ...baseEnv, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dir, "caddy-config"), ROOM_DOMAIN: `localhost:${edgePort}`, ROOM_UPSTREAM: `127.0.0.1:${appPort}` } });
    const rootCa = join(dataHome, "caddy", "pki", "authorities", "local", "root.crt");
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      if (caddy.exitCode != null) throw new Blocked(`caddy exited: ${scrub(caddy.output).trim().split("\n").at(-1)}`);
      if (existsSync(rootCa)) {
        caPem = readFileSync(rootCa);
        try { up = (await request("GET", "/api/health")).status > 0; } catch { /* TLS not ready yet */ }
      }
      if (!up) await sleep(150);
    }
    if (!up) throw new Blocked("caddy did not start serving HTTPS within 30s");
    say("caddy serving https://localhost:<port> with its local CA");
  }

  // ---- Legs --------------------------------------------------------------
  if (opts.proxy === "caddy") {
    await leg(LEG_NAMES[0], async () => {
      const ok = await request("GET", "/api/health");
      ensure(ok.status === 200, `health over TLS returned ${ok.status}`);
      ensure(/max-age=\d+/.test(ok.headers["strict-transport-security"] ?? ""), "no Strict-Transport-Security header");
      const refusal = await request("GET", "/api/health", { ca: null }).then(() => null, error => error.code ?? error.message);
      ensure(refusal && /CERT|SIGNED|VERIFY/i.test(refusal), `an untrusted client was not refused (${refusal})`);
      return `health 200 over TLS, HSTS present, no-CA client refused (${refusal})`;
    });
  } else skip(LEG_NAMES[0], "--proxy none: plain loopback HTTP, no TLS in front");

  await leg(LEG_NAMES[1], async () => {
    const read = await roomRead(who.owner.token);
    ensure(read.status === 200 && read.json?.state?.members?.owner?.kind === "human", `owner read returned ${read.status}`);
    const anonymous = await roomRead(null);
    ensure([401, 403].includes(anonymous.status), `anonymous read returned ${anonymous.status}`);
    return `owner (human) 200; anonymous ${anonymous.status}. The human is the operator-provisioned owner; browser signup is not exercised here`;
  });

  const redeemRequests = {};
  const mint = async (key, name, permissions) => {
    const invite = await request("POST", `/api/rooms/${roomId}/agent-invites`, { token: who.owner.token, body: { permissions, displayName: name } });
    ensure(invite.status === 201 && typeof invite.json?.code === "string", `invite mint returned ${invite.status}`);
    const requestId = randomUUID();
    redeemRequests[key] = { code: invite.json.code, requestId, name };
    const redeem = await request("POST", "/api/agent-invites/redeem", { body: { code: invite.json.code, displayName: name, requestId } });
    ensure(redeem.status === 201 && redeem.json?.memberId && redeem.json?.mcpToken?.credential, `redeem returned ${redeem.status}`);
    return { memberId: redeem.json.memberId, identityId: redeem.json.identityId, token: redeem.json.mcpToken.credential };
  };
  await leg(LEG_NAMES[2], async () => {
    Object.assign(who.agent, await mint("agent", who.agent.name, ["accept_work", "complete_work"]));
    Object.assign(who.reviewer, await mint("reviewer", who.reviewer.name, ["verify"]));
    ensure(who.agent.memberId !== who.reviewer.memberId, "agent and reviewer share a member id");
    const read = await roomRead(who.agent.token);
    ensure(read.status === 200, `agent room read returned ${read.status}`);
    return "two invite codes minted by the owner and redeemed; agent has accept_work+complete_work, reviewer has verify only";
  });

  const workItemId = `journey-${suffix}`;
  const completions = [];
  const deliver = async (body) => {
    const posted = await command(who.agent.token, "message.posted", { messageId: randomUUID(), body, workItemId });
    ensure(posted.status === 201, `result post returned ${posted.status}`);
    const state = (await roomRead(who.agent.token)).json.state;
    const previous = state.workItems[workItemId].receipt?.eventId ?? null;
    const done = await command(who.agent.token, "work.completed", { workItemId, expectedRevision: state.workItems[workItemId].revision, evidenceKind: "room_text", evidenceMessageId: posted.json.event.data.messageId,
      evidenceMessageEventId: posted.json.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: previous, producerId: who.agent.memberId, summary: "Synthetic result", nextAction: "Review the stored text" });
    ensure(done.status === 201, `completion returned ${done.status}: ${done.json?.error?.message ?? ""}`);
    const entry = { completionEventId: done.json.event.id, evidenceVersion: textVersion(body) };
    completions.push(entry);
    return entry;
  };
  const verify = async (entry, summary) => {
    const verdict = await command(who.reviewer.token, "verification.recorded", { workItemId, result: "pass", completionEventId: entry.completionEventId, evidenceVersion: entry.evidenceVersion, summary });
    ensure(verdict.status === 201, `verification returned ${verdict.status}: ${verdict.json?.error?.message ?? ""}`);
  };
  const item = async () => (await roomRead(who.owner.token)).json.state.workItems[workItemId];

  await leg(LEG_NAMES[3], async () => {
    const proposed = await command(who.owner.token, "work.proposed", { workItemId, title: "Synthetic journey task", definitionOfDone: "A short synthetic result the reviewer can check",
      accountableMemberId: who.agent.memberId, verifierMemberId: who.reviewer.memberId, independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
    ensure(proposed.status === 201, `proposal returned ${proposed.status}: ${proposed.json?.error?.message ?? ""}`);
    for (const type of ["work.accepted", "work.started"]) {
      const step = await command(who.agent.token, type, { workItemId });
      ensure(step.status === 201, `${type} returned ${step.status}`);
    }
    await deliver("Result v1 (synthetic): the example.test checklist has three items.");
    const now = await item();
    ensure(now.state === "completed" && now.receipt?.nativeText?.kind === "room_text", `work state ${now.state}`);
    return "state=completed with in-room text evidence from the agent";
  });

  await leg(LEG_NAMES[4], async () => {
    await verify(completions[0], "v1 matches the definition of done");
    const now = await item();
    ensure(now.verification?.result === "pass" && now.verification.independenceConfirmed === true, "no confirmed independent PASS");
    return `verifier ${now.verification.verifierId === who.reviewer.memberId ? "is the separate reviewer" : "MISMATCH"}; independenceConfirmed=true`;
  });

  const rationale = await command(who.owner.token, "message.posted", { messageId: randomUUID(), body: "Decision rationale (synthetic): tighten the wording." });
  await leg(LEG_NAMES[5], async () => {
    ensure(rationale.status === 201, "rationale post failed");
    const decision = await command(who.owner.token, "owner.decision_recorded", { workItemId, decision: "changes_requested", completionEventId: completions[0].completionEventId,
      evidenceVersion: completions[0].evidenceVersion, reason: "Tighten the wording", sourceMessageId: rationale.json.event.data.messageId });
    ensure(decision.status === 201, `decision returned ${decision.status}: ${decision.json?.error?.message ?? ""}`);
    const now = await item();
    ensure(now.state === "blocked" && now.decision?.decision === "changes_requested", `state ${now.state}`);
    return "state=blocked, decision=changes_requested on completion of v1";
  });

  await leg(LEG_NAMES[6], async () => {
    const restart = await command(who.agent.token, "work.started", { workItemId, resolvedBlocker: "Revising per the requested change" });
    ensure(restart.status === 201, `restart returned ${restart.status}`);
    await deliver("Result v2 (synthetic): the example.test checklist now has three tightened items.");
    ensure(completions[1].evidenceVersion !== completions[0].evidenceVersion, "revision has the same evidence version");
    await verify(completions[1], "v2 addresses the requested change");
    const now = await item();
    ensure(now.state === "completed" && now.verification?.evidenceVersion === completions[1].evidenceVersion && now.receiptHistory?.length === 1, `state ${now.state}`);
    return "new completion event and evidence version; prior receipt kept in history; v2 PASS recorded";
  });

  await leg(LEG_NAMES[7], async () => {
    const approve = await command(who.owner.token, "owner.decision_recorded", { workItemId, decision: "approved", completionEventId: completions[1].completionEventId,
      evidenceVersion: completions[1].evidenceVersion, reason: "Approved", sourceMessageId: rationale.json.event.data.messageId });
    ensure(approve.status === 201, `approval returned ${approve.status}: ${approve.json?.error?.message ?? ""}`);
    const now = await item();
    ensure(now.state === "completed" && now.decision?.decision === "approved" && now.decision.evidenceVersion === completions[1].evidenceVersion && now.decisionHistory?.length === 1, `decision ${now.decision?.decision}`);
    return "approved on the exact v2 completion; changes_requested kept in decision history";
  });

  // ---- Restart ----------------------------------------------------------
  const before = (await roomRead(who.owner.token)).json;
  const beforeDigest = digest(before.state), beforeSequence = before.sequence;
  await leg(LEG_NAMES[8], async () => {
    const exit = await stopServer(server);
    ensure(exit.code === 0, `server exit code ${exit.code} signal ${exit.signal}`);
    server = await startServer({ db, port: appPort, origin });
    const after = await roomRead(who.owner.token);
    ensure(after.status === 200 && after.json.sequence === beforeSequence && digest(after.json.state) === beforeDigest, `state changed across restart (sequence ${beforeSequence} -> ${after.json?.sequence})`);
    const agent = await roomRead(who.agent.token), reviewer = await roomRead(who.reviewer.token);
    ensure(agent.status === 200 && reviewer.status === 200, `agent/reviewer credentials after restart: ${agent.status}/${reviewer.status}`);
    return `exit 0 on SIGTERM; sequence ${beforeSequence} and state digest unchanged; owner, agent and reviewer credentials still valid`;
  });

  await leg(LEG_NAMES[9], async () => {
    const replay = await request("POST", "/api/agent-invites/redeem", { body: { code: redeemRequests.agent.code, displayName: redeemRequests.agent.name, requestId: redeemRequests.agent.requestId } });
    ensure([200, 201].includes(replay.status) && replay.json?.memberId === who.agent.memberId && replay.json?.identityId === who.agent.identityId, `same-requestId redeem returned ${replay.status} member ${replay.json?.memberId === who.agent.memberId ? "same" : "DIFFERENT"}`);
    // The replay rotates the identity secret (the original redeem response was "lost"); the secret itself
    // authenticates room routes. The earlier room token is not re-issued, so its status is reported.
    const oldToken = who.agent.token, newSecret = replay.json.identitySecret;
    ensure(replay.json.duplicate === true && typeof newSecret === "string" && newSecret.startsWith("pri_"), `replay did not return a rotated identity secret (keys: ${Object.keys(replay.json ?? {}).join(",")})`);
    const oldStatus = (await roomRead(oldToken)).status, secretStatus = (await roomRead(newSecret)).status;
    ensure(secretStatus === 200, `the rotated identity secret returned ${secretStatus} on a room read`);
    who.agent.token = newSecret;
    const burned = await request("POST", "/api/agent-invites/redeem", { body: { code: redeemRequests.agent.code, displayName: redeemRequests.agent.name, requestId: randomUUID() } });
    ensure(burned.status >= 400, `a new requestId redeemed a burned code (${burned.status})`);
    const sequenceBefore = (await roomRead(who.owner.token)).json.sequence;
    const first = await command(who.owner.token, "message.posted", { messageId: randomUUID(), body: "Idempotency probe (synthetic)." });
    ensure(first.status === 201 && first.json.duplicate === false, "probe write was not a fresh write");
    const again = await command(who.owner.token, "message.posted", first.json.event.data, first.id);
    ensure(again.status < 300 && again.json.duplicate === true && again.json.event.id === first.json.event.id, `same command id returned duplicate=${again.json?.duplicate} status ${again.status}`);
    const sequenceAfter = (await roomRead(who.owner.token)).json.sequence;
    ensure(sequenceAfter === sequenceBefore + 1, `sequence ${sequenceBefore} -> ${sequenceAfter}, expected exactly one new event`);
    return `redeem replay: same member and identity (${replay.status}), duplicate=true, identity secret rotated and accepted (${secretStatus}); earlier room token now ${oldStatus}; new requestId on the burned code: ${burned.status}; command retry: duplicate=true, same event id, one event added in total`;
  });

  // ---- Backup, revoke, restore ------------------------------------------
  let backup;
  await leg(LEG_NAMES[10], async () => {
    const backups = join(dir, "backups");
    mkdirSync(backups, { mode: 0o700 });
    const run = spawnSync(process.execPath, ["scripts/backup-room.mjs", "--db", db, "--to", backups], { cwd: root, env: { ...baseEnv }, encoding: "utf8" });
    ensure(run.status === 0, `backup-room exited ${run.status}: ${scrub(run.stderr).slice(0, 200)}`);
    const result = JSON.parse(run.stdout);
    ensure(result.verified === true, "backup did not verify");
    const watermark = JSON.parse(readFileSync(result.watermark, "utf8"));
    backup = { filename: result.filename, events: watermark.events };
    return `verified=true, watermark events=${watermark.events}`;
  });

  let liveSequence;
  const reviewerLiveRevision = () => roomRead(who.owner.token).then(res => res.json.state.members[who.reviewer.memberId].revision);
  await leg(LEG_NAMES[11], async () => {
    ensure(backup, "no backup to move past");
    const chat = await command(who.owner.token, "message.posted", { messageId: randomUUID(), body: "Posted after the backup (synthetic)." });
    ensure(chat.status === 201, "post-backup chat failed");
    const removed = await command(who.owner.token, "member.access_changed", { memberId: who.reviewer.memberId, expectedMemberRevision: await reviewerLiveRevision(), permissions: [], active: false });
    ensure(removed.status === 201, `revocation returned ${removed.status}: ${removed.json?.error?.message ?? ""}`);
    const refused = await roomRead(who.reviewer.token);
    ensure(refused.status === 403 && refused.json?.error?.code === "no_access", `live server did not refuse the removed reviewer with no_access (${refused.status})`);
    liveSequence = (await roomRead(who.owner.token)).json.sequence;
    return `reviewer now ${refused.status} on the live server; live sequence ${liveSequence} is past the backup`;
  });

  let restoredDb;
  await leg(LEG_NAMES[12], async () => {
    ensure(backup && liveSequence, "no backup/revocation to reconcile");
    const exit = await stopServer(server);
    ensure(exit.code === 0, `live server exit ${exit.code}`);
    server = null;
    mkdirSync(join(dir, "restored"), { recursive: true, mode: 0o700 });
    restoredDb = join(dir, "restored", "room.sqlite");
    cpSync(backup.filename, restoredDb);
    chmodSync(restoredDb, 0o600);
    // Negative control on a THROWAWAY copy: with no reconcile, the stale backup serves the removed reviewer again.
    const controlDb = join(dir, "control", "room.sqlite");
    mkdirSync(dirname(controlDb), { recursive: true, mode: 0o700 });
    cpSync(backup.filename, controlDb);
    const control = await startServer({ db: controlDb, port: appPort, origin });
    const resurrected = (await roomRead(who.reviewer.token)).status;
    await stopServer(control);
    ensure(resurrected === 200, `negative control: the unreconciled backup returned ${resurrected} for the removed reviewer, expected 200`);
    // The live database file stays on disk as the reference of record for what was revoked.
    const reference = new RoomStore(db, { readOnly: true });
    const restored = new RoomStore(restoredDb);
    try {
      ensure(restored.room(roomId).state.members[who.reviewer.memberId].active === true, "the stale backup did not resurrect the reviewer (expected hazard absent)");
      const report = reconcileRestoredAuthority(restored, reference);
      const members = report.stale.filter(row => row.kind === "member" && row.id.includes(who.reviewer.memberId));
      ensure(members.length === 1, `reconcile did not name the removed reviewer (${report.stale.map(row => row.kind).join(",") || "nothing"})`);
      const unhandled = report.stale.filter(row => !(row.kind === "member"));
      ensure(unhandled.length === 0, `stale authority this harness cannot re-apply: ${unhandled.map(row => row.kind).join(",")}`);
      // Re-apply the withdrawal on the restored file BEFORE any server listens on it.
      const ownerKey = who.owner.token;
      const current = restored.room(roomId).state.members[who.reviewer.memberId];
      restored.command(ownerKey, roomId, { id: randomUUID(), type: "member.access_changed", data: { memberId: who.reviewer.memberId, expectedMemberRevision: current.revision, permissions: [], active: false } });
      const second = reconcileRestoredAuthority(restored, reference);
      ensure(second.stale.length === 0, `stale authority remains after re-applying (${second.stale.map(row => row.kind).join(",")})`);
      return `negative control (unreconciled throwaway copy booted): removed reviewer served again, 200; stale backup resurrected the reviewer; reconcile named ${report.stale.length} stale row(s) [${report.stale.map(row => row.kind).join(",")}]; withdrawal re-applied offline; second reconcile clean; no server was listening on the restored file`;
    } finally { restored.close(); reference.close(); }
  });

  await leg(LEG_NAMES[13], async () => {
    ensure(restoredDb, "no reconciled restore to reopen");
    server = await startServer({ db: restoredDb, port: appPort, origin });
    const reviewer = await roomRead(who.reviewer.token);
    ensure(reviewer.status === 403 && reviewer.json?.error?.code === "no_access", `restored Room did not refuse the revoked reviewer with no_access (${reviewer.status})`);
    const reviewerWrite = await command(who.reviewer.token, "message.posted", { messageId: randomUUID(), body: "must be refused" });
    ensure(reviewerWrite.status === 403, `restored Room did not refuse a write from the revoked reviewer (${reviewerWrite.status})`);
    const agent = await roomRead(who.agent.token);
    ensure(agent.status === 200, `agent read after restore returned ${agent.status}`);
    const owner = (await roomRead(who.owner.token)).json;
    const work = owner.state.workItems[workItemId];
    ensure(work?.decision?.decision === "approved" && work.receipt?.evidenceVersion === completions[1].evidenceVersion, "approved v2 work did not survive the restore");
    const lost = owner.state.messages.some(message => /Posted after the backup/.test(message.body ?? ""));
    ensure(!lost, "post-backup chat is present; the restore did not come from the backup");
    return `reviewer ${reviewer.status}/${reviewerWrite.status} (read/write); agent 200; approved v2 work present; post-backup chat absent (expected data loss: ${liveSequence - backup.events} event(s))`;
  });

  await leg(LEG_NAMES[14], async () => {
    ensure(restoredDb, "no store to export");
    await stopServer(server); server = null;
    const exporter = new RoomStore(restoredDb, { readOnly: true });
    let ndjson;
    try { ndjson = exportNdjsonText(exporter.db); } finally { exporter.close(); }
    const exportFile = join(dir, "export.ndjson");
    writeFileSync(exportFile, ndjson, { mode: 0o600 });
    const importedDb = join(dir, "imported", "room.sqlite");
    mkdirSync(dirname(importedDb), { recursive: true, mode: 0o700 });
    const run = spawnSync(process.execPath, ["scripts/replay-room-export.mjs", "--from", exportFile, "--to", importedDb], { cwd: root, env: { ...baseEnv }, encoding: "utf8" });
    ensure(run.status === 0, `replay-room-export exited ${run.status}: ${scrub(run.stderr).slice(0, 200)}`);
    const summary = JSON.parse(run.stdout);
    ensure(summary.verified === true, "replay did not verify");
    server = await startServer({ db: importedDb, port: appPort, origin });
    const probe = async token => (await roomRead(token)).status;
    // Exported secrets are sanitised on purpose; which old credentials survive is reported, not asserted.
    const observed = { owner: await probe(who.owner.token), agent: await probe(who.agent.token), reviewer: await probe(who.reviewer.token) };
    ensure(Object.values(observed).every(status => status > 0), "imported server did not answer");
    // State is proven with the hash of the restored file, not through a credential.
    const imported = new RoomStore(importedDb, { readOnly: true });
    try {
      const source = new RoomStore(restoredDb, { readOnly: true });
      try {
        ensure(digest(imported.room(roomId).state) === digest(source.room(roomId).state), "imported room state differs from the exported store");
      } finally { source.close(); }
    } finally { imported.close(); }
    return `replay verified=true events=${summary.events} sanitizedCells=${JSON.stringify(summary.sanitizedCells)}; imported state digest equals the source; imported Room booted. OBSERVED (not asserted) old credentials on the import: owner ${observed.owner}, agent ${observed.agent}, revoked reviewer ${observed.reviewer}`;
  });
}

let blocked = null;
try { await main(); }
catch (error) {
  if (error instanceof Blocked) blocked = error.message;
  else { record("FAIL", "harness", `${error?.name ?? "Error"}: ${error?.message ?? error}`); }
}
finally {
  if (server) { try { server.kill("SIGTERM"); } catch { /* gone */ } }
}

if (blocked) {
  say(`BLOCKED: ${scrub(blocked)}`);
  for (const name of LEG_NAMES) if (!legs.some(entry => entry.name === name)) record("NOT-RUN", name, `blocked before the journey: ${scrub(blocked).slice(0, 200)}`);
}
for (const name of LEG_NAMES) if (!legs.some(entry => entry.name === name)) record("NOT-RUN", name, "an earlier leg failed");
const count = status => legs.filter(entry => entry.status === status).length;
const summary = { mode: opts.mode, proxy: opts.proxy, label: opts.mode === "local" ? `local-mode over ${opts.proxy === "caddy" ? "real Caddy TLS" : "plain loopback HTTP"} (not the invite-only deployment)` : "production mode",
  node: process.version, pass: count("PASS"), fail: count("FAIL"), notRun: count("NOT-RUN"), blocked, legs };
if (opts.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
else say(`\nRESULT ${summary.label}: PASS ${summary.pass} / FAIL ${summary.fail} / NOT-RUN ${summary.notRun}${blocked ? " (BLOCKED before the journey)" : ""}`);
const exitCode = blocked ? 3 : summary.fail ? 1 : (summary.notRun && opts.proxy === "caddy") ? 1 : 0;
// Explicit exit: Caddy's open pipes would otherwise keep the event loop alive.
cleanup();
process.exit(exitCode);
