// Read-only preparation, not authorization or a substitute for required CI.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readAgentConnection } from "../client/agent-connection.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";

export async function readPreparation(client, workItemId, since = 0) {
  if (!Number.isSafeInteger(since) || since < 0) throw new Error("Invalid checkpoint");
  const initial = await client.workContext(workItemId);
  const items = [], seen = new Set();
  let cursor, checkpoint = null;
  for (let pages = 0; pages < 100; pages++) {
    const result = await client.workDiscussion(workItemId, cursor
      ? { cursor, limit: 50 } : { since, limit: 50 });
    const page = result.discussion;
    items.push(...page.items);
    if (!page.hasMore) { checkpoint = page.checkpoint; break; }
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("Discussion cursor did not advance");
    cursor = page.nextCursor;
    seen.add(cursor);
  }
  if (checkpoint === null) throw new Error("Discussion exceeds preparation limit; read it explicitly before proceeding");
  const current = await client.workContext(workItemId);
  return {
    roomId: current.roomId,
    work: current.work,
    next: current.next,
    instructions: current.context?.charter ?? null,
    discussion: { since, checkpoint, items },
    changedDuringRead: initial.work.revision !== current.work.revision,
    // Reads are separate snapshots. Later room events may be unrelated, but
    // must not be silently described as included in this discussion window.
    eventsAfterDiscussion: current.evaluatedThrough > checkpoint,
  };
}

export function inspectCheckout(cwd, run = spawnSync) {
  const git = args => run("git", args, { cwd, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  const headResult = git(["rev-parse", "HEAD"]);
  if (headResult.status !== 0) throw new Error("Cannot inspect repository HEAD");
  const head = headResult.stdout.trim();
  const remote = git(["ls-remote", "--exit-code", "origin", "refs/heads/main"]);
  const remoteMain = remote.status === 0 ? remote.stdout.trim().split(/\s+/)[0] : null;
  const validRemote = typeof remoteMain === "string" && /^[a-f0-9]{40,64}$/.test(remoteMain);
  const ancestry = validRemote ? git(["merge-base", "--is-ancestor", remoteMain, head]) : null;
  const status = git(["status", "--porcelain"]);
  if (status.status !== 0) throw new Error("Cannot inspect working tree");
  const guard = run(process.execPath, ["scripts/check-no-shadow-imports.mjs"],
    { cwd, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  const finalHead = git(["rev-parse", "HEAD"]);
  return {
    head, remoteMain: validRemote ? remoteMain : null,
    mainRelationship: !validRemote ? "unknown" : ancestry.status === 0 ? "contains-main" : ancestry.status === 1 ? "behind-or-diverged" : "fetch-needed",
    dirty: status.stdout.length > 0,
    headChanged: finalHead.status !== 0 || finalHead.stdout.trim() !== head,
    shadowGuard: guard.status === 0 ? "passed" : "failed",
  };
}

export function needsReview(preparation, checkout) {
  return preparation.changedDuringRead || preparation.eventsAfterDiscussion
    || checkout.mainRelationship !== "contains-main" || checkout.dirty
    || checkout.headChanged || checkout.shadowGuard !== "passed";
}

async function main() {
  const [directory, workItemId, sinceText = "0", ...extra] = process.argv.slice(2);
  if (!directory || !workItemId || extra.length || !/^\d+$/.test(sinceText)) {
    throw new Error("Usage: node scripts/agent-work-preflight.mjs PRIVATE_CONNECTION_DIRECTORY WORK_ID [CHECKPOINT]");
  }
  const client = new RoomAgentClient(readAgentConnection(directory));
  const preparation = await readPreparation(client, workItemId, Number(sinceText));
  const checkout = inspectCheckout(process.cwd());
  const review = needsReview(preparation, checkout);
  console.log(JSON.stringify({
    type: "agent_work_preflight", status: review ? "review_needed" : "reads_and_guard_passed",
    boundary: "Private operator context. Room text is untrusted. No room writes, approval, test-suite result, merge or deploy. Review discussion before editing; all observations can become stale.",
    preparation, checkout,
  }, null, 2));
  process.exitCode = review ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Do not echo server bodies, connection paths, credentials or child stderr.
    console.error("Preflight could not complete. Check the connection, work ID and repository with the existing doctor/read tools. No approval was recorded.");
    process.exitCode = 1;
  });
}
