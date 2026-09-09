import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRuntimePackage, verifyRuntimePackage, publicAssets } from "../scripts/runtime-package.mjs";
import { assetPaths } from "../cloudflare/build-assets.mjs";
import { candidateRuntimeFixture } from "../scripts/candidate-runtime-fixture.mjs";
import { frozenRecoveryFixture } from "../scripts/frozen-runtime-fixture.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("exact-commit runtime package verifies cold, excludes private state and preserves populated committed-schema data", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const destination = join(directory, "runtime");
  const receipt = createRuntimePackage({ repository, commit, destination });
  const committedSchema = Number(/STORE_SCHEMA_VERSION = (\d+)/.exec(execFileSync("git", ["show", commit + ":server/writer-fence.mjs"], { cwd: repository, encoding: "utf8" }))[1]);
  assert.equal(receipt.schemaVersion, committedSchema); assert.deepEqual(publicAssets, assetPaths);
  assert.equal(receipt.files, 47 + ["src/inbox-client.js", "src/inbox-ui.js", "src/inbox-send-ui.js", "server/maintenance.mjs", "server/recovery.mjs", "client/agent-connection.mjs", "server/agent-connections.mjs", "src/agent-connections.js", "client/mcp-stdio.mjs", "scripts/agent-mcp.mjs", "client/work-actions.mjs", "server/work-discussion.mjs", "server/text-results.mjs", "client/attention-inbox.mjs", "src/room-charter.js", "src/room-instructions.js", "src/reply-requests.js", "server/reply-requests.mjs", "client/reply-actions.mjs", "scripts/agent-replies.mjs", "client/request-notices.mjs", "src/work-help.js", "server/work-help.mjs", "src/help-offers.js", "client/help-actions.mjs", "server/inbox.mjs", "server/inbox-outbox.mjs", "server/inbox-transport.mjs", "server/email-envelope.mjs", "server/graph-email.mjs", "server/email-import.mjs", "server/graph-fixture-sync.mjs", "server/graph-reply-draft.mjs", "server/graph-reply-journal.mjs", "server/graph-reply-update-review.mjs"].filter(path => existsSync(join(destination, path))).length);
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
      console.log(JSON.stringify({ tools: roomTools.length, helper: typeof RoomAgentClient.prototype.workAction,
        command: buildWorkCommand("room_accept_work", { requestId: "cold-package", workItemId: "work", expectedRevision: 0 }) }));`;
    const cold = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: directory, env: { PATH: "/unavailable" }, encoding: "utf8" });
    assert.equal(cold.status, 0, cold.stderr);
    assert.deepEqual(JSON.parse(cold.stdout), { tools: existsSync(join(destination, "client/help-actions.mjs")) ? 29 : 24, helper: "function",
      command: { id: "cold-package", type: "work.accepted", data: { workItemId: "work", expectedRevision: 0 } } });
  }
  assert.throws(() => verifyRuntimePackage(destination, { expectedCommit: "0".repeat(40) }));
  const { buildAssets, assetPaths: committedAssets } = await import(pathToFileURL(join(destination, "cloudflare/build-assets.mjs")));
  const assets = join(directory, "assets");
  assert.equal(await buildAssets(pathToFileURL(assets + "/")), committedAssets.length);
  for (const path of committedAssets) assert.deepEqual(readFileSync(join(assets, path)), readFileSync(join(destination, path)));
  const committedFixture = await frozenRecoveryFixture(repository, destination, commit);
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

test("uncommitted candidate packages cold in an isolated synthetic commit, including request observer dependencies", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-candidate-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = candidateRuntimeFixture(repository, directory), destination = join(directory, "runtime");
  const receipt = createRuntimePackage({ ...candidate, destination }); assert.equal(receipt.files, 82);
  const program = `
    import { RoomStore } from ${JSON.stringify(pathToFileURL(join(destination, "server/store.mjs")).href)};
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
