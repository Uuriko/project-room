// Merge-queue receipt. Posts one room message through the GitHub door
// (ROOM_DOOR_SECRET, the same secret as room-github-door.yml). Issue #266
// is locked, so this does not comment there. When the door secret is unset
// the run skips and says so.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { resolveConfig } from "./github-door.mjs";

export function receiptCommand({ repo, action, headRef, headSha, baseRef, reason }) {
  const h = createHash("sha256").update(`merge-queue-receipt:${repo}:${action}:${headSha}`).digest("hex");
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  const prs = String(headRef ?? "").match(/pr-(\d+)/g)?.map(part => `#${part.slice(3)}`).join(", ") || headRef || "(no ref)";
  const short = String(headSha ?? "").slice(0, 7);
  const body = action === "destroyed"
    ? `Merge queue removed ${prs} from ${baseRef} (was ${short}; reason: ${reason || "see the pull request"}). The claim stays open until someone releases it.`
    : `Merge queue is validating ${prs} on ${baseRef} (queue head ${short}).`;
  return { id, type: "message.posted", data: { messageId: id, body } };
}

export async function runReceipt({ event, repo, client }) {
  const group = event?.merge_group;
  if (!group || (event.action !== "checks_requested" && event.action !== "destroyed")) {
    return { skipped: "not a merge-queue checks_requested or destroyed event" };
  }
  const command = receiptCommand({
    repo, action: event.action, headRef: group.head_ref, headSha: group.head_sha,
    baseRef: group.base_ref, reason: event.reason
  });
  const receipt = await client.command(command);
  return { posted: true, duplicate: Boolean(receipt?.duplicate) };
}

export async function main(env = process.env) {
  const config = await resolveConfig(env, { needIssue: false });
  if (config.skipped) { console.log(JSON.stringify({ ok: false, skipped: config.skipped })); return; }
  const client = new RoomAgentClient({ origin: config.origin, roomId: config.roomId, token: config.doorKey,
    ...(config.memberId ? { memberId: config.memberId } : {}) });
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  console.log(JSON.stringify({ ok: true, ...(await runReceipt({ event, repo: config.repo, client })) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
