import { pathToFileURL } from 'node:url';
import { agentConnectionFromEnvironment } from '../client/agent-connection.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { roomEventPointer } from '../client/claude-channel.mjs';
import { queueRoomPointer, validateQueueBinding } from '../client/codex-queue.mjs';

// Foreground qualification entry, not a service installer or polling schedule.
export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 6 || argv[0] !== '--thread' || argv[2] !== '--journal' || argv[4] !== '--host') throw new Error('usage_error');
  const connection = agentConnectionFromEnvironment();
  const binding = { origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId, threadId: argv[1] };
  validateQueueBinding(binding);
  const wake = new AgentWakeClient({ connection });
  const page = await wake.wait({ hostId: argv[5], cadenceSeconds: 60, waitMs: 0 });
  if (page.status === 'listener_contended') { console.log(JSON.stringify({ status: 'listener_contended' })); return; }
  for (const signal of page.pendingWakes) {
    const pointer = roomEventPointer(signal, connection.roomId);
    if (!pointer) continue;
    const receipt = await queueRoomPointer({ binding, pointer, journal: argv[3], authorize: async () => {
      // Every candidate gets a fresh fenced page; duplicate receipts must not
      // make a later dispatch rely on the first page’s expired listener lease.
      const current = await wake.wait({ hostId: argv[5], cadenceSeconds: 60, waitMs: 0 });
      return current.status !== 'listener_contended' && current.pendingWakes.some(row =>
        JSON.stringify(roomEventPointer(row, connection.roomId)) === JSON.stringify(pointer));
    } });
    console.log(JSON.stringify({ signalId: pointer.signalId, ...receipt }));
    // Acceptance is not handling: leave the wake pending, but allow later
    // invocations to reach subsequent signals. Never repeat an uncertain send.
    if (!receipt.duplicate || receipt.status === 'unknown') break;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error(JSON.stringify({ status: 'not_confirmed', action: 'inspect_binding_access_and_journal' })); process.exitCode = 1; });
}
