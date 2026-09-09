// Operator-started, loopback-only fixture for real agent participation.
// Seeds are explicitly synthetic; it never creates a participating agent's answer or verdict.
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { seedWorkContextExercise } from './work-context-agent-seed.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const listen = (server, protocol = 'http') => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`${protocol}://127.0.0.1:${server.address().port}`));
});
const mode = process.argv[2];
if (mode === 'publish') {
  const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  if (config.fixture !== 'project-room-real-agent-v1' || config.memberId !== 'producer') throw new Error('Producer fixture configuration required');
  const url = new URL(config.artifactOrigin);
  if (url.origin !== config.artifactOrigin || url.hostname !== '127.0.0.1' || url.protocol !== 'https:') throw new Error('HTTPS loopback artifact origin required');
  const bytes = readFileSync(resolve(process.argv[4]));
  if (!bytes.length || bytes.length > 64000) throw new Error('Use a nonempty Markdown artifact under 64 KB');
  const hash = digest(bytes), path = join(config.artifactDirectory, `${hash}.md`);
  if (existsSync(path)) {
    if (digest(readFileSync(path)) !== hash) throw new Error('Existing artifact bytes disagree');
  } else writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); // Publish the exact bytes that were hashed.
  console.log(JSON.stringify({ evidenceUrl: `${url.origin}/${hash}.md`, evidenceVersion: `sha256:${hash}`, bytes: bytes.length }));
} else if (mode === 'serve' || mode === 'serve-context') {
  const contextExercise = mode === 'serve-context';
  process.umask(0o077);
  const directory = mkdtempSync(join(tmpdir(), 'project-room-real-agent-'));
  const artifactDirectory = join(directory, 'artifacts'); mkdirSync(artifactDirectory);
  const artifactCaFile = join(directory, 'artifact-cert.pem'), artifactKeyFile = join(directory, 'artifact-key.pem');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', artifactKeyFile,
    '-out', artifactCaFile, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const seed = initialRoom();
  seed[0].data.title = contextExercise ? 'Selected task — Agent Test' : 'Dasha Compute — Agent Test';
  seed[0].data.purpose = 'Actual agents, synthetic accounts, one bounded development task. No paid inference or external actions.';
  seed[1].data.displayName = 'Test operator (not John)';
  store.initialize(seed);
  const keys = { owner: store.issueAccessKey('commons', 'owner') };
  const command = (type, data) => store.command(keys.owner, 'commons', { id: randomUUID(), type, data });
  for (const [memberId, permissions] of [['producer', ['accept_work', 'complete_work', ...(contextExercise ? ['write_external'] : [])]], ['reviewer', ['verify']]]) {
    command(T.MEMBER_ADDED, { memberId, displayName: `Codex ${memberId}`, kind: 'agent', permissions, accountableHumanId: 'owner' });
    keys[memberId] = store.issueAccessKey('commons', memberId);
  }
  if (!contextExercise) {
  command(T.MESSAGE_POSTED, { messageId: 'bridge-research-task', body: 'Produce an original acceptance matrix for a future Dasha Compute tool in Project Room. Read docs/DARKBLOOM-COMPUTE-ROOM-2026-09-07.md. Cover selected context and permission, duplicate submission, unknown outcome, cancellation acknowledgment, exact output review, and unknown usage/cost. For each case state expected behavior and observable evidence. Clearly distinguish current implementation from proposals. Recommend one small next implementation slice. Do not call Compute, publish externally, install software or modify Dasha. This is real agent analysis in an isolated test, not a real inference job.' });
  command(T.WORK_PROPOSED, { workItemId: 'dasha-bridge-acceptance', title: 'Dasha bridge acceptance matrix', definitionOfDone: 'Six traceable acceptance cases, current/proposed boundary, one practical next slice; original Markdown artifact under 900 words, resolvable exact content hash, independently reviewed. No invented inference, billing or human approval.', accountableMemberId: 'producer', verifierMemberId: 'reviewer', independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: 'owner', sourceMessageId: 'bridge-research-task', mode: 'read' });
  }
  const artifacts = createServer({ key: readFileSync(artifactKeyFile), cert: readFileSync(artifactCaFile) }, (request, response) => {
    const match = request.method === 'GET' && /^\/([a-f0-9]{64})\.md$/.exec(request.url);
    if (!match) { response.writeHead(404); response.end(); return; }
    const filename = join(artifactDirectory, `${match[1]}.md`);
    if (!existsSync(filename)) { response.writeHead(404); response.end(); return; }
    const bytes = readFileSync(filename);
    if (digest(bytes) !== match[1]) { response.writeHead(409); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    response.end(bytes);
  });
  const room = createRoomServer({ store });
  const artifactOrigin = await listen(artifacts, 'https'), origin = await listen(room);
  const workItemId = contextExercise ? seedWorkContextExercise({ store, keys, artifactOrigin, artifactDirectory }) : 'dasha-bridge-acceptance';
  const configs = {};
  for (const memberId of ['owner', 'producer', 'reviewer']) {
    const filename = join(directory, `${memberId}.json`);
    writeFileSync(filename, JSON.stringify({ fixture: 'project-room-real-agent-v1', origin, roomId: 'commons', memberId, token: keys[memberId], artifactOrigin, artifactDirectory, artifactCaFile, workItemId }), { mode: 0o600, flag: 'wx' });
    configs[memberId] = filename;
  }
  console.log(JSON.stringify({ directory, origin, artifactOrigin, configs, note: 'Temporary credentials are private; only paths are printed. Database and non-sensitive artifacts retained after stop.' }));
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    room.closeStreams(); room.closeAllConnections(); artifacts.closeAllConnections();
    await Promise.all([room, artifacts].map(server => new Promise(resolve => server.close(resolve))));
    store.close();
    for (const filename of Object.values(configs)) if (existsSync(filename)) unlinkSync(filename);
    if (existsSync(artifactKeyFile)) unlinkSync(artifactKeyFile);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} else throw new Error('Use serve, serve-context, or publish PRODUCER-CONFIG ARTIFACT.md');
