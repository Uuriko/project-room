// Fixture helpers for invariant scenarios: identities, rooms, claims.
//
// Thin wrappers over the acceptance fixture's store so scenarios read
// as intent ("mint an identity", "propose work", "acquire the claim")
// instead of plumbing. All writes go through f.store.command / the
// store's identity APIs on the scenario's disposable database —
// nothing here touches a live system.

import { randomUUID } from "node:crypto";
import { EVENT_TYPES as T } from "../../src/events.js";

const ROOM = "commons";

// Mint a fresh agent identity. Returns { identityId, secret }.
export function mintIdentity(f, name = `invariant-agent-${randomUUID().slice(0, 8)}`) {
  return f.store.identities.create(name);
}

// Link an identity into the fixture room with the given permissions.
// Returns the receipt plus the freshly issued owner access key —
// issuing a new key REVOKES f.keys.owner, so use the returned key for
// any later owner commands in the same scenario.
export function linkToRoom(f, identityId, permissions = ["accept_work"]) {
  const ownerKey = f.store.issueAccessKey(ROOM, "owner");
  const link = f.store.identities.link(ownerKey, ROOM, { identityId, permissions });
  return { link, ownerKey };
}

// Current revision of a work item's state (for expectedRevision).
export function workItemRevision(f, actor, workItemId) {
  return f.store.snapshot(actor, ROOM).state.workItems[workItemId]?.revision;
}

// Propose a work item and return its id. Defaults keep every scenario
// starting from the same well-formed shape.
export function proposeWork(f, { actor = f.keys.owner, title = "Invariant work item", accountableMemberId = "owner", overrides = {} } = {}) {
  const workItemId = `inv-${randomUUID().slice(0, 8)}`;
  f.store.command(actor, ROOM, {
    id: randomUUID(),
    type: T.WORK_PROPOSED,
    data: {
      workItemId,
      title,
      definitionOfDone: "Invariant holds under the scenario's actions",
      mode: "write",
      accountableMemberId,
      ...overrides,
    },
  });
  return workItemId;
}

// Accept a proposed work item (moves it to an actionable state).
export function acceptWork(f, workItemId, { actor = f.keys.owner } = {}) {
  return f.store.command(actor, ROOM, {
    id: randomUUID(),
    type: T.WORK_ACCEPTED,
    data: { workItemId, expectedRevision: workItemRevision(f, actor, workItemId) },
  });
}

// Acquire the claim on a work item. Returns the receipt.
export function acquireClaim(f, workItemId, { actor = f.keys.owner, extra = {} } = {}) {
  return f.store.command(actor, ROOM, {
    id: randomUUID(),
    type: T.CLAIM_ACQUIRED,
    data: {
      workItemId,
      expectedRevision: workItemRevision(f, actor, workItemId),
      repository: "test/invariants",
      ref: "synthetic",
      paths: ["src/app.js"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      ...extra,
    },
  });
}

// Release the claim on a work item. Returns the receipt.
export function releaseClaim(f, workItemId, { actor = f.keys.owner } = {}) {
  return f.store.command(actor, ROOM, {
    id: randomUUID(),
    type: T.CLAIM_RELEASED,
    data: { workItemId, expectedRevision: workItemRevision(f, actor, workItemId) },
  });
}

// Complete a work item. Returns the receipt.
export function completeWork(f, workItemId, { actor = f.keys.owner, summary = "Invariant scenario result" } = {}) {
  return f.store.command(actor, ROOM, {
    id: randomUUID(),
    type: T.WORK_COMPLETED,
    data: {
      workItemId,
      expectedRevision: workItemRevision(f, actor, workItemId),
      summary,
      evidenceUrl: "https://example.invalid/invariant-result",
      evidenceVersion: "v1",
      producerId: "owner",
    },
  });
}

// Read a work item's current state.
export function workItemState(f, actor, workItemId) {
  return f.store.snapshot(actor, ROOM).state.workItems[workItemId];
}
