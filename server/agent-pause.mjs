// Active pause for one member. Command admission asks isPaused before a
// non-human write. Reads and POST /agent-pause resume never reach it.
export function createAgentPause(wakeQueue) {
  return {
    isPaused(roomId, memberId) {
      return Boolean(wakeQueue?.pauseStatus?.(roomId, memberId));
    },
  };
}
