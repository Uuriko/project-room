// Differential replays (D-1, D-2, D-3) + RACE-K1 — compact faithful
// re-derivations of the HUNT-DIFFERENTIAL family scripts (fam-board4 z2,
// fam-event2 A2/B2, fam-board2 c1/c3) against a locally booted server,
// plus the MCP finish-fence omission. Same doors, same call shapes.
import { createHash } from "node:crypto";
import { bootServer, mkMember, mcp, post, get, codeOf, fixed, still, notfiled } from "../lib.mjs";

const id = process.argv[2];
const R = "commons";
const future = (h) => new Date(Date.now() + h * 3600e3).toISOString();
let seq = 0;
const rid = (p) => `${p}-${++seq}`;
const sha = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");

const { f, origin, close } = await bootServer();
const owner = f.keys.owner;
const WC = `/api/rooms/${R}/work-claims`;
async function boardRow(cid) {
  const read = await get(origin, owner, `/api/rooms/${R}/work-claims-read`);
  return (read.body?.claims ?? []).find((r) => r.id === cid) ?? null;
}
async function eventItem(wid) {
  const snap = await get(origin, owner, `/api/rooms/${R}`);
  return snap.body?.state?.workItems?.[wid] ?? null;
}
async function cmd(secret, type, data) {
  return post(origin, secret, `/api/rooms/${R}/commands`, { id: rid("cmd"), type, data });
}

if (id === "DIFF-D1") {
  const W = mkMember(f, "D1 worker", R, ["accept_work", "complete_work", "write_external", "steer"]);
  const X = mkMember(f, "D1 second", R, ["accept_work", "complete_work", "write_external"]);
  await mcp(origin, W.secret, "room_propose_work", { roomId: R, requestId: rid("p"), workItemId: "z2", title: "z2", definitionOfDone: "d", accountableMemberId: W.memberId, mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false });
  await mcp(origin, W.secret, "room_accept_work", { roomId: R, requestId: rid("a"), workItemId: "z2", expectedRevision: 0 });
  const restClaim = await post(origin, X.secret, `${WC}/z2/claim`, { files: ["src/z2.js"], leaseHours: 2 });
  const mcpAcquire = await mcp(origin, W.secret, "room_acquire_claim", { roomId: R, requestId: rid("q"), workItemId: "z2", expectedRevision: 1, repository: "Example/Project", ref: "main", paths: ["src/z2.js"], expiresAt: future(2) });
  const row = await boardRow("z2");
  const evt = await eventItem("z2");
  const mcpRelease = await mcp(origin, W.secret, "room_release_claim", { roomId: R, requestId: rid("r"), workItemId: "z2", expectedRevision: 2 });
  const rowAfter = await boardRow("z2");
  const renew = await post(origin, X.secret, `${WC}/z2/renew`, { leaseHours: 1 });
  await close();
  const dualHold = restClaim.status < 300 && !mcpAcquire.isError;
  if (dualHold) still(`both doors hold z2 at once: REST board claim by X (${restClaim.status}) and MCP event acquire by W both succeeded; board row says holder-state '${row?.state}' while the event claim names a different holder; W's event release then ${mcpRelease.isError ? "errored" : "succeeded"} and X's board renew afterwards -> ${renew.status} — the two claim surfaces contradict (no shared fence)`);
  else if (mcpAcquire.isError) fixed(`the second door's acquire is refused once the board claim is held (${codeOf(mcpAcquire) ?? "error"}) — one claim namespace`);
  else notfiled(`unexpected shape: rest=${restClaim.status} acquire isError=${mcpAcquire.isError} row=${JSON.stringify(row)?.slice(0, 120)}`);
} else if (id === "DIFF-D3") {
  const W = mkMember(f, "D3 worker", R, ["accept_work", "complete_work", "write_external"]);
  await post(origin, owner, WC, { id: "c1", title: "Finish me" });
  await post(origin, W.secret, `${WC}/c1/claim`, { files: ["src/c1.js"], leaseHours: 2 });
  await post(origin, W.secret, `${WC}/c1/update`, { state: "in_progress" });
  await post(origin, W.secret, `${WC}/c1/update`, { note: "halfway" });
  const finish = await post(origin, W.secret, `${WC}/c1/update`, { state: "delivered", note: "done" });
  await post(origin, owner, WC, { id: "c3", title: "Release me" });
  await post(origin, W.secret, `${WC}/c3/claim`, { files: ["src/c3.js"], leaseHours: 2 });
  const release = await post(origin, W.secret, `${WC}/c3/release`, {});
  await close();
  const unfencedFinish = finish.status < 300;
  const fencedRelease = release.status >= 400;
  if (unfencedFinish && fencedRelease) still(`asymmetric gates: update->delivered with NO fence after an interleaving history write succeeded (${finish.status}), while release without {expectedClaimedAt, expectedHistoryLength} is refused (${release.status} ${codeOf(release) ?? ""}) — the finish door validates the fence only when present`);
  else if (!unfencedFinish) fixed(`unfenced update->delivered after an interleave is refused (${finish.status} ${codeOf(finish) ?? ""}) — the finish door validates the claim fence`);
  else notfiled(`unexpected shape: finish=${finish.status} release=${release.status}`);
} else if (id === "DIFF-D2") {
  const P = mkMember(f, "D2 proposer", R, ["steer", "accept_work", "complete_work", "write_external", "manage_claims"]);
  const W = mkMember(f, "D2 worker", R, ["accept_work", "complete_work", "write_external"]);
  const V = mkMember(f, "D2 verifier", R, ["verify"]);
  // A2: all MCP
  const A = "diff-a2";
  await mcp(origin, P.secret, "room_propose_work", { roomId: R, requestId: rid("p"), workItemId: A, title: A, definitionOfDone: "d", accountableMemberId: W.memberId, verifierMemberId: V.memberId, mode: "write", independentVerificationRequired: true, ownerDecisionRequired: false });
  await mcp(origin, W.secret, "room_accept_work", { roomId: R, requestId: rid("a"), workItemId: A, expectedRevision: 0 });
  await mcp(origin, W.secret, "room_acquire_claim", { roomId: R, requestId: rid("q"), workItemId: A, expectedRevision: 1, repository: "Example/Project", ref: "main", paths: [`src/${A}.js`], expiresAt: future(2) });
  await mcp(origin, W.secret, "room_start_work", { roomId: R, requestId: rid("s"), workItemId: A, expectedRevision: 2 });
  const bodyA = "Result text for A2: implemented and tested.";
  const draftA = await mcp(origin, W.secret, "room_post_draft", { roomId: R, requestId: rid("d"), workItemId: A, packetId: "pkt-a2", basisRevision: 3, body: bodyA });
  const subA = await mcp(origin, W.secret, "room_submit_text_result", { roomId: R, requestId: rid("sub"), workItemId: A, expectedRevision: 3, summary: "done A2", nextAction: "verify", evidenceMessageId: draftA.value?.messageId, evidenceMessageEventId: draftA.value?.eventId, evidenceVersion: sha(bodyA), previousCompletionEventId: null, producerId: W.memberId });
  const itA = await eventItem(A);
  // B2: all commands
  const B = "diff-b2";
  await cmd(P.secret, "work.proposed", { workItemId: B, title: B, definitionOfDone: "d", accountableMemberId: W.memberId, verifierMemberId: V.memberId, mode: "write", independentVerificationRequired: true, ownerDecisionRequired: false });
  await cmd(W.secret, "work.accepted", { workItemId: B });
  await cmd(W.secret, "claim.acquired", { workItemId: B, repository: "Example/Project", ref: "main", paths: [`src/${B}.js`], expiresAt: future(2) });
  await cmd(W.secret, "work.started", { workItemId: B });
  const bodyB = "Result text for B2: implemented and tested.";
  const draftB = await cmd(W.secret, "message.posted", { messageId: "draft-b2", body: bodyB, workItemId: B, packetId: "pkt-b2", basisRevision: 3 });
  const evB = draftB.body?.event?.id;
  const subB = await cmd(W.secret, "work.completed", { workItemId: B, evidenceKind: "room_text", summary: "done B2", nextAction: "verify", evidenceMessageId: "draft-b2", evidenceMessageEventId: evB, evidenceVersion: sha(bodyB), previousCompletionEventId: null, producerId: W.memberId });
  const itB = await eventItem(B);
  let verA = null, verB = null;
  if (itA?.receipt) verA = await mcp(origin, V.secret, "room_record_verification", { roomId: R, requestId: rid("v"), workItemId: A, expectedRevision: itA.revision, result: "pass", completionEventId: itA.receipt.eventId, evidenceVersion: itA.receipt.evidenceVersion, summary: "ok" });
  if (itB?.receipt) verB = await cmd(V.secret, "verification.recorded", { workItemId: B, result: "pass", completionEventId: itB.receipt.eventId, evidenceVersion: itB.receipt.evidenceVersion, summary: "ok" });
  const finA = await eventItem(A);
  const finB = await eventItem(B);
  await close();
  const aOk = !subA.isError && finA?.verification?.result === "pass";
  const bOk = subB.status < 300 && finB?.verification?.result === "pass";
  const aState = `${itA?.state}/rev${itA?.revision}`;
  const bState = `${itB?.state}/rev${itB?.revision}`;
  if (aOk && bOk && itA?.state === itB?.state) fixed(`identical intent through MCP and /commands converges: A2 ${aState} verified, B2 ${bState} verified`);
  else still(`same work, two doors, different outcomes — MCP: submit ${subA.isError ? `error ${codeOf(subA) ?? ""}` : "ok"}, item ${aState}, verification ${finA?.verification?.result ?? "none"}; commands: submit http ${subB.status} ${codeOf(subB) ?? ""}, item ${bState}, verification ${finB?.verification?.result ?? "none"} (commands-built history carries no revision the completion path can use)`);
} else if (id === "RACE-K1") {
  const W = mkMember(f, "K1 worker", R, ["accept_work", "complete_work", "write_external"]);
  const X = mkMember(f, "K1 second", R, ["accept_work", "complete_work", "write_external", "manage_claims"]);
  await post(origin, owner, WC, { id: "k1", title: "Fence me" });
  const claim = await post(origin, W.secret, `${WC}/k1/claim`, { files: ["src/k1.js"], leaseHours: 2 });
  const row0 = await boardRow("k1");
  // Interleaving write on the same row (the holder's own note update —
  // the fam-board2 interleave shape — grows the history under the claim).
  const link = await post(origin, W.secret, `${WC}/k1/update`, { note: "interleaving note" });
  const row1 = await boardRow("k1");
  // Control: REST finish with the now-stale fence is refused.
  const staleFinish = await post(origin, W.secret, `${WC}/k1/update`, { state: "delivered", expectedClaimedAt: row0?.claimedAt, expectedHistoryLength: row0?.history?.length });
  // The MCP plain finish: room_close_work_claim takes no fence at all.
  const mcpClose = await mcp(origin, W.secret, "room_close_work_claim", { roomId: R, claimId: "k1", verb: "close" });
  const row2 = await boardRow("k1");
  await close();
  if (!mcpClose.isError && staleFinish.status >= 400)
    still(`REST finish with a stale fence after an interleaving write is refused (${staleFinish.status} ${codeOf(staleFinish) ?? ""}), but MCP room_close_work_claim — whose arguments carry no fence fields at all — closed the claim anyway (row state '${row2?.state}', history ${row1?.history?.length} -> ${row2?.history?.length}); interleave note update: ${link.status}`);
  else if (mcpClose.isError) fixed(`MCP plain finish after an interleaving write is refused (${codeOf(mcpClose) ?? mcpClose.value?.code ?? "error"}) — the finish fence now applies on the MCP door`);
  else notfiled(`unexpected shape: claim=${claim.status} link=${link.status} staleFinish=${staleFinish.status} mcpClose isError=${mcpClose.isError} row=${row2?.state}`);
} else {
  await close();
  notfiled(`differential.mjs has no probe for ${id}`);
}
