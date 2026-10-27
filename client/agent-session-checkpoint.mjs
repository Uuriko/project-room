// A resumable observation, not a task journal, permission grant or read marker.
// Reuse private atomic persistence and its single-writer lock in a dedicated
// subdirectory. Never open, rewrite or discard execution/delivery journals.
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { openSetupJournal } from "./setup-journal.mjs";
import { validId } from "../src/events.js";

const fail = code => Object.assign(new Error(code), { code });
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const historyValid = value => value && validId(value.createdEventId) && validId(value.eventId)
  && Number.isSafeInteger(value.sequence) && value.sequence > 0;
const instructionsValid = value => value && Number.isSafeInteger(value.revision) && value.revision >= 0
  && (value.revision === 0 ? value.eventId === null : validId(value.eventId));
const identityKeys = ["viewerId", "viewerAccountId", "viewerAuthEpoch", "viewerSessionBinding", "viewerSessionRevision"];
const binding = (value, connection) => ({ origin: new URL(connection.origin).origin, roomId: connection.roomId,
  memberId: connection.memberId, ...Object.fromEntries(identityKeys.map(key => [key, value[key] ?? null])) });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function resumeAgentSession(client, { connection, directory, workItemId, signal } = {}) {
  if (!directory || !connection?.memberId || workItemId !== undefined && !validId(workItemId)) throw fail("session_checkpoint_invalid");
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077 || root.uid !== process.getuid())
    throw fail("session_checkpoint_not_private");
  const journal = openSetupJournal(join(directory, "agent-session"));
  try {
    const saved = journal.read();
    if (saved && (saved.schemaVersion !== 1 || !hash(saved.contextVersion)
      || saved.workActionContractRevision !== undefined && !hash(saved.workActionContractRevision) || !historyValid(saved.history)
      || !instructionsValid(saved.instructions) || !Array.isArray(saved.workRefs) || saved.workRefs.length > 100
      || saved.workRefs.some(ref => !validId(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 0)
      || saved.selectedWorkId !== null && !validId(saved.selectedWorkId))) throw fail("session_checkpoint_invalid");
    const origin = new URL(connection.origin).origin;
    if (saved && (saved.binding?.origin !== origin || saved.binding?.roomId !== connection.roomId
      || saved.binding?.memberId !== connection.memberId)) throw fail("session_scope_changed");
    const context = await client.roomContext({ ...(saved ? { ...(saved.workActionContractRevision ? { sinceVersion: saved.contextVersion } : {}), checkpoint: saved.history } : {}), signal });
    if (context.roomId !== connection.roomId || context.viewerId !== connection.memberId || !hash(context.context_version)
      || !hash(context.workActionContractRevision)
      || !historyValid(context.history) || context.history.sequence !== context.evaluatedThrough)
      throw fail("session_context_invalid");
    const currentBinding = binding(context, connection);
    if (saved && !equal(saved.binding, currentBinding)) throw fail("session_scope_changed");
    if (saved && (saved.history.createdEventId !== context.history.createdEventId || saved.history.sequence > context.history.sequence
      || saved.history.sequence === context.history.sequence && saved.history.eventId !== context.history.eventId))
      throw fail("context_history_changed");
    if (context.not_modified === true && (!saved || saved.contextVersion !== context.context_version
      || saved.workActionContractRevision !== context.workActionContractRevision)) throw fail("session_context_invalid");
    const instructions = context.not_modified === true ? saved.instructions : context.instructions;
    if (!instructionsValid(instructions)) throw fail("session_context_invalid");
    const workRefs = context.not_modified === true ? saved.workRefs : context.focusWork?.map(({ id, revision }) => ({ id, revision }));
    if (!Array.isArray(workRefs) || workRefs.length > 100
      || workRefs.some(ref => !validId(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 0))
      throw fail("session_context_too_large");
    const checkpoint = { schemaVersion: 1, binding: currentBinding, contextVersion: context.context_version,
      workActionContractRevision: context.workActionContractRevision,
      history: { createdEventId: context.history.createdEventId, sequence: context.history.sequence, eventId: context.history.eventId }, instructions: { revision: instructions.revision, eventId: instructions.eventId },
      workRefs: workRefs.map(({ id, revision }) => ({ id, revision })), selectedWorkId: workItemId ?? saved?.selectedWorkId ?? null };
    signal?.throwIfAborted();
    journal.save(checkpoint);
    const path = `/api/rooms/${encodeURIComponent(connection.roomId)}`;
    const instructionsChanged = !saved || !equal(saved.instructions, checkpoint.instructions);
    return { status: saved ? "resumed" : "initialized", authorityGranted: false,
      contextChanged: context.not_modified !== true,
      instructionsChanged,
      capabilitiesChanged: !saved || saved.workActionContractRevision !== checkpoint.workActionContractRevision,
      checkpoint, ...(context.not_modified === true ? {} : { context }),
      nextReads: [
        { method: "GET", path: `${path}/agent-work`, purpose: "Current addressed requests and blockers; session context does not enumerate them" },
        ...(instructionsChanged ? [{ method: "GET", path: `${path}/charter`, purpose: "Read changed instructions" }] : []),
        ...(checkpoint.selectedWorkId ? [{ method: "GET", path: `${path}/work-context?workItemId=${encodeURIComponent(checkpoint.selectedWorkId)}`,
          purpose: "Revalidate selected work before acting" }] : [])
      ], guidance: "Observed checkpoint only, not read acknowledgement or execution permission. Pending operations remain in their original journals; reconcile them before new execution. Context omits message bodies and external evidence. If your current model context lacks the instructions, read this room's /charter even when their revision is unchanged. Preserve this checkpoint on scope or history refusal; reconcile before restarting." };
  } finally { journal.close(); }
}
