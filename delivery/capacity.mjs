// One durable authority per provider account/pool, shared by repositories.
// Reservations are never freed by wall-clock expiry: an uncertain provider run
// may still consume capacity. Release requires reconciliation evidence.
export class DeliveryCapacity {
  constructor(journal, resource, { maximumSlots }) {
    if (!Number.isSafeInteger(maximumSlots) || maximumSlots < 1) throw new Error('Invalid capacity');
    this.journal = journal;
    this.resource = resource;
    this.maximumSlots = maximumSlots;
    this.id = `capacity:${resource}`;
  }

  snapshot() {
    const record = this.journal.read(this.id);
    if (record && record.value.resource !== this.resource) throw new Error('Capacity resource mismatch');
    return { revision: record?.revision ?? 0, reservations: record?.value.data.reservations ?? {} };
  }

  reserve(lease, { id, repository, slots }) {
    if (lease.resource !== this.resource) throw new Error('Capacity authority mismatch');
    if (typeof id !== 'string' || !id || id.length > 128 || typeof repository !== 'string' || !repository || repository.length > 512 || !Number.isSafeInteger(slots) || slots < 1) throw new Error('Invalid reservation');
    return this.journal.transaction(() => {
      this.journal.assertLease(lease);
      const state = this.snapshot();
      const previous = Object.hasOwn(state.reservations, id) ? state.reservations[id] : null;
      if (previous) {
        if (previous.repository !== repository || previous.slots !== slots) throw new Error('Reservation identity conflict');
        return previous;
      }
      const used = Object.values(state.reservations).filter(entry => entry.state !== 'released').reduce((sum, entry) => sum + entry.slots, 0);
      if (used + slots > this.maximumSlots) return null;
      const reservation = { repository, slots, state: 'reserved', createdAt: this.journal.now() };
      this.journal.write(lease, this.id, state.revision, { reservations: { ...state.reservations, [id]: reservation } });
      return reservation;
    });
  }

  release(lease, id, evidence) {
    if (lease.resource !== this.resource) throw new Error('Capacity authority mismatch');
    if (!evidence || !['completed', 'cancelled', 'never-dispatched'].includes(evidence.outcome) || typeof evidence.receipt !== 'string' || !evidence.receipt) throw new Error('Capacity reconciliation evidence required');
    return this.journal.transaction(() => {
      this.journal.assertLease(lease);
      const state = this.snapshot();
      const previous = Object.hasOwn(state.reservations, id) ? state.reservations[id] : null;
      if (!previous) throw new Error('Unknown reservation');
      if (previous.state === 'released') return previous;
      const released = { ...previous, state: 'released', evidence, releasedAt: this.journal.now() };
      this.journal.write(lease, this.id, state.revision, { reservations: { ...state.reservations, [id]: released } });
      return released;
    });
  }
}
