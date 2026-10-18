// Production mutation requires both Actions concurrency and the existing Room
// ROLE-DEPLOYER claim. Never sweep, steal, renew, or release a peer's claim.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function leaseClient({ origin, token, room = 'muse-room', fetchImpl = fetch }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || !token) throw new Error('HTTPS Room origin and ROOM_RECEIPT_TOKEN required');
  const base = `${url.href.replace(/\/$/, '')}/api/rooms/${encodeURIComponent(room)}/work-claims/ROLE-DEPLOYER`;
  return async (action = '', body) => {
    const response = await fetchImpl(base + action, {
      method: body ? 'POST' : 'GET', redirect: 'error', credentials: 'omit',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Room deploy lease refused: HTTP ${response.status}`);
    return response.json();
  };
}
const noteOf = item => item.history?.findLast(stamp => stamp.action === 'claimed')?.note;
const historyLength = item => item.historyLength ?? ((item.history?.length ?? 0) + (item.historyOmitted ?? 0));
export function assertLease(item, state, now = Date.now()) {
  if (item.state !== 'claimed' || item.owner !== state.owner || item.claimedAt !== state.claimedAt ||
      noteOf(item) !== state.note || !(Date.parse(item.leaseExpiresAt) > now)) {
    throw new Error('Production lease changed, expired, or belongs to another run');
  }
  return item;
}
export async function acquireLease(request, { sha, runId, attempt }, save) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new Error('Exact SHA, run ID and attempt required');
  const note = `deploy-prod:${runId}:${attempt}:${sha}`;
  const input = { note, leaseHours: 2 };
  // Persist exact unknown-write input before sending. If the response is lost,
  // the same run can recover only the claim stamped with this exact note.
  save({ phase: 'acquiring', sha, runId, attempt, note, input });
  let item = await request();
  if (item.state === 'unclaimed') {
    try { await request('/claim', input); }
    catch (error) {
      item = await request();
      if (noteOf(item) !== note) throw error;
    }
    item = await request();
  }
  if (noteOf(item) !== note) throw new Error('ROLE-DEPLOYER already held; no upload authorized');
  const state = { phase: 'held', sha, runId, attempt, note, input, owner: item.owner, claimedAt: item.claimedAt };
  assertLease(item, state);
  save(state);
  return state;
}
export async function releaseLease(request, state, save) {
  const current = await request();
  if (current.state === 'unclaimed' && current.history?.at(-1)?.note === `${state.note}:verified-finish`) {
    save({ ...state, phase: 'released' });
    return;
  }
  const item = assertLease(current, state);
  const input = state.releaseInput ?? { expectedClaimedAt: item.claimedAt, expectedHistoryLength: historyLength(item), note: `${state.note}:verified-finish` };
  save({ ...state, phase: 'releasing', releaseInput: input });
  await request('/release', input);
  const released = await request();
  if (released.state !== 'unclaimed') throw new Error('Lease release was not confirmed');
  save({ ...state, phase: 'released', releaseInput: input });
}
async function main() {
  const [action, file] = process.argv.slice(2);
  if (!file || !['acquire', 'assert', 'release'].includes(action)) throw new Error('Usage: deploy-room-lease.mjs acquire|assert|release STATE_FILE');
  const e = process.env;
  const request = leaseClient({ origin: e.PROD_ORIGIN, token: e.ROOM_RECEIPT_TOKEN, room: e.RECEIPT_ROOM });
  const save = state => writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  if (action === 'acquire') await acquireLease(request, { sha: e.SHA, runId: e.GITHUB_RUN_ID, attempt: e.GITHUB_RUN_ATTEMPT }, save);
  else {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state.sha !== e.SHA || state.runId !== e.GITHUB_RUN_ID || state.attempt !== e.GITHUB_RUN_ATTEMPT) throw new Error('Lease file does not match this run');
    if (action === 'assert') assertLease(await request(), state);
    else await releaseLease(request, state, save);
  }
  console.log(`Room deploy lease ${action}: verified`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
