import { createHash } from "node:crypto";
// Ten real Room agent tasks. Each step names the tool an agent should use and
// builds its arguments from shared state. check(state) decides success.
const u = () => crypto.randomUUID();
const later = () => new Date(Date.now() + 3600e3).toISOString();
export const TASKS = [
  { id: "T01-join", goal: "Confirm you are in the bench room.",
    steps: [{ tool: "room_check_access", args: (s) => ({ roomId: s.room }) }],
    check: (s, r) => r[0]?.ok },
  { id: "T02-starter", goal: "Find your starter task.",
    steps: [{ tool: "room_list_work", args: (s) => ({ roomId: s.room }),
      ok: (o) => JSON.stringify(o?.work || []).includes("starter") }],
    note: "Lean contract: room_list_work must list file claims too. Today only room_read_board (full) shows them.",
    alt: { full: [{ tool: "room_read_board", args: (s) => ({ roomId: s.room }), ok: (o) => JSON.stringify(o?.claims || []).includes("starter") }] },
    check: (s, r) => r.at(-1)?.ok },
  { id: "T03-claim", goal: "Claim README.md for a new task.",
    steps: [
      { tool: "room_propose_work", args: (s) => ({ roomId: s.room, requestId: u(), workItemId: s.w, title: "Edit README", definitionOfDone: "README updated", accountableMemberId: s.me, mode: "write", independentVerificationRequired: false, ownerDecisionRequired: false }) },
      { tool: "room_begin_work", args: (s) => ({ roomId: s.room, workItemId: s.w, repository: "Uuriko/project-room", ref: "main", paths: [`bench/${s.w}.md`], expiresAt: later() }), ok: (o) => o?.working === true }],
    check: (s, r) => r.at(-1)?.ok },
  { id: "T04-progress", goal: "Post a progress note.",
    steps: [{ tool: "room_post_message", args: (s) => ({ roomId: s.room, messageId: u(), body: "bench: progress on README" }), save: (s, o) => (s.msg = o?.messageId || o?.id || o?.message?.id) }],
    check: (s, r) => r[0]?.ok },
  { id: "T05-answer", goal: "Answer the question in the room.",
    steps: [
      { tool: "room_read_messages", args: (s) => ({ roomId: s.room, latest: true, limit: 20 }), save: (s, o) => (s.ask = (o?.messages || []).find((m) => /QUESTION/.test(m.body || ""))?.messageId) },
      { tool: "room_reply", args: (s) => ({ roomId: s.room, requestId: u(), replyToId: s.ask, body: "bench: answer is 42" }) }],
    check: (s, r) => r.at(-1)?.ok },
  { id: "T06-handoff", goal: "Hand off the README task.",
    steps: [
      { tool: "room_read_work", args: (s) => ({ roomId: s.room, workItemId: s.w, brief: true }), save: (s, o) => (s.rev = o?.revision) },
      { tool: "room_record_handoff", args: (s) => ({ roomId: s.room, requestId: u(), workItemId: s.w, expectedRevision: s.rev, doneSummary: "half done", nextAction: "finish README", limitReason: "bench" }) }],
    check: (s, r) => r.at(-1)?.ok },
  { id: "T07-conflict", goal: "Recover from a stale-revision conflict.",
    steps: [
      { tool: "room_record_handoff", args: (s) => ({ roomId: s.room, requestId: u(), workItemId: s.w, expectedRevision: 0, doneSummary: "stale", nextAction: "x", limitReason: "bench" }), expectError: true },
      { tool: "room_read_work", args: (s) => ({ roomId: s.room, workItemId: s.w, brief: true }), save: (s, o) => (s.rev = o?.revision) }],
    check: (s, r) => r[0]?.err && r[1]?.ok && Number.isInteger(s.rev) },
  { id: "T08-receipt", goal: "Finish with a receipt.",
    steps: [
      { tool: "room_begin_work", args: (s) => ({ roomId: s.room, workItemId: s.w, repository: "Uuriko/project-room", ref: "main", paths: [`bench/${s.w}.md`], expiresAt: later() }) },
      { tool: "room_reply", args: (s) => ({ roomId: s.room, requestId: u(), replyToId: s.ask, workItemId: s.w, body: (s.rb = "Result: README updated") }), save: (s, o) => { s.rm = o?.messageId ?? o?.command?.data?.messageId ?? o?.message?.messageId; s.re = o?.eventId ?? o?.event?.id; if (process.env.BENCH_DEBUG) console.error("reply", JSON.stringify(o).slice(0, 300)); } },
      { tool: "room_read_work", args: (s) => ({ roomId: s.room, workItemId: s.w, brief: true }), save: (s, o) => (s.rev = o?.revision) },
      { tool: "room_submit_text_result", args: (s) => ({ roomId: s.room, requestId: u(), workItemId: s.w, expectedRevision: s.rev, summary: "README done", nextAction: "review", evidenceMessageId: s.rm, evidenceMessageEventId: s.re, evidenceVersion: "sha256:" + createHash("sha256").update(s.rb, "utf8").digest("hex"), previousCompletionEventId: null, producerId: s.me }) }],
    note: "11 required fields to finish one task.",
    check: (s, r) => r.at(-1)?.ok },
  { id: "T09-catchup", goal: "Catch up after being away.",
    steps: [{ tool: "room_needs_me", args: () => ({}) }],
    check: (s, r) => r[0]?.ok },
  { id: "T10-history", goal: "Find the NEEDLE message posted before 200 others.",
    steps: [{ tool: "room_read_messages", page: true, args: (s, after) => ({ roomId: s.room, after, limit: 100 }) }],
    check: (s, r) => r.some((x) => x.found) },
];
