// The docs path follows the live llms packet against a local room server.
// It reaches the documented post. It closes work only when that packet
// prints a work-claim done call. Written files do not contain a secret.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { solveIdentityMintProof } from "../server/agent-identities.mjs";
import { solveIdentityMintProofRemote } from "../scripts/onboarding-probe/pow.mjs";
import { rewriteHosts, writeJson } from "../scripts/onboarding-probe/lib.mjs";
import { runAgentDocs } from "../scripts/onboarding-probe/agent-docs.mjs";
import { cleanupAll, createdIds } from "../scripts/onboarding-probe/cleanup.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-probe-docs-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, directory };
}

function filesIn(dir) {
  return readdirSync(dir, { recursive: true }).map(name => join(dir, String(name))).filter(file => {
    try { return readFileSync(file); } catch { return false; }
  });
}

test("the remote proof search matches the server proof search", () => {
  const now = 1_700_000_000_000;
  assert.equal(solveIdentityMintProofRemote("Ada", now), solveIdentityMintProof("Ada", now));
});

test("agent docs reach the documented post and close only when the packet says how", { timeout: 90000 }, async t => {
  const { origin, directory } = await serve(t);
  const outDir = join(directory, "out");
  const packet = rewriteHosts(await (await fetch(`${origin}/llms.txt`)).text(), origin);
  const documentsBoard = packet.replaceAll("`", "").split("\n").some(line => line.includes("curl ") && line.includes("/work-claims") && line.includes('"done"'));
  const created = { rooms: [], identities: [] };
  const result = await runAgentDocs({ target: origin, outDir, created, round: "docs" });
  assert.ok(result.firstPost, JSON.stringify(result.steps));
  assert.equal(result.closeReachable, documentsBoard);
  assert.equal(Boolean(result.firstClose), documentsBoard);
  writeJson(join(outDir, "sample.json"), { secret: "pri_example", privateKey: "hidden", note: "rak_example" });
  await cleanupAll(origin, created);
  writeJson(join(outDir, "created.json"), createdIds(created));
  const written = filesIn(outDir).map(file => readFileSync(file, "utf8")).join("\n");
  assert.equal(written.includes("pri_"), false);
  assert.equal(written.includes("rak_"), false);
});
