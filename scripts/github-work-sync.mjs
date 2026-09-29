// Work sync: when a pull request merges, tell the room. A PR body line
//   Room-Work: <workItemId>            (item in the door's room)
//   Room-Work: <roomId>/<workItemId>   (explicit room; must be the door's room)
// makes the door post one message on that work item, @mentioning its
// accountable member with the merged PR as ready evidence.
//
// It never completes the item itself. The room only lets the accountable
// member report completion, under their own claim, and that stays true.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { validId } from "../src/events.js";
import { resolveConfig } from "./github-door.mjs";

const TERMINAL = new Set(["completed", "superseded"]);

export function parseRoomWork(body) {
  const out = [], seen = new Set();
  for (const m of String(body ?? "").matchAll(/^[ \t>*-]*Room-Work:[ \t]*(?:([A-Za-z0-9][\w.:-]{0,127})\/)?([A-Za-z0-9][\w.:-]{0,127})[ \t]*$/gim)) {
    const ref = { roomId: m[1] ?? null, workItemId: m[2] };
    const key = `${ref.roomId ?? ""}/${ref.workItemId}`;
    if (!validId(ref.workItemId) || seen.has(key)) continue;
    seen.add(key); out.push(ref);
    if (out.length === 10) break;
  }
  return out;
}

export function syncCommandId(repo, prNumber, workItemId) {
  const h = createHash("sha256").update(`github-work-sync:${repo}:${prNumber}:${workItemId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function syncMessage({ repo, pr, item, accountableName }) {
  const id = syncCommandId(repo, pr.number, item.id);
  const who = accountableName ? `@${accountableName} ` : "";
  const body = `${who}PR #${pr.number} "${pr.title}" merged at \`${String(pr.mergeSha).slice(0, 12)}\`: ${pr.url}\n\n`
    + `It is linked to this work item with \`Room-Work: ${item.id}\`. If it finishes the item, complete it with that PR as the evidence URL. If not, say what is left.`;
  return { id, type: "message.posted", data: { messageId: id, body, workItemId: item.id } };
}

export async function runWorkSync({ event, repo, client, roomId }) {
  const pr = event?.pull_request;
  if (event?.action !== "closed" || !pr?.merged) return { skipped: "not a merged pull request" };
  const refs = parseRoomWork(pr.body);
  if (!refs.length) return { skipped: "no Room-Work lines" };
  const snapshot = await client.snapshot();
  const results = [];
  for (const ref of refs) {
    if (ref.roomId && ref.roomId !== roomId) { results.push({ workItemId: ref.workItemId, skipped: "other room" }); continue; }
    const item = snapshot.state.workItems?.[ref.workItemId];
    if (!item) { results.push({ workItemId: ref.workItemId, skipped: "no such work item" }); continue; }
    if (TERMINAL.has(item.state)) { results.push({ workItemId: item.id, skipped: `already ${item.state}` }); continue; }
    const accountableName = snapshot.state.members?.[item.accountableMemberId]?.displayName ?? null;
    const command = syncMessage({ repo, item, accountableName,
      pr: { number: pr.number, title: String(pr.title ?? "").slice(0, 200), url: pr.html_url, mergeSha: pr.merge_commit_sha ?? "" } });
    const receipt = await client.command(command);
    results.push({ workItemId: item.id, posted: true, duplicate: Boolean(receipt?.duplicate) });
  }
  return { results };
}

export async function main(env = process.env) {
  const config = await resolveConfig(env, { needIssue: false });
  if (config.skipped) { console.log(JSON.stringify({ ok: false, skipped: config.skipped })); return; }
  const client = new RoomAgentClient({ origin: config.origin, roomId: config.roomId, token: config.doorKey,
    ...(config.memberId ? { memberId: config.memberId } : {}) });
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  console.log(JSON.stringify({ ok: true, ...(await runWorkSync({ event, repo: config.repo, client, roomId: config.roomId })) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
