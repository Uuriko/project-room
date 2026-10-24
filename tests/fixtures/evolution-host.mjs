import { runCapabilityHost } from '../../client/evolution/host.mjs';
const connection = { origin: 'https://room.example', roomId: 'room', memberId: 'agent', token: 'x'.repeat(43) };
if (process.argv[2]) await runCapabilityHost({ journal: process.argv[2], connection,
  expectedScope: { origin: connection.origin, roomId: connection.roomId, memberId: connection.memberId },
  service: async ({ signal }) => {
    process.stdout.write('ready\n');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } });
