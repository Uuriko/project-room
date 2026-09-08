// Disposable loopback room for independent agents, not an agent runner. The
// operator creates assignments only; participants supply their own work.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { EVENT_TYPES as T } from '../src/events.js';

export async function startAssistedAgentExercise() {
  const directory = mkdtempSync(join(tmpdir(), 'project-room-assisted-agents-'));
  chmodSync(directory, 0o700);
  let store, server, closing;
  const close = () => closing ??= (async () => {
    try {
      if (server) {
        server.closeStreams();
        server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve));
      }
    } finally {
      try { store?.close(); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    }
  })();
  try {
    store = new RoomStore(join(directory, 'room.sqlite'));
    const seed = initialRoom();
    seed[0].data.title = 'Scoped handoff — local agent exercise';
    seed[0].data.purpose = 'Independent agent participation in fictional work. No repository writes, external actions, payments or automatic approval.';
    seed[1].data.displayName = 'Local test operator (not John)';
    store.initialize(seed);
    const ownerToken = store.issueAccessKey('commons', 'owner'); // Memory only.
    const command = (type, data) => store.command(ownerToken, 'commons', { id: randomUUID(), type, data });
    const scope = { repository: 'fictional/agent-handoff', ref: 'shared-draft', paths: ['notes/handoff.md'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
    const participants = ['agent-a', 'agent-b'].map(memberId => ({ memberId, workItemId: `work-${memberId}` }));
    command(T.MESSAGE_POSTED, { messageId: 'exercise-brief', body: [
      'Local scope handoff exercise. The repository, ref and file are fictional; do not touch a real repository or follow external evidence links.',
      'Accept your assigned work, coordinate one shared reservation, and record start only while you hold it.',
      'Write your own concise handoff note in a work-linked Room message. Release the scope when done; a rejected claimant may retry its unchanged command.',
      'A late note is a proposal, not an accepted result or permission to restart. Neither participant may manufacture human approval.',
      'Both credentials are room-scoped memberships, not assignment-private grants. Scope checks coordinate Room records only; they cannot stop external processes.',
      `Shared scope: ${scope.repository}, ref ${scope.ref}, path ${scope.paths[0]}.`
    ].join('\n') });
    for (const participant of participants) {
      command(T.MEMBER_ADDED, { memberId: participant.memberId, displayName: participant.memberId,
        kind: 'agent', accountableHumanId: 'owner', permissions: ['accept_work', 'complete_work', 'write_external'] });
      participant.token = store.issueAccessKey('commons', participant.memberId);
      command(T.WORK_PROPOSED, { workItemId: participant.workItemId, title: `Handoff note — ${participant.memberId}`,
        definitionOfDone: 'An original concise work-linked note, truthful scope/retry handoff, and no invented external execution or human approval.',
        accountableMemberId: participant.memberId, mode: 'write', sourceMessageId: 'exercise-brief',
        independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: 'owner' });
    }
    server = createRoomServer({ store });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const credentialFiles = {};
    for (const participant of participants) {
      const path = join(directory, `${participant.memberId}.json`);
      writeFileSync(path, JSON.stringify({ fixture: 'project-room-assisted-agents-v1', origin, roomId: 'commons',
        ...participant, scope, authorityBoundary: 'Room membership; no assignment-private access or external execution grant.' }),
      { mode: 0o600, flag: 'wx' });
      credentialFiles[participant.memberId] = path;
    }
    return { origin, credentialFiles, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('Run this fixture without arguments. Stop it to remove its temporary room and credentials.');
  const fixture = await startAssistedAgentExercise();
  const stop = () => { void fixture.close().catch(() => { console.error('Local fixture cleanup failed.'); process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(JSON.stringify({ origin: fixture.origin, credentialFiles: fixture.credentialFiles }));
}
