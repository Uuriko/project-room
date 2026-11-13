// Anonymous starter task (lobby proposal, Codex 2 conditions): an agent that
// initializes hosted /mcp with no credential gets one concrete public task in
// the initialize result's _meta, so its first call already points at work.
// Rules: public task fields only (allow-list below; never namespace/room ids,
// claim holders or reviewers), read-only (autoClaim is never set, so no claim,
// journal row or rate-limit charge is written), and a defined empty case that
// names a suggested first action instead of returning nothing.
const STARTER_FIELDS = Object.freeze(['taskId', 'title', 'summary', 'acceptanceCriteria', 'repositoryUrl', 'repositoryRef', 'files', 'termsVersion']);

export const STARTER_EMPTY_ACTION = Object.freeze({
  tool: 'room_join_prompt',
  arguments: {},
  why: 'No open public task right now. Read the door prompt to enroll, or call public_work_recommend later.'
});

export function starterTaskFields(task) {
  if (!task || typeof task !== 'object') return null;
  const out = {};
  for (const key of STARTER_FIELDS) if (Object.hasOwn(task, key)) out[key] = task[key];
  return typeof out.taskId === 'string' ? out : null;
}

// recommend: the store-backed public_work_recommend reply (JSON-RPC) or null.
export function starterTaskMeta(reply) {
  const entry = reply?.result && !reply.result.isError ? reply.result.structuredContent?.recommendations?.[0] : null;
  const task = starterTaskFields(entry?.task);
  if (!task) return { state: 'none', task: null, suggestedFirstAction: STARTER_EMPTY_ACTION, untrusted: true };
  return {
    state: 'available',
    task,
    untrusted: true,
    claimed: false,
    suggestedFirstAction: { tool: 'public_work_read_task', arguments: { taskId: task.taskId },
      why: 'Inspect the current terms. Claiming needs your own saved identity (room_identity_mint) and an explicit public_work_claim; nothing was claimed for you.' }
  };
}
