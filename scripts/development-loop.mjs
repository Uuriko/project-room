// Explicit bridge over existing work/reply APIs. No host, scheduler or release writes.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { agentConnectionFromEnvironment } from '../client/agent-connection.mjs';
import { buildReplyCommand } from '../client/reply-actions.mjs';
import { validId } from '../src/events.js';
import { classifyReproduction } from './browser-reproduction-host.mjs';
import { buildBrowserFailureWork } from './browser-failure-work.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const require = (value, message) => { if (!value) throw new Error(message); };
function read(path) {
  const stat = lstatSync(path); require(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'Bounded regular evidence file required');
  const bytes = readFileSync(path); require(bytes.length <= 8 * 1024 * 1024, 'Evidence exceeds bound'); return bytes;
}
export function previewDevelopmentLoop(packetBytes, config, evidence) {
  const packet = JSON.parse(packetBytes.toString());
  require(evidence?.receiptPath && evidence?.junitPath, 'Original evidence paths required');
  const rebuilt = buildBrowserFailureWork({ checkout: config.checkout, repo: packet.source?.repo,
    revision: packet.source?.revision, tree: packet.source?.tree, runId: packet.observation?.runId,
    runAttempt: packet.observation?.runAttempt, receipt: evidence.receiptPath, junit: evidence.junitPath,
    sourceRoot: config.sourceRoot, accountableMember: config.recipientId });
  require(isDeepStrictEqual(packet, rebuilt), 'Packet does not match revalidated source and failed cases');
  evidence = { receiptBytes: read(evidence.receiptPath), junitBytes: read(evidence.junitPath) };
  require(packet.version === 1 && packet.mode === 'preview' && sha(packet.source?.revision) && sha(packet.source?.tree)
    && /^[\w.-]+\/[\w.-]+$/.test(packet.source?.repo ?? ''), 'Invalid failure packet source');
  require(digest(packet.evidence?.receiptSha256) && digest(packet.evidence?.junitSha256), 'Missing evidence digests');
  require(evidence && hash(evidence.receiptBytes) === packet.evidence.receiptSha256 && hash(evidence.junitBytes) === packet.evidence.junitSha256, 'Original evidence digest mismatch');
  const original = JSON.parse(evidence.receiptBytes.toString());
  require(original.revision === packet.source.revision && original.runId === packet.observation?.runId
    && String(original.runAttempt) === String(packet.observation?.runAttempt) && original.status > 0 && original.signal === null, 'Original failed receipt identity mismatch');
  require(Array.isArray(packet.failures) && packet.failures.filter(row => row.id === config.failureId).length === 1, 'Choose one unique failure');
  const chosen = packet.failures.find(row => row.id === config.failureId);
  require(/^scripts\/[\w/-]+\.mjs$/.test(chosen.script ?? '') && !chosen.script.split('/').includes('..')
    && typeof chosen.testName === 'string' && chosen.testName.length > 0 && chosen.testName.length <= 1000
    && !/[\u0000-\u001f]/.test(chosen.testName) && original.files?.includes(chosen.script), 'Invalid chosen test');
  const expectedId = 'browser-failure-' + hash(JSON.stringify([packet.source.repo.toLowerCase(), packet.source.revision, chosen.script, chosen.testName])).slice(0, 40);
  require(chosen.id === expectedId, 'Failure identity mismatch');
  for (const key of ['roomId', 'memberId', 'recipientId']) require(validId(config[key]), 'Explicit Room identities required');
  const origin = new URL(config.origin); require(!origin.username && !origin.password && !origin.search && !origin.hash
    && (origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)), 'Invalid Room origin');
  require(!config.existingWorkItemId || validId(config.existingWorkItemId), 'Invalid existing work id');
  const workItemId = config.existingWorkItemId || chosen.id;
  const packetSha256 = hash(packetBytes);
  const proposal = { ...chosen.workAction.args, workItemId };
  const request = { requestId: `dev-request-${hash(JSON.stringify([origin.origin, config.roomId, workItemId, chosen.id, config.recipientId, packetSha256])).slice(0, 40)}`,
    toMemberId: config.recipientId, workItemId,
    body: `Reproduce browser failure ${chosen.id}. Source ${packet.source.repo} revision ${packet.source.revision}, tree ${packet.source.tree}. Selected test ${JSON.stringify(chosen.testName)} in ${chosen.script}. Packet SHA256 ${packetSha256}; original receipt SHA256 ${packet.evidence.receiptSha256}; JUnit SHA256 ${packet.evidence.junitSha256}. Use only operator-configured local commands. Return a bounded reproduction receipt binding packet digest, work/request identity, exact source/test and stdout digest. Retain failure or unknown outcomes. A reply is not work completion, verification, approval or deployment.` };
  const requestMessageId = buildReplyCommand(config, 'room_request_reply', request).data.messageId;
  return { version: 1, kind: 'development-loop-plan', origin: origin.origin, roomId: config.roomId, memberId: config.memberId,
    existingWork: Boolean(config.existingWorkItemId), source: packet.source, failure: { id: chosen.id, script: chosen.script, testName: chosen.testName },
    packetSha256, evidence: packet.evidence, proposal, request, requestMessageId };
}
function validatePlan(plan) {
  require(plan?.version === 1 && plan.kind === 'development-loop-plan' && digest(plan.packetSha256)
    && sha(plan.source?.revision) && sha(plan.source?.tree) && validId(plan.proposal?.workItemId), 'Invalid development plan');
  require(plan.request?.workItemId === plan.proposal.workItemId && plan.request.toMemberId === plan.proposal.accountableMemberId
    && buildReplyCommand(plan, 'room_request_reply', plan.request).data.messageId === plan.requestMessageId, 'Plan identity mismatch');
}
export async function submitDevelopmentLoop(plan, connection, client = new RoomAgentClient(connection)) {
  validatePlan(plan);
  require(connection.origin.replace(/\/$/, '') === plan.origin && connection.roomId === plan.roomId && connection.memberId === plan.memberId, 'Connection differs from preview');
  // Replaying the same operation lets Room reconcile an unknown first response.
  if (!plan.existingWork) {
    const receipt = await client.workAction('room_propose_work', plan.proposal);
    require(receipt.status === 'recorded', 'Work proposal unconfirmed');
  }
  const selected = await client.workContext(plan.proposal.workItemId);
  require(selected.roomId === plan.roomId && selected.viewer.id === plan.memberId
    && selected.work.id === plan.proposal.workItemId && selected.work.accountableMemberId === plan.proposal.accountableMemberId, 'Existing work identity or accountable member conflicts');
  if (!plan.existingWork) for (const key of ['title', 'definitionOfDone', 'mode', 'ownerDecisionRequired'])
    require(isDeepStrictEqual(selected.work[key], plan.proposal[key]), 'Proposed work differs from preview');
  const reply = await client.replyAction('room_request_reply', plan.request);
  require(reply.status === 'recorded' && reply.requestMessageId === plan.requestMessageId, 'Addressed request unconfirmed');
  const context = await client.replyContext(plan.requestMessageId, { limit: 1 });
  require(context.viewerId === plan.memberId && context.request.id === plan.requestMessageId
    && context.request.recipientId === plan.request.toMemberId && context.request.workItemId === plan.proposal.workItemId, 'Request readback mismatch');
  return { version: 1, kind: 'development-loop-submission', planSha256: hash(JSON.stringify(plan)), workItemId: selected.work.id,
    workRevision: selected.work.revision, requestMessageId: plan.requestMessageId, requestStatus: context.request.status,
    currentStateVerified: true, workState: selected.work.state, actionsPerformed: { accepted: false, completed: false, approved: false } };
}
export function linkDevelopmentEvidence(plan, receiptBytes, stdoutBytes, releaseRecordBytes = null) {
  validatePlan(plan); const receipt = JSON.parse(receiptBytes.toString());
  require(receipt.version === 1 && receipt.kind === 'browser-reproduction' && receipt.packetId === plan.failure.id && receipt.packetSha256 === plan.packetSha256
    && receipt.workItemId === plan.proposal.workItemId && receipt.requestMessageId === plan.requestMessageId
    && receipt.revision === plan.source.revision && receipt.tree === plan.source.tree
    && receipt.script === plan.failure.script && receipt.testName === plan.failure.testName, 'Reproduction binding mismatch');
  require(digest(receipt.stdoutSha256) && hash(stdoutBytes) === receipt.stdoutSha256 && receipt.stdoutBytes === stdoutBytes.length
    && ['passed', 'failed', 'unknown'].includes(receipt.outcome), 'Reproduction output evidence mismatch');
  const classified = classifyReproduction(stdoutBytes.toString('utf8'), receipt.exitCode, plan.failure.testName);
  require(receipt.observedOutcome === classified && (receipt.outcome === classified || receipt.outcome === 'unknown'), 'Contradictory reproduction outcome');
  let release = null;
  if (releaseRecordBytes) {
    const record = JSON.parse(releaseRecordBytes.toString());
    require(record.schemaVersion === 1 && record.target?.repository === plan.source.repo && sha(record.target.revision) && sha(record.target.tree)
      && digest(record.id) && Array.isArray(record.attempts), 'Invalid release record identity');
    require(record.id === hash(JSON.stringify({ repository: record.target.repository, revision: record.target.revision, tree: record.target.tree })), 'Release target digest mismatch');
    release = { sha256: hash(releaseRecordBytes), target: record.target, relation: 'same-repository-only; fix relationship unproven' };
  }
  return { version: 1, kind: 'development-loop-evidence', failureId: plan.failure.id, workItemId: plan.proposal.workItemId,
    requestMessageId: plan.requestMessageId, source: plan.source, packetSha256: plan.packetSha256,
    reproduction: { receiptSha256: hash(receiptBytes), stdoutSha256: receipt.stdoutSha256, outcome: receipt.outcome }, release,
    conclusions: { fixed: 'not-established', deployed: 'not-established', approved: 'not-established' },
    limitations: ['Unsigned local evidence links; matching digests do not authenticate producers.', 'A passing reproduction is not proof of a fix or release.'] };
}
export async function main(argv) {
  const [mode, ...paths] = argv;
  if (mode === 'preview' && paths.length === 5) {
    const [packet, config, receipt, junit, out] = paths;
    const plan = previewDevelopmentLoop(read(packet), JSON.parse(read(config)), { receiptPath: receipt, junitPath: junit });
    writeFileSync(out, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return { mode, writes: 'local-preview-only' };
  }
  if (mode === 'submit' && paths.length === 1) return submitDevelopmentLoop(JSON.parse(read(paths[0])), agentConnectionFromEnvironment());
  if (mode === 'link' && [3, 4].includes(paths.length)) return linkDevelopmentEvidence(JSON.parse(read(paths[0])), read(paths[1]), read(paths[2]), paths[3] ? read(paths[3]) : null);
  throw new Error('Usage: development-loop.mjs preview PACKET CONFIG ORIGINAL_RECEIPT JUNIT NEW_PLAN | submit PLAN | link PLAN REPRO_RECEIPT STDOUT [RELEASE_RECORD]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(value => console.log(JSON.stringify(value))).catch(() => { console.error('Development loop refused or outcome unknown. Preserve the preview and retry unchanged; no completion or deployment is claimed.'); process.exitCode = 1; });
}
