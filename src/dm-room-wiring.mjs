/**
 * dm-room-wiring.mjs — Pure 1:1 DM-room wiring between agents.
 *
 * A DM room is a private 1:1 channel between two agents. Nothing here touches
 * the network, the DOM, localStorage, or any secret — it is a pure wiring/store
 * layer. Message delivery goes through an injected `deliver` dependency so the
 * wiring stays side-effect-free except through that one seam.
 *
 * Model:
 *   room = { id, agentA, agentB, createdAt, messages[], state: 'open'|'closed' }
 *   - agentA / agentB are in canonical order: dm(a, b) ≡ dm(b, a), so at most
 *     one room ever exists per agent pair.
 *   - messages: [{ id, from, text, at }] in send order.
 *   - unread: per-room, per-agent counters keyed by agent id; sending bumps the
 *     counter of the *other* participant, markRead zeroes the reader's counter.
 *
 * Operations:
 *   openDM(a, b)        — idempotent: returns the existing room for the pair.
 *   closeDM(roomId)     — open → closed.
 *   reopenDM(roomId)    — closed → open.
 *   sendDM(roomId, from, text) — validates sender is a participant and the room
 *                                is open, stores the message, bumps unread, and
 *                                calls the injected deliver(dep).
 *   listDMs(agentId)    — all rooms where agentId is a participant.
 *   history(roomId, limit, before) — newest-first? No: oldest-first slice,
 *                                paginated by message id (before = exclusive).
 *   block(a, b) / unblock(a, b) — blocked pairs cannot open rooms and sends
 *                                are rejected.
 *   markRead(roomId, agentId)    — zeroes the agent's unread counter.
 *   unreadCount(roomId, agentId) — participant's unread counter.
 *   unreadTotal(agentId)         — summed unread across the agent's rooms.
 *   onEvent(listener) → unsubscribe — subscriber notifications for
 *                                room.opened|closed|reopened, message.sent,
 *                                agent.blocked|unblocked, room.read.
 *   snapshot() / restore(data) — full state round-trip with schema version
 *                                and corruption detection.
 *
 * Dependency injection (all via the `deps` parameter of createDMRooms):
 *   - clock:   () => number  (ms epoch; default: Date.now)
 *   - id:      () => string  (room/message id generator; default: counter)
 *   - deliver: (delivery: { roomId, from, to, message }) => void
 *              (default: no-op — production wiring MUST inject a real
 *              transport; delivery failures surface as DM_DELIVER_FAILED)
 *   - storage: { save(state: string) , load() : string|null }
 *              (default: in-memory null store — write-through on mutation)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   DM_NOT_FOUND        — unknown room id
 *   DM_INVALID_ARG      — bad argument (empty agent id, empty text, bad limit,
 *                         a === b, non-participant where a participant is needed)
 *   DM_ALREADY_EXISTS   — (not thrown by openDM, which is idempotent) kept in
 *                         the contract for future explicit-create paths
 *   DM_CANNOT_OPEN      — pair is blocked, or room cannot be opened from state
 *   DM_BLOCKED          — pair is blocked (send path)
 *   DM_CLOSED           — send on a closed room
 *   DM_DELIVER_FAILED   — injected deliver() threw; message was stored, but the
 *                         delivery failure is never silent
 *   DM_CORRUPT_SNAPSHOT — restore() given non-JSON, wrong schema version, or
 *                         structurally invalid state
 * Failures are never silent.
 */

export const DM_STATES = Object.freeze(['open', 'closed']);

/** Schema version for snapshot()/restore(). Bump on any shape change. */
export const DM_SCHEMA_VERSION = 1;

/** Throw a coded DM error (never silent failures). */
function dmError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Canonical ordering of a pair: dm(a, b) ≡ dm(b, a). Deterministic across
 * calls regardless of argument order.
 */
export function canonicalPair(a, b) {
  if (typeof a !== 'string' || a.length === 0) {
    throw dmError('DM_INVALID_ARG', 'Agent id must be a non-empty string', { agentId: a });
  }
  if (typeof b !== 'string' || b.length === 0) {
    throw dmError('DM_INVALID_ARG', 'Agent id must be a non-empty string', { agentId: b });
  }
  if (a === b) {
    throw dmError('DM_INVALID_ARG', 'Cannot open a DM room with yourself', { agentId: a });
  }
  return a < b ? [a, b] : [b, a];
}

/** In-memory null storage used when no storage is injected. */
function nullStorage() {
  let box = null;
  return {
    save: (state) => {
      box = state;
    },
    load: () => box,
  };
}

/**
 * Create a new 1:1 DM room wiring store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(delivery: { roomId, from, to, message }) => void} [deps.deliver]
 * @param {{ save(state: string): void, load(): string|null }} [deps.storage]
 */
export function createDMRooms(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const deliver = deps.deliver ?? (() => {});
  const storage = deps.storage ?? nullStorage();

  let idCounter = 0;
  const newId = deps.id ?? ((prefix) => `${prefix}-${(idCounter += 1)}`);

  /** Internal room records, keyed by room id. */
  const rooms = new Map();
  /** roomId lookup keyed by canonical pair key "a\0b". */
  const pairIndex = new Map();
  /** Blocked pairs: Set of canonical pair keys. */
  const blocked = new Set();
  /** Event subscribers. */
  const listeners = new Set();

  const pairKey = (a, b) => a + '\u0000' + b;

  function emit(type, payload) {
    const event = Object.freeze({ type, at: clock(), ...payload });
    for (const listener of [...listeners]) {
      listener(event);
    }
    return event;
  }

  function assertParticipant(room, agentId, op) {
    if (agentId !== room.agentA && agentId !== room.agentB) {
      throw dmError(
        'DM_INVALID_ARG',
        `Cannot ${op}: '${agentId}' is not a participant of DM room ${room.id}`,
        { roomId: room.id, agentId, op },
      );
    }
  }

  function getRoomOrThrow(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
      throw dmError('DM_NOT_FOUND', `Unknown DM room id: ${roomId}`, { roomId });
    }
    return room;
  }

  function snapshotRoom(room) {
    return Object.freeze({
      id: room.id,
      agentA: room.agentA,
      agentB: room.agentB,
      createdAt: room.createdAt,
      state: room.state,
      messages: Object.freeze(room.messages.map((m) => Object.freeze({ ...m }))),
      unread: Object.freeze({ ...room.unread }),
    });
  }

  function otherParticipant(room, agentId) {
    return agentId === room.agentA ? room.agentB : room.agentA;
  }

  /** Persist the full state write-through to injected storage. */
  function persist() {
    storage.save(
      JSON.stringify({
        version: DM_SCHEMA_VERSION,
        rooms: [...rooms.values()].map((room) => ({
          id: room.id,
          agentA: room.agentA,
          agentB: room.agentB,
          createdAt: room.createdAt,
          state: room.state,
          messages: room.messages,
          unread: room.unread,
        })),
        blocked: [...blocked],
        savedAt: clock(),
      }),
    );
  }

  const wiring = {
    /** Canonical pair ordering — dm(a, b) ≡ dm(b, a). */
    canonicalPair,

    /**
     * Open (or return the existing) 1:1 DM room for the pair. Idempotent:
     * calling twice for the same pair returns the same room.
     */
    openDM(a, b) {
      const [agentA, agentB] = canonicalPair(a, b);
      const key = pairKey(agentA, agentB);
      const existingId = pairIndex.get(key);
      if (existingId !== undefined) {
        return snapshotRoom(rooms.get(existingId));
      }
      if (blocked.has(key)) {
        throw dmError(
          'DM_CANNOT_OPEN',
          `Cannot open DM room: pair '${agentA}'/'${agentB}' is blocked`,
          { agentA, agentB },
        );
      }
      const room = {
        id: newId('dm'),
        agentA,
        agentB,
        createdAt: clock(),
        state: 'open',
        messages: [],
        unread: { [agentA]: 0, [agentB]: 0 },
      };
      rooms.set(room.id, room);
      pairIndex.set(key, room.id);
      persist();
      emit('room.opened', { roomId: room.id, agentA, agentB });
      return snapshotRoom(room);
    },

    /** Close an open room (open → closed). */
    closeDM(roomId) {
      const room = getRoomOrThrow(roomId);
      if (room.state !== 'open') {
        throw dmError(
          'DM_CANNOT_OPEN',
          `Cannot close DM room ${roomId}: state is '${room.state}', expected 'open'`,
          { roomId, state: room.state },
        );
      }
      room.state = 'closed';
      persist();
      emit('room.closed', { roomId: room.id });
      return snapshotRoom(room);
    },

    /** Reopen a closed room (closed → open). */
    reopenDM(roomId) {
      const room = getRoomOrThrow(roomId);
      if (room.state !== 'closed') {
        throw dmError(
          'DM_CANNOT_OPEN',
          `Cannot reopen DM room ${roomId}: state is '${room.state}', expected 'closed'`,
          { roomId, state: room.state },
        );
      }
      room.state = 'open';
      persist();
      emit('room.reopened', { roomId: room.id });
      return snapshotRoom(room);
    },

    /**
     * Send a DM in a room. Validates: room exists, is open, sender is a
     * participant, text is non-empty. Stores the message, bumps the *other*
     * participant's unread counter, then calls the injected deliver(); if
     * deliver throws, the message stays stored and DM_DELIVER_FAILED is thrown
     * (the failure is never silent).
     */
    sendDM(roomId, from, text) {
      const room = getRoomOrThrow(roomId);
      if (typeof text !== 'string' || text.length === 0) {
        throw dmError('DM_INVALID_ARG', 'DM text must be a non-empty string', { roomId, from });
      }
      assertParticipant(room, from, 'send');
      if (room.state !== 'open') {
        throw dmError('DM_CLOSED', `Cannot send in DM room ${roomId}: room is closed`, {
          roomId,
          state: room.state,
        });
      }
      if (blocked.has(pairKey(room.agentA, room.agentB))) {
        throw dmError('DM_BLOCKED', `Cannot send in DM room ${roomId}: pair is blocked`, {
          roomId,
        });
      }
      const to = otherParticipant(room, from);
      const message = Object.freeze({
        id: newId('msg'),
        from,
        text,
        at: clock(),
      });
      room.messages.push(message);
      room.unread[to] = (room.unread[to] ?? 0) + 1;
      persist();
      try {
        deliver({ roomId: room.id, from, to, message });
      } catch (err) {
        throw dmError(
          'DM_DELIVER_FAILED',
          `Deliver failed for DM in room ${roomId}: ${err?.message ?? err}`,
          { roomId, messageId: message.id, cause: err?.message ?? String(err) },
        );
      }
      emit('message.sent', { roomId: room.id, messageId: message.id, from, to });
      return message;
    },

    /** All rooms where agentId is a participant (frozen snapshots). */
    listDMs(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw dmError('DM_INVALID_ARG', 'Agent id must be a non-empty string', { agentId });
      }
      return [...rooms.values()]
        .filter((room) => room.agentA === agentId || room.agentB === agentId)
        .map(snapshotRoom);
    },

    /**
     * Message history, oldest-first, paginated by message id. `limit` caps the
     * number returned; `before` (a message id) returns messages sent strictly
     * before that message — an empty page when unknown. Returns
     * { messages, hasMore }.
     */
    history(roomId, limit = 50, before = null) {
      const room = getRoomOrThrow(roomId);
      if (!Number.isInteger(limit) || limit < 1) {
        throw dmError('DM_INVALID_ARG', 'history limit must be a positive integer', {
          roomId,
          limit,
        });
      }
      let messages = room.messages;
      if (before != null) {
        const idx = messages.findIndex((m) => m.id === before);
        if (idx === -1) {
          return { messages: [], hasMore: false };
        }
        messages = messages.slice(0, idx);
      }
      const page = messages.slice(-limit);
      const hasMore = messages.length > page.length;
      return {
        messages: Object.freeze(page.map((m) => Object.freeze({ ...m }))),
        hasMore,
      };
    },

    /** Block an agent pair: openDM throws DM_CANNOT_OPEN, sendDM throws DM_BLOCKED. */
    block(a, b) {
      const [agentA, agentB] = canonicalPair(a, b);
      blocked.add(pairKey(agentA, agentB));
      persist();
      emit('agent.blocked', { agentA, agentB });
      return { agentA, agentB, blocked: true };
    },

    /** Unblock an agent pair. */
    unblock(a, b) {
      const [agentA, agentB] = canonicalPair(a, b);
      const was = blocked.delete(pairKey(agentA, agentB));
      persist();
      emit('agent.unblocked', { agentA, agentB });
      return { agentA, agentB, blocked: false, wasBlocked: was };
    },

    /** True when the pair is blocked. */
    isBlocked(a, b) {
      const [agentA, agentB] = canonicalPair(a, b);
      return blocked.has(pairKey(agentA, agentB));
    },

    /** Zero the agent's unread counter in the room. */
    markRead(roomId, agentId) {
      const room = getRoomOrThrow(roomId);
      assertParticipant(room, agentId, 'mark read');
      room.unread[agentId] = 0;
      persist();
      emit('room.read', { roomId: room.id, agentId });
      return snapshotRoom(room);
    },

    /** The agent's unread count in one room. */
    unreadCount(roomId, agentId) {
      const room = getRoomOrThrow(roomId);
      assertParticipant(room, agentId, 'read unread count for');
      return room.unread[agentId] ?? 0;
    },

    /** The agent's summed unread count across all their rooms. */
    unreadTotal(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw dmError('DM_INVALID_ARG', 'Agent id must be a non-empty string', { agentId });
      }
      let total = 0;
      for (const room of rooms.values()) {
        if (room.agentA === agentId || room.agentB === agentId) {
          total += room.unread[agentId] ?? 0;
        }
      }
      return total;
    },

    /** Read-only snapshot of a room (null if unknown). */
    get(roomId) {
      const room = rooms.get(roomId);
      return room ? snapshotRoom(room) : null;
    },

    /**
     * Subscribe to wiring events. Returns an unsubscribe function.
     * Event types: room.opened, room.closed, room.reopened, message.sent,
     * agent.blocked, agent.unblocked, room.read.
     */
    onEvent(listener) {
      if (typeof listener !== 'function') {
        throw dmError('DM_INVALID_ARG', 'Event listener must be a function', {});
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Full state snapshot (JSON string) with schema version — round-trips
     * through restore().
     */
    snapshot() {
      return JSON.stringify({
        version: DM_SCHEMA_VERSION,
        rooms: [...rooms.values()].map((room) => ({
          id: room.id,
          agentA: room.agentA,
          agentB: room.agentB,
          createdAt: room.createdAt,
          state: room.state,
          messages: room.messages,
          unread: room.unread,
        })),
        blocked: [...blocked],
        savedAt: clock(),
      });
    },

    /**
     * Restore state from a snapshot() string. Rejects anything corrupt with
     * DM_CORRUPT_SNAPSHOT: non-JSON, wrong schema version, or structurally
     * invalid rooms/messages. On success replaces all in-memory state and
     * writes it through to storage.
     */
    restore(data) {
      let parsed;
      try {
        parsed = typeof data === 'string' ? JSON.parse(data) : data;
      } catch (err) {
        throw dmError('DM_CORRUPT_SNAPSHOT', `Snapshot is not valid JSON: ${err.message}`, {});
      }
      if (!parsed || typeof parsed !== 'object' || parsed.version !== DM_SCHEMA_VERSION) {
        throw dmError(
          'DM_CORRUPT_SNAPSHOT',
          `Snapshot schema version mismatch: expected ${DM_SCHEMA_VERSION}, got ${parsed?.version}`,
          { version: parsed?.version },
        );
      }
      if (!Array.isArray(parsed.rooms) || !Array.isArray(parsed.blocked)) {
        throw dmError('DM_CORRUPT_SNAPSHOT', 'Snapshot rooms/blocked must be arrays', {});
      }
      const nextRooms = new Map();
      const nextPairs = new Map();
      for (const raw of parsed.rooms) {
        validateRoomShape(raw);
        const [agentA, agentB] = canonicalPair(raw.agentA, raw.agentB);
        const room = {
          id: raw.id,
          agentA,
          agentB,
          createdAt: raw.createdAt,
          state: raw.state,
          messages: raw.messages.map((m) => Object.freeze({ ...m })),
          unread: {
            [agentA]: Number.isInteger(raw.unread?.[agentA]) ? raw.unread[agentA] : 0,
            [agentB]: Number.isInteger(raw.unread?.[agentB]) ? raw.unread[agentB] : 0,
          },
        };
        const key = pairKey(agentA, agentB);
        if (nextPairs.has(key)) {
          throw dmError(
            'DM_CORRUPT_SNAPSHOT',
            `Snapshot has two rooms for the same pair '${agentA}'/'${agentB}'`,
            { agentA, agentB },
          );
        }
        nextRooms.set(room.id, room);
        nextPairs.set(key, room.id);
      }
      for (const raw of parsed.blocked) {
        if (typeof raw !== 'string' || raw.length === 0) {
          throw dmError('DM_CORRUPT_SNAPSHOT', 'Snapshot blocked entries must be pair keys', {});
        }
      }
      rooms.clear();
      for (const [id, room] of nextRooms) rooms.set(id, room);
      pairIndex.clear();
      for (const [key, id] of nextPairs) pairIndex.set(key, id);
      blocked.clear();
      for (const key of parsed.blocked) blocked.add(key);
      persist();
      return true;
    },

    /** Reload in-memory state from injected storage (null storage → no-op). */
    reload() {
      const data = storage.load();
      if (data == null) return false;
      return this.restore(data);
    },
  };

  /** Structural validation of one room record from a snapshot. */
  function validateRoomShape(raw) {
    const ok =
      raw &&
      typeof raw === 'object' &&
      typeof raw.id === 'string' &&
      raw.id.length > 0 &&
      typeof raw.agentA === 'string' &&
      raw.agentA.length > 0 &&
      typeof raw.agentB === 'string' &&
      raw.agentB.length > 0 &&
      raw.agentA !== raw.agentB &&
      Number.isInteger(raw.createdAt) &&
      (raw.state === 'open' || raw.state === 'closed') &&
      Array.isArray(raw.messages) &&
      raw.messages.every(
        (m) =>
          m &&
          typeof m === 'object' &&
          typeof m.id === 'string' &&
          m.id.length > 0 &&
          typeof m.from === 'string' &&
          (m.from === raw.agentA || m.from === raw.agentB) &&
          typeof m.text === 'string' &&
          Number.isInteger(m.at),
      ) &&
      (raw.unread === undefined || typeof raw.unread === 'object');
    if (!ok) {
      throw dmError('DM_CORRUPT_SNAPSHOT', 'Snapshot contains a structurally invalid room', {
        roomId: raw?.id,
      });
    }
  }

  // Hydrate from storage on creation so a store survives process restarts
  // (a no-op when nothing was persisted yet).
  const hydrated = storage.load();
  if (hydrated != null) {
    wiring.restore(hydrated);
  }

  return Object.freeze(wiring);
}
