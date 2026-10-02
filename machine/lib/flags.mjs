// The machine feature stays inert unless the operator turns this on.
// Room's server does not read the flag. A Mac with the flag unset does not
// enroll, open a relay socket, or start a guest.
export function machineEnabled(env = process.env) {
  return env.ROOM_MACHINE_ENABLED === "1";
}

export const DAEMON_VERSION = "0.1.0";
