// Merge train rollback drill. Proves the smoke-red path rolls a landed
// batch back with a forward commit.
//
//   node scripts/merge-train-rollback-drill.mjs           in-memory GitHub (CI)
//   node scripts/merge-train-rollback-drill.mjs --live --repo owner/name
//       real GitHub on a scratch branch room-train-drill/<ts> cut from main.
//       Needs GITHUB_TOKEN or GH_TOKEN (contents write). Never touches main
//       or production; deletes the scratch branch at the end. Run it against
//       the staging repo/branch before trusting auto-rollback in prod.
//
// Prints a JSON verdict. The token is read from the environment and never
// printed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { githubClient } from "../server/merge-train.mjs";
import { githubAccessToken } from "../server/land-queue.mjs";
import { fakeGitHub } from "./merge-train-fake-github.mjs";

export async function runDrill({ live = false, repo = "o/r", env = process.env } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "merge-train-drill-"));
  const clock = { now: Date.now() };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  let scratch = null;
  let gh = null;
  try {
    store.initialize(initialRoom("drill"));
    const owner = store.room("drill").state.room.ownerId;
    const train = store.mergeTrain;
    if (live) {
      train.configure({ token: githubAccessToken(env) });
    } else {
      const fake = fakeGitHub({ files: {} });
      fake.clock = () => clock.now;
      train.configure({ token: null, fetchImpl: fake.fetchImpl });
    }
    gh = train.gh;
    // Scratch base: a branch cut from main, so nothing real moves.
    scratch = `room-train-drill/${clock.now}`;
    const mainSha = await gh.refSha(repo, "main");
    await gh.createRef(repo, scratch, mainSha);
    train.configure({ baseBranch: scratch });
    // "Land" a batch on the scratch branch: one commit on top of the base.
    const tree = await gh.commitTree(repo, mainSha);
    const landed = await gh.createCommit(repo, "merge train drill: landed batch", tree, [mainSha]);
    if (!(await gh.fastForward(repo, scratch, landed))) throw new Error("could not advance scratch branch");
    const batchId = `mtb_drill${clock.now}`;
    store.db.prepare(`INSERT INTO merge_train_batches (room_id, batch_id, repo, state, base_sha, branch, head_sha, entry_ids,
      landed_at, created_at, updated_at) VALUES ('drill',?,?,'smoke',?,?,?,'[]',?,?,?)`)
      .run(batchId, repo, mainSha, `room-train/${batchId}`, landed, clock.now, clock.now, clock.now);
    const out = await train.recordSmoke("drill", owner, { batchId, ok: false });
    const head = await gh.refSha(repo, scratch);
    const headTree = await gh.commitTree(repo, head);
    const ok = out.state === "rolled_back" && head !== landed && headTree === tree;
    return { ok, state: out.state, live, repo: live ? repo : "in-memory" };
  } catch (error) {
    return { ok: false, error: error?.code ?? error?.message ?? "error", live };
  } finally {
    if (live && scratch && gh) await gh.deleteRef(repo, scratch).catch(() => {});
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const repo = args[args.indexOf("--repo") + 1];
  if (live && (!repo || repo.startsWith("--"))) { console.error("--live needs --repo owner/name"); process.exit(2); }
  const out = await runDrill({ live, repo: live ? repo : "o/r" });
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
