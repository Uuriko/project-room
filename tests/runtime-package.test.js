import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, symlinkSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createRuntimePackage, verifyRuntimePackage, verifyRuntimeImports, verifyRuntimeSource, publicAssets, allowed, generatedAgentPages } from "../scripts/runtime-package.mjs";
import { importClosure } from "../scripts/runtime-import-closure.mjs";
import { assetPaths } from "../cloudflare/build-assets.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { frozenRecoveryFixture } from "../scripts/frozen-runtime-fixture.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("every currently served asset is registered in the exact-source runtime", () => {
  assert.deepEqual(publicAssets, assetPaths);
  for (const path of assetPaths) assert.ok(allowed.has(path), `Missing runtime asset: ${path}`);
  assert.ok(allowed.has("server/recovery-checkpoint-seed.mjs"), "Cold recovery includes retained and historical checkpoint seeding");
  assert.ok(allowed.has("server/recovery-replay-order.mjs"));
  assert.ok(publicAssets.includes("src/claim-overlap.js"), "Browser event replay can load its shared overlap predicate");
});

test("exact-commit runtime package verifies cold, excludes private state and preserves populated committed-schema data", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const destination = join(directory, "runtime");
  let receipt = createRuntimePackage({ repository, commit, destination });
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY.md"]) {
    assert.deepEqual(readFileSync(join(destination, name)),
      execFileSync("git", ["show", `${commit}:${name}`], { cwd: repository }),
      `runtime package retains the committed ${name}`);
  }
  const committedSchema = Number(/STORE_SCHEMA_VERSION = (\d+)/.exec(execFileSync("git", ["show", commit + ":server/writer-fence.mjs"], { cwd: repository, encoding: "utf8" }))[1]);
  assert.equal(receipt.schemaVersion, committedSchema); assert.deepEqual(publicAssets, assetPaths);
  // Decision #36 drift guard: the generated-pages exclusion in the package
  // contract names the generated HTML pages and hosted ACP archive —
  // a new agent page joins the exclusion (and the CF build) by being listed,
  // and a renamed one cannot silently fall out of it.
  assert.deepEqual([...generatedAgentPages].sort(),
    publicAssets.filter(path => /^docs\/agents\/[^/]+\.html$/.test(path) || path === "room-acp.tgz").sort());
  // The package must contain exactly the allowlisted files that exist at this commit.
  // The allowlist (scripts/runtime-package.mjs) is the single source of truth;
  // the import-closure test below guarantees it covers every imported module,
  // so no hand-maintained file list or count lives here.
  assert.equal(receipt.files, [...allowed].filter(path => existsSync(join(destination, path))).length);
  assert.equal(existsSync(join(destination, ".git")), false);
  assert.equal(existsSync(join(destination, "node_modules")), false);
  for (const path of ["server.mjs", "src/app.js", "cloudflare/room.mjs"]) {
    assert.deepEqual(readFileSync(join(destination, path)), execFileSync("git", ["show", `${commit}:${path}`], { cwd: repository }));
  }
  assert.throws(() => createRuntimePackage({ repository, commit, destination }));
  assert.throws(() => createRuntimePackage({ repository, commit: "HEAD", destination: join(directory, "alias-refused") }));
  const verifier = join(directory, "verify.mjs");
  cpSync(fileURLToPath(new URL("../scripts/runtime-package.mjs", import.meta.url)), verifier);
  const verified = spawnSync(process.execPath, [verifier, "verify", destination, commit], { cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr); assert.deepEqual(JSON.parse(verified.stdout), receipt);
  // Cold import from the exact package, with neither checkout dependencies nor a
  // working PATH. This module is absent from genuine historical packages.
  if (existsSync(join(destination, "client/work-actions.mjs"))) {
    const program = `import { roomTools } from ${JSON.stringify(pathToFileURL(join(destination, "client/mcp-stdio.mjs")).href)};
      import { buildWorkCommand } from ${JSON.stringify(pathToFileURL(join(destination, "client/work-actions.mjs")).href)};
      import { RoomAgentClient } from ${JSON.stringify(pathToFileURL(join(destination, "client/room-agent.mjs")).href)};
      console.log(JSON.stringify({ tools: roomTools.length, assistantTools: roomTools.filter(tool => tool.name.startsWith("room_assistant_")).map(tool => tool.name), helper: typeof RoomAgentClient.prototype.workAction,
        command: buildWorkCommand("room_accept_work", { requestId: "cold-package", workItemId: "work", expectedRevision: 0 }) }));`;
    const cold = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8" });
    assert.equal(cold.status, 0, cold.stderr);
    const packagedTools = readFileSync(join(destination, "client/mcp-stdio.mjs"), "utf8");
    const packagedWorkActions = existsSync(join(destination, "client/work-actions.mjs"))
      ? readFileSync(join(destination, "client/work-actions.mjs"), "utf8") : "";
    const toolCount = !existsSync(join(destination, "client/help-actions.mjs")) ? 27
      : packagedTools.includes('"room_map"') ? 47
      : packagedWorkActions.includes('"room_claim"') ? 46
      : packagedTools.includes("\"room_close_work_claim\"") ? 44
      : packagedTools.includes("...assistantTools") ? 43
      : packagedTools.includes('"room_link_work_claim_pr"') ? 41
      : packagedTools.includes('"room_set_member_claim_cap"') ? 40
      : packagedTools.includes('"room_list_outside_agents"') ? 39
      : packagedTools.includes('"room_begin_work"') ? 37
      : packagedWorkActions.includes('"renew_claim"') ? 36
      : packagedTools.includes('"get_room_context"') && packagedTools.includes('"room_read_inbox"') ? 35
      : packagedTools.includes('"room_read_inbox"') ? 34
      : packagedTools.includes('"get_room_context"') ? 33
      : 32;
    assert.deepEqual(JSON.parse(cold.stdout), { tools: toolCount, assistantTools: packagedTools.includes("...assistantTools") ? ["room_assistant_context", "room_assistant_action"] : [], helper: "function",
      command: { id: "cold-package", type: "work.accepted", data: { workItemId: "work", expectedRevision: 0 } } });
  }
  if (existsSync(join(destination, "scripts/run-codex-room.mjs"))) {
    const cold = spawnSync(process.execPath, [join(destination, "scripts/run-codex-room.mjs"), "--help"], {
      cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8"
    });
    assert.equal(cold.status, 0, cold.stderr);
    assert.match(cold.stdout, /RUN_ID/);
    assert.equal(existsSync(join(destination, "docs/CODEX-ROOM-HOST.md")), true);
    assert.equal(existsSync(join(destination, "scripts/room-assistant-scratch.mjs")), false);
    assert.equal(existsSync(join(destination, "scripts/acceptance-fixture.mjs")), false);
  }
  assert.throws(() => verifyRuntimePackage(destination, { expectedCommit: "0".repeat(40) }));
  const { buildAssets } = await import(pathToFileURL(join(destination, "cloudflare/build-assets.mjs")));
  const { templateAssetPaths: committedTemplates } = await import(pathToFileURL(join(destination, "server/public-assets.mjs")));
  // The package's own manifest is the asset contract (decision #36: the
  // generated agent pages are not in it — the packaged builder skips them);
  // templates such as join.html are copied for the worker loader and are
  // not raw URLs, so they ride along as before.
  const manifestAssets = JSON.parse(readFileSync(join(destination, "runtime-manifest.json"), "utf8")).publicAssets;
  const packagedAssets = [...manifestAssets, ...committedTemplates];
  const assets = join(directory, "assets");
  assert.equal(await buildAssets(pathToFileURL(assets + "/")), packagedAssets.length);
  for (const path of packagedAssets) assert.deepEqual(readFileSync(join(assets, path)), readFileSync(join(destination, path)));
  const committedFixture = await frozenRecoveryFixture(repository, destination, commit);
  // The fail-loud boot gate (server/boot-config.mjs) refuses a production boot
  // with an unsigned card. This synthetic package is built from an unsigned dev
  // tree, so fixture-sign the packaged card for the packaged revision (the
  // candidate's version.mjs is unstamped, so packaged deployedInfo().revision
  // is "dev") and update the manifest hash. A real production build goes
  // through scripts/sign-agent-card.mjs, which fails closed without the key.
  {
    const signedPath = "server/agent-card-signed.mjs";
    const module = `// Fixture-signed by tests/runtime-package.test.js for the packaged\n// production boot probe — not a real signature (see scripts/sign-agent-card.mjs).\nexport const AGENT_CARD_SIGNATURE = "fixture-signature";\nexport const AGENT_CARD_SIGNED_REVISION = "dev";\nexport const AGENT_CARD_UNSIGNED_REASON = null;\nexport const AGENT_CARD_JWS_SIGNATURES = null;\n`;
    writeFileSync(join(destination, signedPath), module);
    const manifestPath = join(destination, "runtime-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.files.find(file => file.path === signedPath);
    entry.bytes = Buffer.byteLength(module);
    entry.sha256 = createHash("sha256").update(module, "utf8").digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  // Re-baseline: the boot/data probes below must not mutate the package
  // relative to this fixture-signed state.
  receipt = verifyRuntimePackage(destination);
  const { auditRecovery } = await import(pathToFileURL(join(destination, "server/recovery.mjs")));
  const f = committedFixture(join(directory, "fixture.sqlite"));
  try {
    const helpRetries = [];
    for (const status of ["open", "withdrawn"]) {
      const workItemId = `packaged-help-${status}`;
      for (const command of [
        { id: `${workItemId}-propose`, type: "work.proposed", data: { workItemId, title: "Help with an agenda", definitionOfDone: "Two ideas", accountableMemberId: "owner" } },
        { id: `${workItemId}-accept`, type: "work.accepted", data: { workItemId, expectedRevision: 0 } },
        { id: `${workItemId}-open`, type: "work.help_updated", data: { workItemId, expectedRevision: 1, expectedHelpRevision: 0, status: "open",
          scope: "Suggest two agenda items 🪷", expiresAt: new Date(f.now() + 3600000).toISOString() } },
        ...(status === "withdrawn" ? [{ id: `${workItemId}-withdraw`, type: "work.help_updated", data: { workItemId, expectedRevision: 1, expectedHelpRevision: 1, status: "withdrawn" } }] : [])
      ]) helpRetries.push({ command, receipt: f.store.command(f.keys.owner, "commons", command) });
    }
    const before = auditRecovery(f.store);
    const { RoomStore } = await import(pathToFileURL(join(destination, "server/store.mjs")));
    const restored = new RoomStore(f.filename, { now: f.now });
    try {
      assert.deepEqual(auditRecovery(restored), before);
      for (const [index, request] of (f.inboxRequests ?? []).entries()) {
        const result = restored.inbox.apply(f.owner.token, request, f.owner.session.sessionBinding);
        assert.equal(result.duplicate, true);
        assert.deepEqual(result.receipt, f.inboxReceipts[index]);
      }
      if (f.inboxRequests) assert.equal(restored.inbox.read(f.owner.token, "recovery-source", f.owner.session.sessionBinding).draft.body, f.inboxDraftBody ?? "Private recovery reply");
      for (const [index, request] of (f.transportRequests ?? []).entries()) {
        assert.deepEqual(restored.inbox.transport(f.owner.token, request, f.owner.session.sessionBinding).receipt, f.transportReceipts[index]);
      }
      if (f.transportRequests) assert.equal(restored.inbox.sends(f.owner.token, "recovery-source", f.owner.session.sessionBinding).sends[0].status, "accepted");
      for (const { command, receipt } of helpRetries) assert.equal(restored.command(f.keys.owner, "commons", command).event.id, receipt.event.id);
      for (const status of ["open", "withdrawn"]) assert.equal(restored.room("commons").state.workItems[`packaged-help-${status}`].helpWanted.status, status);
      assert.deepEqual(auditRecovery(restored), before, "Cold exact-package help retries preserve every table");
      assert.equal(restored.command(f.keys.owner, "commons", f.command).duplicate, true);
      assert.equal(restored.command(f.keys.owner, "commons", f.nativeCommand).event.id, f.nativeCompletion.event.id);
      assert.equal(restored.workResult(f.keys.owner, "commons", "native-evidence").result.text.body, f.nativeBody);
      assert.equal(restored.command(f.keys.owner, "commons", f.charterCommand).event.id, f.charterSaved.event.id);
      assert.equal(restored.charter(f.keys.owner, "commons").charter.purpose, f.charterCommand.data.purpose);
      if (existsSync(join(destination, "server/work-discussion.mjs"))) {
        const discussion = restored.workDiscussion(f.keys.owner, "commons", "evidence");
        assert.equal(discussion.workItemId, "evidence");
        assert.equal(discussion.viewerId, "owner");
        assert.deepEqual(discussion.discussion.items, []);
        assert.equal(discussion.discussion.checkpoint, restored.room("commons").sequence);
        assert.deepEqual(auditRecovery(restored), before, "packaged discussion reader is read-only");
      }
    } finally { restored.close(); }
    const probe = createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const modes = existsSync(join(destination, "server/maintenance.mjs")) ? ["1", "0"] : ["0"];
    for (const pause of modes) {
      const child = spawn(process.execPath, [join(destination, "server.mjs")], { cwd: directory,
        env: { PATH: "/unavailable", NODE_ENV: "production", ROOM_DEPLOYMENT: "invite-only", ROOM_DB: f.filename,
          ROOM_ORIGIN: "https://room.example.test", ROOM_MAINTENANCE: pause, HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      const stopped = new Promise(resolve => child.once("exit", resolve));
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Packaged service did not start")), 10000);
          child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
          child.once("error", error => { clearTimeout(timer); reject(error); });
          child.once("exit", () => { clearTimeout(timer); reject(new Error("Packaged service exited before readiness")); });
        });
        const response = await new Promise((resolve, reject) => {
          const req = request({ hostname: "127.0.0.1", port, path: "/api/rooms/commons", headers: { host: "room.example.test",
            "x-real-ip": "192.0.2.1", authorization: `Bearer ${f.keys.owner}` } }, res => {
            let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
          }); req.on("error", reject); req.end();
        });
        assert.equal(response.status, pause === "1" ? 503 : 200);
        if (pause === "0") assert.equal(JSON.parse(response.body).viewerId, "owner");
        assert.deepEqual(auditRecovery(f.store), before);
      } finally { child.kill("SIGTERM"); await stopped; }
    }
  } finally { f.store.close(); }
  assert.deepEqual(verifyRuntimePackage(destination), receipt, "all generated state stays outside the immutable package");

  // A manifest whose hashes match an unsupported schema must still refuse.
  // Rehashing here is deliberate synthetic corruption, not a release stamp.
  {
    const damaged = join(directory, "unsupported-schema"); cpSync(destination, damaged, { recursive: true });
    const relative = "server/writer-fence.mjs", path = join(damaged, relative);
    const source = readFileSync(path, "utf8").replace(/STORE_SCHEMA_VERSION = \d+/, "STORE_SCHEMA_VERSION = 46");
    writeFileSync(path, source);
    const manifestPath = join(damaged, "runtime-manifest.json"), manifest = JSON.parse(readFileSync(manifestPath));
    const entry = manifest.files.find(file => file.path === relative);
    entry.bytes = Buffer.byteLength(source); entry.sha256 = createHash("sha256").update(source).digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verifyRuntimePackage(damaged), /unsupported store schema 46/);
  }

  for (const fault of ["missing", "changed", "extra", "symlink", "duplicate", "partial", "empty-directory"]) {
    const damaged = join(directory, fault); cpSync(destination, damaged, { recursive: true });
    const path = join(damaged, "server.mjs");
    if (fault === "missing") rmSync(path);
    else if (fault === "changed") writeFileSync(path, "// changed\n");
    else if (fault === "extra") writeFileSync(join(damaged, "room.sqlite"), "private fixture sentinel");
    else if (fault === "symlink") { rmSync(path); symlinkSync(join(destination, "server.mjs"), path); }
    else if (fault === "partial") rmSync(join(damaged, "runtime-manifest.json"));
    else if (fault === "empty-directory") mkdirSync(join(damaged, "unexpected"));
    else {
      const manifest = JSON.parse(readFileSync(join(damaged, "runtime-manifest.json"))); manifest.files.push(manifest.files[0]);
      writeFileSync(join(damaged, "runtime-manifest.json"), JSON.stringify(manifest));
    }
    assert.throws(() => verifyRuntimePackage(damaged), fault);
  }
});

test("every module in the server import closure is in the runtime-package allowlist", () => {
  // Regression guard for #590/#592/#606: a new server/*.mjs imported by
  // server/http.mjs (transitively from server.mjs) must be registered in
  // scripts/runtime-package.mjs, or the browser gate's createRuntimePackage
  // silently ships a runtime with a missing module. This computes the import
  // graph from source, so the allowlist can never drift from the code.
  const closure = importClosure("server.mjs", repository);
  const missing = [...closure].filter(path => !allowed.has(path)).sort();
  assert.deepEqual(missing, [],
    `Imported but not allowlisted for the runtime package. Add to scripts/runtime-package.mjs: ${missing.join(", ")}`);
});

test("uncommitted candidate packages cold in an isolated synthetic commit, including request observer dependencies", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-candidate-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = candidateRuntimeFixture(repository, directory), destination = join(directory, "runtime");
  const receipt = createRuntimePackage({ repository: candidate.repository, commit: candidate.commit, destination });
  // The allowlist (scripts/runtime-package.mjs) is the single source of truth.
  // The expected file count derives from the fixture's packaged paths
  // intersected with the allowlist, so registering a new module never requires
  // a hand-bumped count here (regression guard for #590/#592/#606, which broke
  // clean main on a stale number).
  const expectedFiles = [...candidate.packagedPaths].filter(path => allowed.has(path)).length;
  assert.equal(receipt.files, expectedFiles,
    `candidate package ships ${receipt.files} files but the allowlisted fixture set has ${expectedFiles}`);
  // Cold imports below exercise the host runner, process adapter and CLI.
  for (const file of ["client/request-runner.mjs", "client/host-process.mjs", "client/host-context-policy.mjs", "client/host-result.mjs", "client/host-subprocess.mjs", "client/host-verification.mjs", "client/agent-setup.mjs", "client/setup-journal.mjs", "scripts/connect-room.mjs", "scripts/run-room-request.mjs"]) assert.ok(existsSync(join(destination, file)), file);
  const program = `
    import { RoomStore } from ${JSON.stringify(pathToFileURL(join(destination, "server/store.mjs")).href)};
    import { configuredHost } from ${JSON.stringify(pathToFileURL(join(destination, "client/host-process.mjs")).href)};
    import { runRequestOnce } from ${JSON.stringify(pathToFileURL(join(destination, "client/request-runner.mjs")).href)};
    if (typeof configuredHost !== "function" || typeof runRequestOnce !== "function") throw new Error("Missing host bridge");
    import { SyntheticInboxTransport } from ${JSON.stringify(pathToFileURL(join(destination, "server/inbox-transport.mjs")).href)};
    import { initialRoom } from ${JSON.stringify(pathToFileURL(join(destination, "server/bootstrap.mjs")).href)};
    import { currentAttention } from ${JSON.stringify(pathToFileURL(join(destination, "client/attention-inbox.mjs")).href)};
    import { helpTools, buildHelpCommand } from ${JSON.stringify(pathToFileURL(join(destination, "client/help-actions.mjs")).href)};
    import { RoomAgentClient } from ${JSON.stringify(pathToFileURL(join(destination, "client/room-agent.mjs")).href)};
    if (helpTools.length !== 5 || typeof RoomAgentClient.prototype.helpAction !== "function") throw new Error("Missing help tools");
    const offer = buildHelpCommand("room_offer_help", { requestId: "cold-offer", workItemId: "work", offerId: "offer", expectedRevision: 1,
      expectedHelpRevision: 1, helpEventId: "invitation", plan: "Two agenda items" });
    if (offer.type !== "work.help_offer_opened") throw new Error("Incorrect offer command");
    const store = new RoomStore(":memory:"); store.initialize(initialRoom());
    if (typeof SyntheticInboxTransport !== "function" || typeof store.inbox.sendContext !== "function") throw new Error("Missing outbox runtime");
    if (typeof store.email.apply !== "function" || store.email.verify().sources !== 0) throw new Error("Missing email import runtime");
    const key = store.issueAccessKey("commons", "owner"), client = {
      snapshot: async () => store.snapshot(key, "commons"), changes: async (after, limit) => store.eventsAfter(key, "commons", after, limit)
    };
    const config = { client, origin: "http://127.0.0.1:12345", roomId: "commons", directory: ${JSON.stringify(join(directory, "observer"))}, version: 3 };
    const first = await currentAttention(config), second = await currentAttention(config);
    console.log(JSON.stringify({ version: second.schemaVersion, pending: second.pending, unchanged: JSON.stringify(first.items) === JSON.stringify(second.items) }));
    store.close();`;
  const cold = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8" });
  assert.equal(cold.status, 0, cold.stderr); assert.deepEqual(JSON.parse(cold.stdout), { version: 3, pending: 0, unchanged: true });
  assert.deepEqual(verifyRuntimePackage(destination), receipt);
});


test("Codex host entrypoint and every dependency ship without scratch demo fixtures", () => {
  const entry = "scripts/run-codex-room.mjs";
  const closure = new Set([entry, ...importClosure(entry, repository)]);
  assert.deepEqual([...closure].filter(path => !allowed.has(path)), []);
  assert.equal(closure.has("client/codex-runtime.mjs"), true);
  assert.equal(closure.has("client/codex-shared-assistant.mjs"), true);
  assert.equal(closure.has("client/codex-stdio.mjs"), true);
  assert.equal(closure.has("scripts/room-assistant-scratch.mjs"), false);
  assert.equal(closure.has("scripts/acceptance-fixture.mjs"), false);
});

test("runtime preflight catches unregistered client imports before cold packaging", () => {
  const files = new Map([
    ["client/runner.mjs", Buffer.from('import "./brief.mjs";')],
    ["client/brief.mjs", Buffer.from('export const version = 1;')]
  ]);
  assert.doesNotThrow(() => verifyRuntimeImports(files));
  files.delete("client/brief.mjs");
  assert.throws(() => verifyRuntimeImports(files), /client\/runner.mjs imports.*brief.mjs/);
  files.set("client/runner.mjs", Buffer.from('await import("./brief.mjs");'));
  assert.throws(() => verifyRuntimeImports(files), /not in the allowlisted runtime package/);
});

test("runtime preflight checks the working source without making a package", () => {
  assert.ok(verifyRuntimeSource(repository).files > 100);
  const directory = mkdtempSync(join(tmpdir(), "room-preflight-missing-"));
  try { assert.throws(() => verifyRuntimeSource(directory), /required runtime source is missing/); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("project preflight composes dependency, coverage and runtime checks", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-preflight.mjs"], { cwd: repository, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check-deps: ok/);
  assert.match(result.stdout, /no new untested modules/);
  assert.match(result.stdout, /runtime source files checked/);
});


test("offline schema45 archive cold-serves nonempty native work and refuses an omitted dependency", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-package-current-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const destination = join(directory, "runtime"), receipt = createRuntimePackage({repository,commit,destination});
  assert.equal(receipt.schemaVersion,45);
  const program = `
    import {RoomStore} from ${JSON.stringify(pathToFileURL(join(destination,"server/store.mjs")).href)};
    import {initialRoom} from ${JSON.stringify(pathToFileURL(join(destination,"server/bootstrap.mjs")).href)};
    import {event} from ${JSON.stringify(pathToFileURL(join(destination,"src/events.js")).href)};
    // Explicit cold public-export probes identify which packaged modules this
    // integration exercises; they do not replace their behavioral test suites.
    import {readCurrentEventWindow} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-room-events.mjs")).href)};
    import {readCurrentWorkListing} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-work-list.mjs")).href)};
    import {readCurrentReplies} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-reply-reader.mjs")).href)};
    import {readCurrentNativeInbox} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-native-inbox.mjs")).href)};
    import {readCurrentInboxDiscovery} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-inbox-discovery.mjs")).href)};
    import {INBOX_WORK_ROLES,CURRENT_INBOX_DISCOVERY_INDEXES} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-inbox-indexes.mjs")).href)};
    if(typeof readCurrentReplies!=='function'||typeof readCurrentInboxDiscovery!=='function'||INBOX_WORK_ROLES.length!==4||!CURRENT_INBOX_DISCOVERY_INDEXES.includes('current_inbox_open_requests'))throw Error('packaged inbox/reply dependency exports missing');
    import {validateCurrentArchive} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-room-archive.mjs")).href)};
    import {emptyWorkPrivacy,applyWorkPrivacyRequest} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-work-privacy.mjs")).href)};
    import {advanceCanonicalH} from ${JSON.stringify(pathToFileURL(join(destination,"server/replay-canonical-h.mjs")).href)};
    import {assertRestoreAdmitted} from ${JSON.stringify(pathToFileURL(join(destination,"server/restore-admission.mjs")).href)};
    if(validateCurrentArchive(null)!==null)throw Error('archive absence contract changed');
    if(applyWorkPrivacyRequest(emptyWorkPrivacy(),{requesterId:'owner',recipientId:'reader'},1).requests!==1)throw Error('privacy counter export failed');
    let rejected=false;try{advanceCanonicalH({state:{},header:{},readMetadata:()=>null});}catch(error){rejected=/Invalid protected canonical authority marker/.test(error.message);}
    if(!rejected)throw Error('canonical source admission export failed closed');
    import {CURRENT_WRITER_FORMAT} from ${JSON.stringify(pathToFileURL(join(destination,"server/current-room-format.mjs")).href)};
    import {readWorkItem} from ${JSON.stringify(pathToFileURL(join(destination,"server/work-repository.mjs")).href)};
    import {textVersion} from ${JSON.stringify(pathToFileURL(join(destination,"server/text-results.mjs")).href)};
    const path=${JSON.stringify(join(directory,"normalized.sqlite"))};
    let store=new RoomStore(path);
    store.initialize([...initialRoom(),event({id:'packaged-reader',roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]}}),event({id:'packaged-post',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'saved',body:'Packaged useful result'}}),event({id:'packaged-question-event',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'packaged-question',body:'Save a useful reply',toMemberId:'reader',requestKind:'reply',requestPolicyVersion:1}})],{representation:'normalized-current-v1'});
    const key=store.issueAccessKey('commons','owner'),readerKey=store.issueAccessKey('commons','reader');
    for(const workItemId of ['native-task','other-task'])store.command(key,'commons',{id:'propose-'+workItemId,type:'work.proposed',data:{workItemId,title:'Useful '+workItemId,definitionOfDone:'Saved exact result',accountableMemberId:'owner'}});
    store.workClaims.configure('commons',{maxOpenClaims:1});
    store.command(key,'commons',{id:'accept-native-task',type:'work.accepted',data:{workItemId:'native-task',expectedRevision:0}});
    let capDenied=false;try{store.command(key,'commons',{id:'accept-other-task',type:'work.accepted',data:{workItemId:'other-task',expectedRevision:0}});}catch(error){capDenied=error.code==='work_board_full';}
    if(!capDenied)throw Error('packaged native capacity admission missing');
    const formats=store.db.prepare("SELECT json_extract(counts_json,'$.format') AS format FROM operator_actions WHERE action='current_room_writer_admission'").all();
    if(!formats.length||formats.some(row=>row.format!==CURRENT_WRITER_FORMAT))throw Error('packaged format export differs from protected writer admissions');
    store.close();
    store=new RoomStore(path,{integrity:'deferred'});store.room=()=>{throw Error('whole room hydration');};
    const page=store.eventsAfter(key,'commons');
    if(page.events.find(row=>row.event.id==='packaged-post')?.event.data.body!=='Packaged useful result')throw Error('normalized archived import/read failed');
    assertRestoreAdmitted(store.db);
    const inbox=readCurrentNativeInbox(store,readerKey,'commons');
    if(!inbox.replyRequests.some(request=>request.id==='packaged-question'))throw Error('packaged native inbox lost a standing private obligation');
    const requestList=store.replyRequests.list(readerKey,'commons'),requestRead=store.replyRequests.selected(readerKey,'commons','packaged-question');
    if(requestList.contractVersion!==2||requestList.requests[0]?.id!=='packaged-question'||requestRead.contractVersion!==2||!requestRead.current.answerBasis||requestRead.page.items[0]?.message.body!=='Save a useful reply')throw Error('packaged v2 reply list/selected reader missing');
    const listed=readCurrentWorkListing(store,key,'commons');
    if(!listed.work.some(item=>item.id==='native-task'&&item.state==='accepted'))throw Error('nonempty native work did not survive cold package reopen');
    const revision=()=>readWorkItem(store.db,'commons','native-task').revision;
    store.command(key,'commons',{id:'start-native-task',type:'work.started',data:{workItemId:'native-task',expectedRevision:revision()}});
    const body='Packaged native saved result',post=store.command(key,'commons',{id:'native-result',type:'message.posted',data:{messageId:'native-result',workItemId:'native-task',body}});
    const complete={id:'complete-native-task',type:'work.completed',data:{workItemId:'native-task',expectedRevision:revision(),evidenceKind:'room_text',evidenceMessageId:'native-result',evidenceMessageEventId:post.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'Saved',nextAction:'Review'}};
    store.command(key,'commons',complete);
    if(!store.command(key,'commons',complete).duplicate)throw Error('native completion retry lost its receipt');
    if(store.db.prepare('SELECT count(*) AS n FROM work_claims').get().n!==0)throw Error('packaged native work recreated legacy mirrors');
    store.readTransaction(()=>{const direct=readCurrentEventWindow(store,'commons','owner');if(!direct.events.length)throw Error('event export failed');});
    store.close();store=new RoomStore(path,{integrity:'deferred'});
    const saved=readWorkItem(store.db,'commons','native-task');
    if(saved.state!=='completed'||!saved.receipt?.nativeText)throw Error('native saved result did not survive another cold reopen');
    store.close(); console.log(JSON.stringify({normalized:true,restarted:true,nativeAccepted:true,nativeCompleted:true,capacityDenied:true,nativeInbox:true,replyReader:true,legacyMirrors:0}));`;
  const cold=spawnSync(process.execPath,["--input-type=module","-e",program],{cwd:directory,env:{PATH:"/unavailable"},encoding:"utf8"});
  assert.equal(cold.status,0,cold.stderr);assert.deepEqual(JSON.parse(cold.stdout),{normalized:true,restarted:true,nativeAccepted:true,nativeCompleted:true,capacityDenied:true,nativeInbox:true,replyReader:true,legacyMirrors:0});
  assert.deepEqual(verifyRuntimePackage(destination,{expectedCommit:commit}),receipt);
  rmSync(join(destination,"server/current-room-repository.mjs"));
  assert.throws(()=>verifyRuntimePackage(destination),/missing|differ/);
});


test("verified offline archive runs the actual Native durable restore qualification", t => {
  const directory=mkdtempSync(join(tmpdir(),"room-package-native-restore-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const commit=execFileSync("git",["rev-parse","HEAD"],{cwd:repository,encoding:"utf8"}).trim();
  const destination=join(directory,"runtime"),receipt=createRuntimePackage({repository,commit,destination});
  // Keep test-only harness files outside the immutable archive. Every production
  // module resolves through the archive, whose complete import closure is verified.
  const harness=join(directory,"harness"),worker=join(harness,"cloudflare");mkdirSync(worker,{recursive:true});
  for(const entry of readdirSync(destination,{withFileTypes:true})){
    if(entry.name==="cloudflare")continue;
    symlinkSync(join(destination,entry.name),join(harness,entry.name),entry.isDirectory()?"dir":"file");
  }
  for(const entry of readdirSync(join(destination,"cloudflare"),{withFileTypes:true}))
    symlinkSync(join(destination,"cloudflare",entry.name),join(worker,entry.name),entry.isDirectory()?"dir":"file");
  const fixtureFiles=["durable-coverage.check.mjs","durable-coverage-seed.test-fixture.mjs","durable-coverage-native.test-fixture.mjs","current-room-serving.test-fixture.mjs"];
  for(const name of fixtureFiles)cpSync(join(repository,"cloudflare",name),join(worker,name));
  symlinkSync(realpathSync(join(repository,"cloudflare/node_modules")),join(harness,"node_modules"),"dir");
  assert.equal(realpathSync(join(harness,"server/store.mjs")),realpathSync(join(destination,"server/store.mjs")));
  assert.equal(realpathSync(join(worker,"room.mjs")),realpathSync(join(destination,"cloudflare/room.mjs")));
  const result=spawnSync(process.execPath,["--test",join(worker,"durable-coverage.check.mjs")],{
    // Leave time for the inner qualification and its cleanup after its 300s cap.
    cwd:harness,encoding:"utf8",timeout:330000,maxBuffer:16*1024*1024,
    env:{PATH:process.env.PATH,...(process.env.MINIFLARE_WORKERD_PATH?{MINIFLARE_WORKERD_PATH:process.env.MINIFLARE_WORKERD_PATH}:{})}
  });
  assert.equal(result.status,0,result.stdout+"\n"+result.stderr);
  assert.match(result.stdout,/DURABLE_COVERAGE_WORKER /);
  const line=result.stdout.split("\n").find(value=>value.includes("DURABLE_COVERAGE_WORKER "));
  const measured=JSON.parse(line.slice(line.indexOf("DURABLE_COVERAGE_WORKER ")+"DURABLE_COVERAGE_WORKER ".length));
  assert.equal(measured.actualNative,true);assert.equal(measured.coldReady,true);assert.equal(measured.exactRetry,true);
  assert.equal(measured.acceptedNativeWorkCapacity,true);assert.equal(measured.nativeWorkExactRetry,true);
  assert.deepEqual(verifyRuntimePackage(destination,{expectedCommit:commit}),receipt);
  t.diagnostic("PACKAGED_NATIVE_DURABLE_RESTORE "+JSON.stringify({sourceCommit:commit,package:receipt,qualification:measured,fixturesOutsideArchive:fixtureFiles,productionSource:"verified offline archive",archiveUnchanged:true}));
});
