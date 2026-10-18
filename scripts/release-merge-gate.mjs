// Required GitHub status + the existing durable MERGE-SLOT. No daemon, new
// credential, permission grant, or second queue. Dry-run unless --apply.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CONTEXT = 'room/release-lease';
export const REQUIRED = ['test', 'contract', 'lint', 'browser', 'cloudflare'];
const SHA = /^[a-f0-9]{40}$/;
const fail = message => { throw new Error(message); };

export function protectionPlan(current) {
  if (!current || typeof current.strict !== 'boolean' || !Array.isArray(current.checks)) fail('Read complete existing required-check protection first');
  const checks = current.checks.map(({ context, app_id }) => ({ context, app_id: app_id ?? -1 }));
  for (const context of REQUIRED) if (!checks.some(check => check.context === context)) fail(`Existing protection is missing ${context}`);
  if (!checks.some(check => check.context === CONTEXT)) checks.push({ context: CONTEXT, app_id: -1 });
  return { strict: current.strict, checks };
}
export function grantOf(slot, identity, candidate, now = Date.now()) {
  if (slot?.state !== 'claimed' || !identity || slot.owner !== identity || !slot.claimedAt ||
      !(Date.parse(slot.leaseExpiresAt) > now + 120000)) fail('An owned MERGE-SLOT with at least two minutes remaining is required');
  let grant;
  const note = slot.history?.findLast(stamp => stamp.action === 'claimed')?.note;
  try { grant = JSON.parse(note); } catch { fail('MERGE-SLOT claim note must be the exact JSON release grant'); }
  if (grant.kind !== 'room.release-merge.v1' || grant.repo !== candidate.repo || grant.pr !== candidate.pr ||
      grant.head !== candidate.head || grant.base !== candidate.base || !SHA.test(grant.head) || !SHA.test(grant.base) ||
      !['normal', 'deploy-fix'].includes(grant.purpose) || typeof grant.directiveMessageId !== 'string' || !grant.directiveMessageId) {
    fail('Release grant does not bind this exact repository, PR, head, base and recorded directive');
  }
  return { ...grant, owner: slot.owner, claimedAt: slot.claimedAt };
}
export function candidateReady(candidate, info, main, protection) {
  if (!Number.isSafeInteger(candidate.pr) || candidate.pr < 1 || !SHA.test(candidate.head) || !SHA.test(candidate.base)) fail('Full head/base SHAs and positive PR number required');
  if (info.state !== 'OPEN' || info.isDraft || info.headRefOid !== candidate.head || info.baseRefName !== 'main' || main !== candidate.base ||
      !['MERGEABLE'].includes(info.mergeable)) fail('PR head/base, draft state or mergeability changed');
  if (!protection.checks.some(check => check.context === CONTEXT)) fail('Install the required landing status before authorizing a merge');
  if (protection.enforceAdmins !== true) fail('Administrator enforcement must remain enabled');
  for (const required of protection.checks) {
    if (required.context === CONTEXT) continue;
    const found = (info.statusCheckRollup ?? []).filter(check => (check.name ?? check.context) === required.context);
    if (!found.length || found.some(check => !['SUCCESS', 'success'].includes(check.conclusion ?? check.state) ||
        (check.status && check.status !== 'COMPLETED'))) fail(`Required check ${required.context} is not green on the exact head`);
  }
}
export function problemKeyCheck(grant, claims) {
  if (grant.problemKeys !== undefined && (!Array.isArray(grant.problemKeys) || grant.problemKeys.some(key => typeof key !== 'string' || !key.trim()))) fail('problemKeys must be nonempty strings');
  const keys = new Set(grant.problemKeys ?? []);
  for (const claim of claims) {
    if (claim.id === grant.workClaimId || claim.id === 'MERGE-SLOT' || !['claimed', 'in_progress', 'blocked'].includes(claim.state)) continue;
    if (claim.problemKey && keys.has(claim.problemKey)) fail(`Problem ${claim.problemKey} is held by ${claim.owner} in ${claim.id}; resolve or record supersession in Room first`);
  }
}
export function pauseCheck(pause, grant) {
  if (!pause || !['unclaimed', 'claimed', 'in_progress', 'blocked'].includes(pause.state)) fail('Read the native RELEASE-PAUSE state; missing or terminal state is not permission');
  if (pause.state === 'unclaimed') return;
  if (typeof pause.owner !== 'string' || !pause.owner || grant.owner !== pause.owner) fail('Only the pause holder may authorize a deploy-fix exception');
  let ruling;
  try { ruling = JSON.parse(pause.history?.findLast(stamp => stamp.action === 'claimed')?.note); } catch { fail('Pause needs its recorded owner directive'); }
  if (ruling?.kind !== 'room.release-pause.v1' || grant.purpose !== 'deploy-fix' || grant.directiveMessageId !== ruling.directiveMessageId) fail('Main is paused; only an exact deploy-fix grant under the current owner ruling may land');
}
export function claimsFromPages(pages) {
  if (pages.some(page => page?.hasMore !== false || !Array.isArray(page.claims))) fail('Incomplete claim pagination; no collision verdict is safe');
  return pages.flatMap(page => page.claims);
}
// All writes pass through this adapter so a durable journal records exact input
// BEFORE each uncertain GitHub call. No shell interpolation or secret logging.
export async function guardedMerge(candidate, io) {
  const inspect = async () => {
    const view = await io.inspect();
    candidateReady(candidate, view.pr, view.main, view.protection);
    const grant = grantOf(view.slot, view.identity, candidate);
    problemKeyCheck(grant, view.claims);
    pauseCheck(view.pause, grant);
    if (view.openAuthorizations?.some(pr => pr.headRefOid !== candidate.head)) fail('Another open head has an unreconciled landing status; revoke it first');
    return { grant, slot: view.slot };
  };
  const first = await inspect();
  let authorized = false;
  try {
    authorized = true; // revoke even if the status response is lost
    await io.status({ state: 'success', context: CONTEXT, description: 'Exact candidate authorized by the current Room landing lease' });
    const last = await inspect();
    if (last.grant.claimedAt !== first.grant.claimedAt) fail('MERGE-SLOT generation changed after status publication');
    return await io.merge({ sha: candidate.head, merge_method: 'merge' });
  } finally {
    if (authorized) await io.status({ state: 'failure', context: CONTEXT, description: 'Landing authorization consumed or revoked; obtain a fresh Room lease' });
  }
}
// Keep each GraphQL response bounded: a repository-wide rollup expansion can
// time out before the gate starts. Every outer page and inner context list must
// be complete; an API error or truncated list never becomes permission.
export function openAuthorizations(readPage) {
  const approved = [], seen = new Set();
  let after = null;
  do {
    const page = readPage(after);
    if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') fail('Incomplete open PR page');
    for (const pr of page.nodes) {
      const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      if (!pr.headRefOid || !Number.isSafeInteger(pr.number) || !Array.isArray(pr.commits?.nodes) || pr.commits.nodes.length !== 1) fail('Incomplete open PR head');
      if (rollup === null) continue;
      const contexts = rollup?.contexts;
      if (!Array.isArray(contexts?.nodes) || contexts.pageInfo?.hasNextPage !== false) fail('Incomplete open PR check contexts');
      if (contexts.nodes.some(check => (check.name ?? check.context) === CONTEXT && ['success', 'SUCCESS'].includes(check.conclusion ?? check.state))) approved.push({ number: pr.number, headRefOid: pr.headRefOid });
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
    if (!after || seen.has(after)) fail('Open PR pagination did not advance');
    seen.add(after);
  } while (true);
  return approved;
}
const OPEN_PR_QUERY = `query($after:String) { repository(owner:"Uuriko",name:"project-room") {
  pullRequests(first:20,after:$after,states:OPEN) { pageInfo { hasNextPage endCursor }
    nodes { number headRefOid commits(last:1) { nodes { commit { statusCheckRollup {
      contexts(first:100) { pageInfo { hasNextPage } nodes {
        ... on StatusContext { context state } ... on CheckRun { name conclusion }
      } }
    } } } } }
  }
} }`;
const gh = (args, input) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] }) || 'null');
async function main() {
  const [action, ...args] = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const apply = args.includes('--apply');
  const repo = flag('--repo') ?? 'Uuriko/project-room';
  if (repo !== 'Uuriko/project-room') fail('This landing gate is scoped to Uuriko/project-room');
  if (!['install', 'merge', 'revoke'].includes(action)) fail('Usage: release-merge-gate.mjs install|merge|revoke [--apply] --state JOURNAL [--pr N --head SHA --base SHA --connection FILE]');
  const file = flag('--state');
  if (!file) fail('Choose a non-secret journal path outside the checkout');
  const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (prior?.writes?.length && action !== 'revoke') fail('Existing mutation journal requires reconciliation/revocation; use a fresh journal only after resolving it');
  let journal = action === 'revoke' && prior ? prior : { repo, action, phase: 'planned', writes: [] };
  const save = () => writeFileSync(file, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
  const write = (path, input, method = 'POST') => {
    journal.writes.push({ method, path, input, phase: 'unknown' }); save();
    const result = gh(['api', '--method', method, path, '--input', '-'], input);
    journal.writes.at(-1).phase = 'received'; journal.writes.at(-1).result = result; save(); return result;
  };
  if (action === 'install') {
    const path = `repos/${repo}/branches/main/protection/required_status_checks`;
    const full = gh(['api', `repos/${repo}/branches/main/protection`]);
    if (full.enforce_admins?.enabled !== true) fail('Administrator enforcement must remain enabled');
    const before = full.required_status_checks; const plan = protectionPlan(before);
    journal = { ...journal, before, plan }; save();
    if (apply) {
      // Change ONLY required checks; preserve strictness, app bindings, admin
      // enforcement, review requirements, bypass lists and other protections.
      write(path, plan, 'PATCH');
      const fullAfter = gh(['api', `repos/${repo}/branches/main/protection`]);
      if (fullAfter.enforce_admins?.enabled !== true) fail('Administrator enforcement changed during installation');
      const after = fullAfter.required_status_checks;
      if (!after.checks.some(check => check.context === CONTEXT) || after.strict !== before.strict ||
          before.checks.some(check => !after.checks.some(next => next.context === check.context && next.app_id === check.app_id))) fail('Protection read-back differs from planned additive restriction');
      journal.after = after; journal.phase = 'installed'; save();
    }
    console.log(JSON.stringify({ action, applied: apply, plan })); return;
  }
  const candidate = { repo, pr: Number(flag('--pr')), head: flag('--head'), base: flag('--base') };
  if (!SHA.test(candidate.head ?? '') || !SHA.test(candidate.base ?? '') || !Number.isSafeInteger(candidate.pr) || candidate.pr < 1) fail('Exact candidate required');
  if (action === 'revoke') {
    const input = { state: 'failure', context: CONTEXT, description: 'Landing authorization revoked by coordinator' };
    if (prior?.candidate && JSON.stringify(prior.candidate) !== JSON.stringify(candidate)) fail('Revoke must bind the candidate in the existing journal');
    journal.candidate = candidate; save();
    if (apply) write(`repos/${repo}/statuses/${candidate.head}`, input);
    console.log(JSON.stringify({ action, applied: apply, candidate })); return;
  }
  const connection = flag('--connection');
  if (!connection) fail('Use the existing Room connection; do not create a new identity');
  const { readAgentConnection } = await import('../client/agent-connection.mjs');
  const { RoomAgentClient } = await import('../client/room-agent.mjs');
  const room = new RoomAgentClient({ ...readAgentConnection(connection), roomId: 'muse-room' });
  const inspect = async () => {
    const access = await room.checkConnection();
    const slot = await room.workClaimGet('MERGE-SLOT');
    const pause = await room.workClaimGet('RELEASE-PAUSE');
    const pages = await Promise.all(['claimed', 'in_progress', 'blocked'].map(state => room.workClaims({ state })));
    const claims = claimsFromPages(pages);
    const fullProtection = gh(['api', `repos/${repo}/branches/main/protection`]);
    return { identity: access.memberId, slot, pause,
      openAuthorizations: openAuthorizations(after => gh(['api', 'graphql', '--input', '-'], { query: OPEN_PR_QUERY, variables: { after } }).data?.repository?.pullRequests),
      claims,
      pr: gh(['pr', 'view', String(candidate.pr), '--repo', repo, '--json', 'state,isDraft,headRefOid,baseRefName,mergeable,statusCheckRollup']),
      main: gh(['api', `repos/${repo}/commits/main`]).sha,
      protection: { ...fullProtection.required_status_checks, enforceAdmins: fullProtection.enforce_admins?.enabled === true } };
  };
  const before = await inspect();
  if (before.openAuthorizations.length) {
    console.error(JSON.stringify({ outstandingAuthorizations: before.openAuthorizations.map(pr => ({ pr: pr.number, head: pr.headRefOid, revoke: `node scripts/release-merge-gate.mjs revoke --pr ${pr.number} --head ${pr.headRefOid} --base ${before.main} --state NEW_JOURNAL --apply` })) }));
    if (before.openAuthorizations.some(pr => pr.headRefOid !== candidate.head)) fail('Another open head has an unreconciled landing status; revoke it first');
  }
  candidateReady(candidate, before.pr, before.main, before.protection);
  const grant = grantOf(before.slot, before.identity, candidate); problemKeyCheck(grant, before.claims); pauseCheck(before.pause, grant);
  journal = { ...journal, candidate, grant }; save();
  if (apply) {
    const result = await guardedMerge(candidate, { inspect,
      status: input => write(`repos/${repo}/statuses/${candidate.head}`, input),
      merge: input => write(`repos/${repo}/pulls/${candidate.pr}/merge`, input, 'PUT') });
    if (!result?.merged) fail('GitHub did not confirm the merge');
    journal.result = result; journal.phase = 'merged-and-revoked'; save();
  }
  console.log(JSON.stringify({ action, applied: apply, candidate, phase: journal.phase }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
