// A POSIX-only launcher. The group belongs to this process, and closing its
// parent IPC channel ends the launch even after an abrupt receiver exit.
import { spawn } from 'node:child_process';

const killGroup = () => process.kill(-process.pid, 'SIGKILL');
if (!process.connected) process.exit(1);
process.once('disconnect', killGroup);
// The ACP child receives SIGTERM from the same group. Keep the group leader
// alive until the child exits or the receiver's shutdown deadline fires.
process.on('SIGTERM', () => {});

const reportExit = info => {
  if (process.connected) process.send(info, killGroup);
  else killGroup();
};
const [command, ...args] = process.argv.slice(2);
const adapter = spawn(command, args, { stdio: 'inherit' });
adapter.once('error', error => reportExit({ code: null, signal: null, error: error.code ?? 'spawn_failed' }));
adapter.once('exit', (code, signal) => reportExit({ code, signal }));
