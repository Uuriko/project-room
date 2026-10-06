// Solver: the room join → claim → finish agent workflow under test.
// The solver drives the room tools and records every call in a trajectory;
// a rival claim attempt mid-lease is part of the workflow (the agent must
// hold the exclusive lease, and the room must deny the rival).

import { createFakeRoom } from './fake-room.mjs';

export async function solveJoinClaimFinish(task) {
  const room = createFakeRoom({ room: task.room ?? 'evals-lab' });
  const agent = task.agent ?? 'eval-agent-1';
  const taskId = task.taskId;
  if (!taskId) throw new Error(`task ${task.id} is missing taskId`);

  const trajectory = [];
  const call = (tool, args) => {
    const result = room[tool](args);
    trajectory.push({ tool, args, result });
    return result;
  };

  call('room.join', { agent });
  const claim = call('room.claim', { agent, taskId });
  // A rival agent attempts the same claim while our lease is held.
  call('room.claim', { agent: 'rival-agent', taskId });

  let receipt = null;
  if (claim.ok) {
    const done = call('room.finish', { agent, taskId, leaseId: claim.leaseId });
    receipt = done.receipt ?? null;
  }

  return { trajectory, finalAnswer: receipt };
}
