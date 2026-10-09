// PRODUCT-200 reliability — deterministic worlds for the chaos seed corpus.
//
// Two worlds, both driving the REAL implementation (no reimplementation):
//
//   makeBoardWorld() — the work-claim board route layer
//     (server/work-claim-routes.mjs handleWorkClaims + a real registry),
//     with fakes only at the HTTP boundary (helpers/auth) and a journal
//     sink standing in for the room's event log (SEED-B24's contract).
//
//   makeInviteWorld() — the agent-invite redeem path (server/agent-invites.mjs
//     AgentInvites) against a real RoomStore/SQLite in the worktree .tmp
//     (never the shared /tmp tmpfs).
//
// Determinism: seeds use fixed claim ids and fixed op sequences. Wall-clock
// timestamps appear in evidence strings but never affect a verdict — every
// seed returns the same violated/not-violated verdict on every run.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkClaimRegistry, handleWorkClaims } from "../../server/work-claim-routes.mjs";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { AgentInvites } from "../../server/agent-invites.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Repo root = two levels above tests/chaos-seeds/. The worktree-local .tmp/
// is persistent (not reaped like /tmp) per scripts/test-env.sh.
export const repoRoot = join(here, "..", "..");
export const scratchRoot = join(repoRoot, ".tmp", "chaos-seeds");

// ---------------------------------------------------------------------------
// Board world (route layer)
// ---------------------------------------------------------------------------

const fakeHelpers = () => {
  const calls = [];
  const reject = (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    throw error;
  };
  return {
    calls,
    json: (res, status, value) => { calls.push({ status, value }); return { status, value }; },
    reject,
    body: async req => req.body,
  };
};

export function makeBoardWorld({ roomId = "seed-room" } = {}) {
  const registry = createWorkClaimRegistry();
  // B24 contract sink: the board write path must journal work_claim.*
  // events for every committed write. This array stands in for the room's
  // event log until the write path is wired to journal them; the seed
  // asserts the sink is populated (see SEEDS.md for the seam contract).
  const journal = [];
  const store = {
    roomAuthority: () => ({
      members: {
        alice: { id: "alice", kind: "agent", active: true, permissions: [] },
        bob: { id: "bob", kind: "agent", active: true, permissions: ["verify"] },
      },
    }),
    room: () => ({ state: { messages: [] } }),
    jevShadow: { record() {} },
    journalClaimEvent: (type, data) => { journal.push({ roomId, type, data }); },
  };
  const helpers = fakeHelpers();
  const auth = memberId => ({ member: { id: memberId, kind: "agent", permissions: [] } });

  // Runs one board op through the real route handler. Resolves to
  // { ok, status, code, value } — never throws for HTTP-level refusals.
  const call = async (route, { id = null, body = {}, memberId = "alice" } = {}) => {
    const method = route === "list" || route === "read" ? "GET" : "POST";
    try {
      const out = await handleWorkClaims({
        req: { method, body }, res: {}, url: new URL("http://seed.local/"),
        store, roomId, auth: auth(memberId),
        workClaimRoute: route, workClaimId: id, helpers, registry,
      });
      return { ok: out.status < 400, status: out.status, code: null, value: out.value };
    } catch (error) {
      return { ok: false, status: error.status ?? 500, code: error.code ?? "unknown", value: null, message: error.message };
    }
  };
  const read = id => registry.get(roomId, id);
  return { registry, store, journal, helpers, call, read, roomId };
}

// ---------------------------------------------------------------------------
// Invite world (redeem path, real SQLite store)
// ---------------------------------------------------------------------------

export async function makeInviteWorld({ roomId = "seed-room" } = {}) {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "invites-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom(roomId, "owner"));
  const ownerKey = store.issueAccessKey(roomId, "owner");
  const invites = new AgentInvites(store);
  const close = () => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); };
  return { store, invites, ownerKey, roomId, close };
}

// Runs fn() and normalizes a ServiceError throw into { ok:false, ... }.
export async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, status: error.status ?? 500, code: error.code ?? "unknown", message: error.message };
  }
}
