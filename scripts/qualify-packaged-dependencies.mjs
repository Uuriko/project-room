#!/usr/bin/env node
// Dependency-aware continuation, exercised through a packaged runtime's real
// HTTP/MCP entry (`node server.mjs` in the package directory) on disposable
// data. Nothing here imports a helper to assert on it: the package's own store
// module only seeds members, then every observation goes over the socket.
//
//   node scripts/qualify-packaged-dependencies.mjs PACKAGE_DIR EXACT_COMMIT [--out FILE] [--keep-logs FILE]
//        [--origin https://HOST] [--pin FILE --card FILE]   (optional: mirror an installation's public origin and signed card)
//
// Never point this at an installed production data directory: it creates its
// own temporary database and removes it. Credentials are generated per run and
// withheld from every output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { request as httpRequest } from 'node:http';

process.umask(0o077);
const [runtimeArg, source, ...flags] = process.argv.slice(2);
const flag = name => { const at = flags.indexOf(name); return at < 0 ? null : flags[at + 1]; };
if (!runtimeArg || !/^[0-9a-f]{40}$/.test(source ?? '')) {
  console.error('Usage: qualify-packaged-dependencies.mjs PACKAGE_DIR EXACT_COMMIT [--out FILE] [--keep-logs FILE]'); process.exit(2);
}
const runtime = path.resolve(runtimeArg);
const { RoomStore } = await import(path.join(runtime, 'server/store.mjs'));
const { initialRoom } = await import(path.join(runtime, 'server/bootstrap.mjs'));
const { setTier } = await import(path.join(runtime, 'server/autonomy-tiers.mjs'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ALL = ['steer', 'decide', 'manage_members', 'manage_claims', 'accept_work', 'complete_work', 'verify', 'write_external', 'invite_member'];
const secrets = [];
let logs = '';

async function qualify(representation) {
  const report = { representation, checks: [], observations: {} };
  const check = (ok, label, detail) => { if (!ok) throw new Error(label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 600))); report.checks.push(label); };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'room-packaged-dependencies-'));
  const database = path.join(directory, 'room.sqlite');
  let child, childDone;
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const base = 'http://127.0.0.1:' + port, origin = flag('--origin') ?? 'https://room-qualification.invalid';
  // The packaged server runs in production mode behind a declared HTTPS origin,
  // as installed; requests arrive over loopback with the proxy's headers.
  const request = (route, token, body) => new Promise((resolve, reject) => {
    const outgoing = httpRequest(base + route, { method: body === undefined ? 'GET' : 'POST', headers: {
      Host: new URL(origin).host, 'X-Real-IP': '127.0.0.1', 'X-Forwarded-Proto': 'https',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks); let json; try { json = JSON.parse(text.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, json, bytes: text.length }); });
    });
    outgoing.on('error', reject); outgoing.setTimeout(15000, () => outgoing.destroy(new Error('fixture-request-timeout')));
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // Production boot requires a signed instance card. Unless the operator supplies
  // an installation's public pin and card, sign one with a key that exists only
  // in this process: the seed goes to the package's own signer on stdin and is never written.
  let pinPath = flag('--pin') ? path.resolve(flag('--pin')) : null, cardPath = flag('--card') ? path.resolve(flag('--card')) : null;
  if (!pinPath || !cardPath) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const b64 = value => Buffer.from(value, 'base64url').toString('base64');
    pinPath = path.join(directory, 'pin.json'); cardPath = path.join(directory, 'card.json');
    fs.writeFileSync(pinPath, JSON.stringify({ origin, keyId: 'instance-ed25519-v1', agentId: 'disposable-qualification-instance', publicKey: b64(publicKey.export({ format: 'jwk' }).x) }), { mode: 0o600 });
    const signed = spawnSync(process.execPath, [path.join(runtime, 'scripts/sign-instance-card.mjs'), pinPath, cardPath], { cwd: runtime, input: b64(privateKey.export({ format: 'jwk' }).d), encoding: 'utf8' });
    if (signed.status !== 0) throw new Error('disposable-card-signing-failed');
  }
  const start = async () => {
    child = spawn(process.execPath, ['server.mjs'], { cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), ROOM_DB: database,
        ROOM_ORIGIN: origin, ROOM_DEPLOYMENT: 'invite-only', ROOM_MCP_OAUTH_LOOPBACK: '1', ROOM_GROWTH_ENABLED: '0', ROOM_CHANNEL_DRAIN_ENABLED: '0',
        ROOM_INSTANCE_CARD_PIN_PATH: pinPath, ROOM_INSTANCE_CARD_PATH: cardPath } });
    child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
    childDone = once(child, 'exit');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { if ((await request('/api/ready')).status === 200) break; } catch { /* booting */ }
      if (child.exitCode !== null) throw new Error('packaged-boot-exited');
      await pause(50);
    }
    check((await request('/api/ready')).json?.status === 'ready', 'packaged-entry-ready');
    check((await request('/api/version')).json?.sourceRevision === source, 'exact-stamped-source');
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const exit = await Promise.race([childDone, pause(8000).then(() => null)]);
    if (!exit) { child.kill('SIGKILL'); await childDone; throw new Error('packaged-stop-timeout'); }
    check(exit[0] === 0, 'packaged-process-clean-exit');
  };
  let owner, operation = 0;
  const command = (token, type, data) => request('/api/rooms/commons/commands', token, { id: `qualify-${representation}-${++operation}`, type, data });
  const ownerCommand = async (type, data) => { const result = await command(owner, type, data); if (result.status !== 201) throw new Error(`owner-command-${type}-${result.status}-${result.json?.error?.code ?? ''}`); return result.json; };
  const raw = (actor, name, args = {}) => request('/mcp', actor.secret, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { roomId: 'commons', ...args } } });
  const rpc = async (actor, name, args) => {
    const result = await raw(actor, name, args);
    if (result.status !== 200 || result.json?.error || result.json?.result?.isError) throw new Error(`rpc-${name}-${JSON.stringify(result.json?.error ?? result.json?.result?.structuredContent ?? result.status).slice(0, 300)}`);
    return result.json.result.structuredContent;
  };
  const refused = async (actor, name, args) => { const result = await raw(actor, name, args); return result.status !== 200 || Boolean(result.json?.error) || result.json?.result?.isError === true; };
  const brief = (actor, workItemId, extra = {}) => rpc(actor, 'room_read_work', { workItemId, brief: true, ...extra });
  const row = (state, id) => [...state.needsYou, ...state.inProgress, ...state.blocked].find(entry => entry.id === id);
  try {
    const say = console.log; console.log = () => {};
    let store;
    try { store = new RoomStore(database); store.initialize(initialRoom(), representation === 'legacy' ? {} : { representation }); } finally { console.log = say; }
    owner = store.issueAccessKey('commons', 'owner'); secrets.push(owner);
    const member = (name, permissions) => {
      const identity = store.identities.create(name); secrets.push(identity.secret);
      const { linkCode } = store.identities.mintLinkCode(identity.identityId, identity.secret, { roomId: 'commons' }); secrets.push(linkCode);
      store.identities.link(owner, 'commons', { identityId: identity.identityId, identityLinkCode: linkCode, displayName: name, permissions });
      setTier(store.db, 'commons', identity.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
      return identity;
    };
    const producer = member('Fixture producer', ['accept_work', 'complete_work']);
    const reviewer = member('Fixture reviewer', ['verify']);
    const admin = member('Fixture co-owner agent', ALL);
    store.close(); store = null;
    await start();
    const propose = (workItemId, extra = {}) => ownerCommand('work.proposed', { workItemId, title: workItemId, definitionOfDone: 'Record one exact synthetic result',
      accountableMemberId: producer.identityId, mode: 'read', ...extra });
    const submit = async (actor, workItemId) => {
      await rpc(actor, 'room_post_message', { id: 'result-' + workItemId, workItemId, body: `Synthetic result for ${workItemId}; no external execution claimed.` });
      const preview = await rpc(actor, 'room_read_result', { workItemId, draftMessageId: 'result-' + workItemId });
      const text = preview.result.text;
      await rpc(actor, 'room_submit_text_result', { workItemId, requestId: 'completion-' + workItemId, summary: 'Synthetic fixture result', nextAction: 'Inspect exact result',
        producerId: actor.identityId, evidenceMessageId: text.messageId, evidenceMessageEventId: text.messageEventId,
        evidenceVersion: text.evidenceVersion, previousCompletionEventId: preview.current.completionEventId });
      return text;
    };

    // Prerequisite first: on legacy storage a dependency names the prerequisite's Board card,
    // which exists once the prerequisite has been accepted.
    await propose('base', { verifierMemberId: reviewer.identityId, independentVerificationRequired: true });
    const begunBase = await rpc(producer, 'room_begin_work', { workItemId: 'base' });
    check(begunBase.working === true, 'prerequisite-started-through-default-catalog', begunBase);
    await propose('child', { dependsOn: ['base'] });
    await propose('plain');

    // A + B. Unfinished prerequisite: prose, structured hint, begin, project state and admission agree.
    const proposed = await brief(producer, 'child');
    check(/Do not claim or start/.test(proposed.brief), 'brief-prose-warns-unfinished');
    check(proposed.continuation.action === 'accept' && proposed.continuation.tool === 'room_begin_work'
      && Array.isArray(proposed.continuation.waitingOn) && proposed.continuation.waitingOn[0]?.id === 'base'
      && /^Accepts the assignment only/.test(proposed.continuation.guidance), 'accept-hint-names-prerequisite-and-says-accept-only', proposed.continuation);
    const accepted = await rpc(producer, 'room_begin_work', { workItemId: 'child' });
    check(accepted.confirmed.length === 1 && accepted.confirmed[0].action === 'room_accept_work' && accepted.stopped === 'waiting_on_prerequisites'
      && accepted.refusal === undefined && accepted.waitingOn?.[0]?.id === 'base', 'begin-accepts-then-stops-before-start', accepted);
    const waiting = await brief(producer, 'child');
    check(waiting.continuation.action === 'start' && waiting.continuation.tool === null && waiting.continuation.waitingOn?.[0]?.id === 'base'
      && /Do not claim or start/.test(waiting.brief), 'start-hint-withheld-and-agrees-with-prose', waiting.continuation);
    let state = await rpc(producer, 'room_project_state');
    check(state.work.complete === true && !state.needsYou.some(entry => entry.id === 'child') && row(state, 'child')?.next === 'wait_prerequisites'
      && row(state, 'child').waitingOn?.[0]?.id === 'base', 'project-state-waits-and-is-not-actionable', row(state, 'child'));
    const childRevision = (await rpc(producer, 'room_read_work', { workItemId: 'child' })).work.revision;
    const blockedStart = await command(producer.secret, 'work.started', { workItemId: 'child', expectedRevision: childRevision });
    check(blockedStart.status === 409 && blockedStart.json?.error?.code === 'work_claim_dependencies_unmet', 'admission-refuses-start-while-unfinished', { status: blockedStart.status, code: blockedStart.json?.error?.code });
    const plain = await brief(producer, 'plain');
    check(plain.continuation.tool === 'room_begin_work' && !Object.hasOwn(plain.continuation, 'waitingOn') && !Object.hasOwn(row(state, 'plain') ?? {}, 'waitingOn'),
      'no-prerequisite-task-unchanged', plain.continuation);
    report.observations.waiting = { continuation: waiting.continuation, projectStateRow: row(state, 'child'), begin: { confirmed: accepted.confirmed.map(stage => stage.action), stopped: accepted.stopped, waitingOn: accepted.waitingOn } };

    // C. Submitted but not reviewed: still waiting; unchanged facts keep the retained brief.
    const text = await submit(producer, 'base');
    const submitted = await brief(producer, 'child');
    check(submitted.continuation.tool === null && submitted.continuation.waitingOn?.[0]?.id === 'base', 'submitted-prerequisite-does-not-release', submitted.continuation);
    report.observations.submittedPrerequisiteState = submitted.continuation.waitingOn[0].state;
    const retained = await brief(producer, 'child', { knownBriefVersion: submitted.briefVersion });
    check(retained.briefUnchanged === true && retained.continuation.tool === null, 'unchanged-prerequisite-keeps-retained-brief-and-recomputes-hint');

    // E. Authority: neither the producer nor a co-owner agent can stand in for the named independent reviewer,
    // and a co-owner agent cannot start another member's assignment.
    const reviewRead = await rpc(reviewer, 'room_read_work', { workItemId: 'base', brief: true, includeResult: true });
    const verdict = { ...reviewRead.continuation.arguments, result: 'pass', summary: 'Synthetic exact text checked' };
    check(reviewRead.continuation.tool === 'room_record_verification' && verdict.evidenceVersion === text.evidenceVersion, 'reviewer-receives-exact-version-review-step');
    check(await refused(producer, 'room_record_verification', verdict), 'producer-cannot-review-own-result');
    check(await refused(admin, 'room_record_verification', verdict), 'co-owner-agent-cannot-record-the-named-reviewers-verdict');
    const adminStart = await command(admin.secret, 'work.started', { workItemId: 'child', expectedRevision: childRevision });
    check(adminStart.status >= 400 && adminStart.status < 500, 'co-owner-agent-cannot-start-another-members-assignment', { status: adminStart.status, code: adminStart.json?.error?.code });
    const adminBegin = await raw(admin, 'room_begin_work', { workItemId: 'child' });
    check(adminBegin.json?.result?.structuredContent?.working !== true, 'co-owner-agent-begin-does-not-take-over');
    check((await brief(producer, 'child')).continuation.tool === null, 'refused-attempts-released-nothing');
    report.observations.authority = { adminStart: { status: adminStart.status, code: adminStart.json?.error?.code ?? null } };

    // The named reviewer passes the exact result. F: restart before the dependent is read again.
    await rpc(reviewer, 'room_record_verification', verdict);
    await stop(); await start();
    const ready = await brief(producer, 'child', { knownBriefVersion: submitted.briefVersion });
    check(ready.briefUnchanged === undefined && typeof ready.brief === 'string' && !/Do not claim or start/.test(ready.brief), 'released-prerequisite-refreshes-retained-brief-after-restart');
    check(ready.continuation.action === 'start' && ready.continuation.tool === 'room_begin_work' && !Object.hasOwn(ready.continuation, 'waitingOn'), 'start-offered-after-exact-gate-and-restart', ready.continuation);
    check(ready.revision === childRevision, 'dependent-was-not-edited-to-release-it', { before: childRevision, after: ready.revision });
    state = await rpc(producer, 'room_project_state');
    check(state.needsYou.some(entry => entry.id === 'child' && entry.next === 'start' && !Object.hasOwn(entry, 'waitingOn')), 'project-state-actionable-after-release', row(state, 'child'));
    const begun = await rpc(producer, ready.continuation.tool, ready.continuation.arguments);
    check(begun.working === true && begun.stopped === null, 'recommended-begin-reaches-working', begun);
    report.observations.released = { continuation: ready.continuation };

    // D. Bounded project-state lookups: past the budget a row is unknown, never ready.
    await propose('slow'); await rpc(producer, 'room_begin_work', { workItemId: 'slow' });
    const many = 30;
    for (let index = 0; index < many; index += 1) {
      const id = 'dep-' + String(index).padStart(2, '0');
      await propose(id, { dependsOn: ['slow'] });
      const result = await rpc(producer, 'room_begin_work', { workItemId: id });
      if (result.stopped !== 'waiting_on_prerequisites') throw new Error('bounded-fixture-begin-' + id);
    }
    const timings = [];
    let stateResponse;
    for (let sample = 0; sample < 15; sample += 1) {
      const before = performance.now();
      stateResponse = await request('/api/rooms/commons/state', producer.secret);
      timings.push(performance.now() - before);
    }
    state = stateResponse.json;
    const dependents = [...state.needsYou, ...state.inProgress].filter(entry => entry.id.startsWith('dep-'));
    check(stateResponse.status === 200 && dependents.length > 0 && dependents.every(entry => ['wait_prerequisites', 'check_prerequisites'].includes(entry.next)),
      'bounded-read-never-reports-start', dependents.map(entry => [entry.id, entry.next]));
    const unknown = state.needsYou.filter(entry => entry.id.startsWith('dep-'));
    check(unknown.length > 0 && unknown.every(entry => entry.next === 'check_prerequisites' && entry.waitingOn === 'unknown'),
      'unexamined-rows-ask-for-a-selected-read', unknown);
    const selected = await brief(producer, unknown[0].id);
    check(selected.continuation.tool === null && selected.continuation.waitingOn?.[0]?.id === 'slow', 'selected-read-resolves-an-unknown-row');
    timings.sort((a, b) => a - b);
    report.observations.boundedRead = { notStartedDependents: many, responseBytes: stateResponse.bytes, unknownRowsInNeedsYou: unknown.length,
      latencyMs: { samples: timings.length, p50: Math.round(timings[Math.floor(timings.length / 2)] * 10) / 10, max: Math.round(timings.at(-1) * 10) / 10 },
      note: 'HTTP response bytes and wall-clock latency over loopback for GET /state. Not internal read cost.' };
    check((await request('/api/rooms/commons/state')).status === 401, 'project-state-denies-anonymous');
    await stop();
    report.passed = true;
  } catch (error) { report.passed = false; report.failure = String(error?.message ?? error).slice(0, 900); }
  finally {
    try { await stop(); } catch (error) { report.passed = false; report.cleanupFailure = error.message; }
    fs.rmSync(directory, { recursive: true, force: true });
    report.disposableDataRemoved = !fs.existsSync(directory);
  }
  return report;
}

const results = { source, node: process.version, package: runtime, representations: [] };
for (const representation of ['legacy', 'normalized-current-v1']) results.representations.push(await qualify(representation));
results.passed = results.representations.every(entry => entry.passed && entry.disposableDataRemoved);
let output = JSON.stringify(results, null, 2);
for (const secret of secrets) { output = output.split(secret).join('[credential withheld]'); logs = logs.split(secret).join('[credential withheld]'); }
if (flag('--keep-logs')) fs.writeFileSync(flag('--keep-logs'), logs, { mode: 0o600 });
if (flag('--out')) fs.writeFileSync(flag('--out'), output + '\n', { mode: 0o600 });
console.log(output);
if (!results.passed) process.exitCode = 1;
