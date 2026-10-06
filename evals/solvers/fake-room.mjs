// Deterministic in-memory room driver for the join→claim→finish solver.
// It models the Project Room contract a solver must satisfy: claims are
// exclusive leases (a second claim while held is denied), and finishing with
// the lease mints a work receipt. Unknown methods throw — the driver must
// never silently accept a call the real room would reject.

export function createFakeRoom({ room = 'evals-lab' } = {}) {
  const claims = new Map(); // taskId -> { holder, leaseId }
  const receipts = [];

  const api = {
    'room.join': ({ agent }) => {
      if (!agent) throw new Error('room.join requires an agent');
      return { ok: true, room, agent };
    },
    'room.claim': ({ agent, taskId }) => {
      if (!agent || !taskId) throw new Error('room.claim requires agent + taskId');
      const held = claims.get(taskId);
      if (held) return { ok: false, error: 'already-claimed', holder: held.holder };
      const leaseId = `lease-${taskId}-${agent}`;
      claims.set(taskId, { holder: agent, leaseId });
      return { ok: true, leaseId };
    },
    'room.finish': ({ agent, taskId, leaseId }) => {
      if (!agent || !taskId || !leaseId) throw new Error('room.finish requires agent + taskId + leaseId');
      const held = claims.get(taskId);
      if (!held || held.holder !== agent || held.leaseId !== leaseId) {
        return { ok: false, error: 'not-lease-holder' };
      }
      claims.delete(taskId);
      const receipt = { taskId, agent, kind: 'work-receipt' };
      receipts.push(receipt);
      return { ok: true, receipt };
    },
  };

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'inspectState') return () => ({ claims: Object.fromEntries(claims), receipts: [...receipts] });
        if (!(prop in api)) throw new Error(`FakeRoom: unknown method "${String(prop)}"`);
        return api[prop];
      },
    },
  );
}
