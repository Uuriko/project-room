import { ProjectRoom } from './room.mjs';

export class IntegrityFairnessProbe extends ProjectRoom {
  async runProof() {
    this.trace = [];
    this.store.incrementalIntegrityCheck = () => {
      this.trace.push('incremental');
      this.pendingRead = this.env.ROOM.getByName('integrity-fairness').readCheckpoint();
      return { ok: true, checked: 0, swept: 0 };
    };
    this.store.runDeferredIntegrityBatch = async () => {
      this.trace.push('deferred');
      return { ran: 1, failures: [] };
    };
    await this.verifyRoomIntegrity();
    await this.pendingRead;
    return this.trace;
  }
  readCheckpoint() { this.trace.push('queued-read'); return true; }
}
export default {
  async fetch(_request, env) {
    return Response.json(await env.ROOM.getByName('integrity-fairness').runProof());
  }
};
