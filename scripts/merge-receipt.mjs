// Post one compact receipt to the release room for each commit that lands on
// main: `MERGED #<pr> <sha8> · <title>`. Project state (room_project_state)
// derives "merged but not deployed" from these receipts and the PROD DEPLOY
// receipts, so nobody has to write that recap by hand.
//
// The commit subject is data: it is reduced to one short printable line before
// it is posted. A commit without a `(#n)` suffix (not a PR merge) posts nothing.
// The deterministic message id makes a rerun of the same commit a no-op.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseReceipt } from "../server/project-state.mjs";

export function mergeReceiptBody({ sha, message }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) return null;
  const subject = String(message ?? "").split("\n", 1)[0].replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  const pr = /\(#(\d{1,7})\)\s*$/.exec(subject);
  if (!pr) return null;
  const title = subject.slice(0, pr.index).trim().slice(0, 80);
  const body = `MERGED #${pr[1]} ${sha.slice(0, 8)} · ${title || "(no title)"}`;
  return parseReceipt(body) ? body : null;
}

export const mergeReceiptId = (repo, sha) => "merge-" + createHash("sha256").update(`${repo}\n${sha}`).digest("hex").slice(0, 32);

async function main(env) {
  const body = mergeReceiptBody({ sha: env.MERGE_SHA, message: env.MERGE_MESSAGE });
  if (!body) { console.log("no PR merge receipt for this commit"); return 0; }
  if (!env.ROOM_RECEIPT_TOKEN) { console.log("ROOM_RECEIPT_TOKEN not set; no Room receipt posted."); return 0; }
  const id = mergeReceiptId(env.GITHUB_REPOSITORY ?? "", env.MERGE_SHA);
  const res = await fetch(`${env.PROD_ORIGIN}/api/rooms/${env.RECEIPT_ROOM}/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.ROOM_RECEIPT_TOKEN}`, "content-type": "application/json", origin: env.PROD_ORIGIN,
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 project-room-merge-receipt" },
    body: JSON.stringify({ id, type: "message.posted", data: { messageId: id, body } })
  });
  console.log(`receipt: HTTP ${res.status}`);
  return res.ok || res.status === 409 ? 0 : 1; // 409: already recorded for this commit
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.env));
