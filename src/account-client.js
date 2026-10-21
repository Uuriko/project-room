import { humanErrorMessage } from "./error-copy.js";

export const IDENTITY_MINT_POW_BITS = 12;
export const IDENTITY_MINT_POW_WINDOW_MS = 10 * 60 * 1000;
// The server raises the mint difficulty under load (POW_STEPS in
// server/agent-identities.mjs: 16 bits once the global daily mint budget is
// half spent, 20 bits at 80%), and a proof solved at a lower difficulty only
// coincidentally satisfies a higher one (1/16, resp. 1/256 of the time). The
// 428 proof_required body names the required difficulty in its proof
// object; submitters re-solve at that difficulty instead of failing the
// mint exactly when the server is busiest.
export const IDENTITY_MINT_POW_ESCALATION_BITS = Object.freeze([16, 20]);

// Same challenge as server/agent-identities.mjs solveIdentityMintProof:
// sha256(`${bucket}:${trim(displayName)}:${nonce}`) with bucket = floor(now / window).
// Digests run in batches so the escalated difficulties stay reachable: a
// one-at-a-time awaited digest loop needs ~1M sequential round trips at 20
// bits. Batch results are checked in nonce order, so the winning nonce is
// the same one the sequential search (and the server solver) finds first.
export async function solveIdentityMintProof(displayName, now = Date.now(), bits = IDENTITY_MINT_POW_BITS) {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (!Number.isInteger(bits) || bits < 4 || bits > 32 || bits % 4 !== 0) throw new Error("invalid_proof_difficulty");
  const bucket = Math.floor(now / IDENTITY_MINT_POW_WINDOW_MS);
  const zeroBytes = Math.floor(bits / 8), halfByte = bits % 8 === 4;
  const encoder = new TextEncoder();
  const limit = Math.max(1_000_000, 2 ** (bits + 4));
  const batchSize = 1024;
  for (let start = 0; start < limit; start += batchSize) {
    const jobs = [];
    for (let i = start; i < Math.min(start + batchSize, limit); i++) {
      const nonce = i.toString(36);
      jobs.push(crypto.subtle.digest("SHA-256", encoder.encode(`${bucket}:${name}:${nonce}`))
        .then(digest => {
          const bytes = new Uint8Array(digest);
          for (let k = 0; k < zeroBytes; k++) if (bytes[k] !== 0) return null;
          return (!halfByte || bytes[zeroBytes] < 16) ? nonce : null;
        }));
    }
    for (const nonce of await Promise.all(jobs)) if (nonce !== null) return nonce;
  }
  throw new Error("proof search exhausted");
}

// The difficulty to try after a 428 proof_required at `currentBits`: the
// difficulty the server stated in the 428 body's proof object when it is a
// real escalation, otherwise the next step the server is known to use.
// Null when there is nothing higher to try and the refusal is final.
export function escalatedIdentityMintPowBits(error, currentBits) {
  const stated = error?.proof?.bits;
  if (Number.isInteger(stated) && stated > currentBits && stated <= 32 && stated % 4 === 0) return stated;
  return IDENTITY_MINT_POW_ESCALATION_BITS.find(bits => bits > currentBits) ?? null;
}

// Solve-and-submit an identity mint, re-solving at the escalated difficulty
// whenever the server answers 428 proof_required. `submit(proof)` performs
// one mint attempt and must surface the server's refusal as an error with
// code "proof_required" and, when the 428 body carried it, its proof object.
// Any other failure, and a refusal at the highest difficulty, propagates.
export async function submitIdentityMint(displayName, submit, solve = solveIdentityMintProof) {
  let bits = IDENTITY_MINT_POW_BITS;
  for (;;) {
    const proof = await solve(displayName, Date.now(), bits);
    try {
      return await submit(proof);
    } catch (error) {
      if (error?.code !== "proof_required") throw error;
      const nextBits = escalatedIdentityMintPowBits(error, bits);
      if (nextBits === null) throw error;
      bits = nextBits;
    }
  }
}

export const accountSessionError = message => {
  const error = new Error(message);
  error.status = 401;
  error.code = "account_session_required";
  return error;
};

export const sameAccountSession = (candidate, owner) => Boolean(candidate?.account && owner?.account)
  && candidate.account.id === owner.account.id
  && candidate.account.authEpoch === owner.account.authEpoch
  && candidate.sessionRevision === owner.sessionRevision
  && candidate.sessionBinding === owner.sessionBinding;

export class AccountClient {
  #invalidatedGeneration = -1;
  constructor({ fetcher = globalThis.fetch.bind(globalThis) } = {}) {
    this.fetcher = fetcher;
    this.session = null;
    this.generation = 0;
  }
  async request(path, { method = "GET", data, credentials = "same-origin", session = null, headers: extraHeaders = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetcher(path, { method, credentials, signal: controller.signal,
        headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(session?.csrf ? { "X-CSRF-Token": session.csrf } : {}), ...(session?.sessionBinding ? { "X-Session-Binding": session.sessionBinding } : {}), ...extraHeaders },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const body = await response.json();
      if (!response.ok) { const serverError = body?.error ?? {}; const error = new Error(humanErrorMessage({ status: response.status, code: serverError.code, message: serverError.message })); error.status = response.status; error.code = serverError.code; if (body?.proof) error.proof = body.proof; throw error; }
      return body;
    } finally { clearTimeout(timer); }
  }
  owns(generation, session) { return generation === this.generation && this.session === session; }
  invalidate(generation, session) {
    if (!this.owns(generation, session)) return false;
    this.generation++;
    this.#invalidatedGeneration = this.generation;
    this.session = null;
    return true;
  }
  currentSession(action, { authenticated = false } = {}) {
    const session = this.session;
    if (!session || !Number.isSafeInteger(session.sessionRevision) || typeof session.csrf !== "string" || typeof session.sessionBinding !== "string"
      || (authenticated && (!session.authenticated || !session.account))) {
      throw accountSessionError(`Restore${authenticated ? " and sign in to" : ""} the account session before ${action}`);
    }
    return session;
  }
  // QA 2026-10-20: the sign-in endpoints already answer with the full session
  // view (sessionAccountView). Adopting it skips a second GET /api/account-session
  // round trip; anything short of a complete view falls back to restore().
  adopt(view) {
    if (!view?.authenticated || typeof view.account?.id !== "string" || typeof view.csrf !== "string"
      || typeof view.sessionBinding !== "string" || !Number.isSafeInteger(view.sessionRevision)
      || !view.terms || typeof view.terms !== "object") return null;
    ++this.generation;
    this.session = view;
    return view;
  }
  async restore() {
    const generation = ++this.generation;
    this.session = null;
    try {
      const restored = await this.request("/api/account-session");
      if (generation !== this.generation) return null;
      this.session = restored;
      return restored;
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
  }
  async login(accountAccessKey) {
    const session = this.currentSession("signing in");
    const generation = ++this.generation;
    try {
      const loggedIn = await this.request("/api/account-session", { method: "POST", session,
        data: { accountAccessKey, expectedSessionRevision: session.sessionRevision } });
      if (!this.owns(generation, session)) return null;
      if (!loggedIn?.authenticated || !loggedIn.account || loggedIn.sessionRevision !== session.sessionRevision + 1) {
        this.invalidate(generation, session);
        return null;
      }
      this.session = loggedIn;
      return loggedIn;
    } catch (error) {
      if (!this.owns(generation, session)) return null;
      // A transport failure can follow a committed identity switch. Do not retain an
      // identity view whose browser slot outcome is unknown; an HTTP rejection did not
      // mutate the slot and may be retried with the same revision.
      if (!Number.isSafeInteger(error.status) || ["stale_session_revision", "session_binding_changed", "csrf_denied", "account_session_required"].includes(error.code)) {
        this.invalidate(generation, session);
      }
      throw error;
    }
  }
  async confirm() {
    const session = this.currentSession("confirming access", { authenticated: true }), generation = this.generation;
    // A sibling read can confirm expiry first. A newer restore also clears
    // session temporarily, but it must keep ownership of the replacement UI.
    const superseded = () => this.session === null && this.generation === generation + 1
      && this.#invalidatedGeneration === this.generation ? false : null;
    let value;
    try {
      // Name the session this read is checking: a delayed confirmation must
      // never mint a slot, rotate a cookie, or clobber a newer sign-in.
      value = await this.request("/api/account-session", { session });
    } catch (error) {
      // A response that lands after a newer session replaced this one is
      // obsolete: never let it touch the replacement, whatever it reports.
      if (!this.owns(generation, session)) return superseded();
      // Ownership ended (signed out, revoked, binding rotated): retire the
      // view instead of throwing. Uncertain failures (5xx, offline) keep
      // the session so the caller can retry.
      if (error?.status === 401 || error?.status === 403 || error?.status === 409
        || ["unauthenticated", "access_denied", "session_binding_changed"].includes(error?.code)) {
        this.invalidate(generation, session);
        return false;
      }
      throw error;
    }
    if (!this.owns(generation, session)) return superseded();
    if (!value?.authenticated || !sameAccountSession(value, session)) { this.invalidate(generation, session); return false; }
    return true; // Keep object identity and generation: Room and Inbox own these.
  }
  async rooms(after = null) {
    const session = this.currentSession("listing rooms", { authenticated: true }), generation = this.generation;
    let value;
    try { value = await this.request("/api/account-rooms" + (after === null ? "" : "?after=" + encodeURIComponent(after)), { session }); }
    catch (error) {
      if (!this.owns(generation, session)) return null;
      if (error.status === 401 || ["session_binding_changed", "account_session_required"].includes(error.code)) this.invalidate(generation, session);
      throw error;
    }
    if (!this.owns(generation, session)) return null;
    const v = value?.viewer;
    if (value?.contractVersion !== 1 || v?.accountId !== session.account.id || v.authEpoch !== session.account.authEpoch
      || v.sessionRevision !== session.sessionRevision || v.sessionBinding !== session.sessionBinding) {
      this.invalidate(generation, session); throw accountSessionError("Account changed");
    }
    const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
    if (!Array.isArray(value.rooms) || value.rooms.length > 50 || !value.rooms.every(r => id(r?.id) && id(r.memberId) && typeof r.title === "string")
      || (value.nextCursor !== null && !id(value.nextCursor))) throw new Error("Room list could not be confirmed");
    let previous = after ?? "";
    for (const room of value.rooms) { if (room.id <= previous) throw new Error("Room list order could not be confirmed"); previous = room.id; }
    if (value.nextCursor !== null && (value.nextCursor <= (after ?? "") || value.nextCursor < previous)) throw new Error("Room continuation could not be confirmed");
    return value;
  }
  // #3342 Owner Cockpit slice 1: the cross-room Decisions + Exceptions
  // document. Session-identity checked exactly like rooms(): a document
  // that does not echo this session's binding is never rendered.
  async ownerOverview({ window = "7d", after = null } = {}) {
    const session = this.currentSession("loading the owner overview", { authenticated: true }), generation = this.generation;
    let value;
    const query = new URLSearchParams({ window });
    if (after !== null) query.set("after", after);
    try { value = await this.request("/api/owner/overview?" + query.toString(), { session }); }
    catch (error) {
      if (!this.owns(generation, session)) return null;
      if (error.status === 401 || ["session_binding_changed", "account_session_required"].includes(error.code)) this.invalidate(generation, session);
      throw error;
    }
    if (!this.owns(generation, session)) return null;
    const v = value?.viewer;
    if (value?.contractVersion !== 1 || v?.accountId !== session.account.id || v.authEpoch !== session.account.authEpoch
      || v.sessionRevision !== session.sessionRevision || v.sessionBinding !== session.sessionBinding) {
      this.invalidate(generation, session); throw accountSessionError("Account changed");
    }
    if (!Array.isArray(value.decisions?.items) || !Array.isArray(value.exceptions?.items) || !Array.isArray(value.roomErrors)) {
      throw new Error("Owner overview could not be confirmed");
    }
    return value;
  }
  async logout() {
    const session = this.currentSession("signing out");
    const generation = ++this.generation;
    try {
      const loggedOut = await this.request("/api/account-session", { method: "DELETE", session,
        data: { expectedSessionRevision: session.sessionRevision } });
      if (!this.owns(generation, session)) return null;
      if (loggedOut?.authenticated !== false || loggedOut.account !== null || loggedOut.sessionRevision !== session.sessionRevision + 1) {
        this.invalidate(generation, session);
        return null;
      }
      this.session = loggedOut;
      return loggedOut;
    } catch (error) {
      if (!this.owns(generation, session)) return null;
      if (!Number.isSafeInteger(error.status) || ["stale_session_revision", "csrf_denied", "account_session_required", "unauthenticated"].includes(error.code)) {
        this.invalidate(generation, session);
      }
      throw error;
    }
  }
  previewInvitation(invitationToken) {
    // Preview deliberately sends neither the current account cookie nor its CSRF/binding.
    return this.request("/api/invitations/preview", { method: "POST", credentials: "omit", data: { invitationToken } });
  }
  // RC-2026-09-19-071 (QAJ-001): the request-access door. A stranger with a
  // dead invitation mints a self-serve identity (an identity alone grants
  // nothing) and files an access request the room owner can approve or
  // deny. The mint is unauthenticated by design; filing the request proves
  // the minted identity's secret as Bearer (issue #2912), so a request can
  // only be filed by the identity's holder.
  async mintAccessIdentity(displayName) {
    return submitIdentityMint(displayName, proof => this.request("/api/agent-identities", { method: "POST", credentials: "omit", data: { displayName, proof } }));
  }
  submitAccessRequest({ roomId, identityId, displayName, requestedPermissions, note, referredBy, requestId, secret }) {
    return this.request("/api/access-requests", { method: "POST", credentials: "omit",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      data: { roomId, identityId, displayName, requestedPermissions, note, referredBy: referredBy ?? null, requestId } });
  }
  async joinShareLink({ linkToken, displayName, redemptionId }) {
    const session = this.currentSession("joining a room");
    // An authenticated join adds membership, not a new browser identity. Keep
    // existing Room ownership intact just as targeted acceptance does.
    const generation = session.authenticated ? this.generation : ++this.generation;
    try {
      const result = await this.request("/api/share-links/join", { method: "POST", session,
        data: { linkToken, displayName, redemptionId, expectedSessionRevision: session.sessionRevision } });
      if (!this.owns(generation, session)) return null;
      if (result.roomMode === true) return result;
      const next = result.session;
      const valid = next?.account && next.roomId === result.roomId && next.member?.kind === "human"
        && (session.authenticated ? sameAccountSession(next, session) : next.sessionRevision === session.sessionRevision + 1);
      if (!valid) { this.invalidate(generation, session); return null; }
      if (!session.authenticated) this.session = { ...next, authenticated: true };
      return result;
    } catch (error) {
      if (!this.owns(generation, session)) return null;
      // Anonymous joins may switch identity even if their response was lost.
      // Authenticated joins cannot switch identity; a rejected link must not
      // discard the unrelated open Room's ownership and private drafts.
      if (!session.authenticated || error.status === 401
        || ["session_binding_changed", "csrf_denied", "account_session_required"].includes(error.code)) this.invalidate(generation, session);
      throw error;
    }
  }
  async prepareShareLink(linkToken) {
    let preview;
    try {
      preview = await this.request("/api/share-links/preview", { method: "POST", credentials: "omit", data: { linkToken } });
    } catch (error) {
      if (error.code !== "link_unavailable") throw error;
      const session = this.session ?? await this.restore();
      if (!session?.authenticated) throw error;
      const generation = this.generation;
      // Closed invitations cannot admit anyone new, but remain a door for an
      // existing member. The server checks membership without redeeming a place.
      preview = await this.request("/api/share-links/preview", { method: "POST", session, data: { linkToken } });
      if (!this.owns(generation, session)) return { preview, session: null };
    }
    // Preview/cancel is not consent to replace an already-open account context.
    const session = this.session ?? await this.restore();
    return { preview, session };
  }
  async acceptInvitation({ invitationToken, redemptionId, expectedRevision }) {
    const session = this.currentSession("accepting an invitation", { authenticated: true });
    const generation = this.generation;
    try {
      const accepted = await this.request("/api/invitations/accept", { method: "POST", session,
        data: { invitationToken, redemptionId, expectedRevision } });
      if (!this.owns(generation, session)) return null;
      if (!sameAccountSession(accepted?.session, session)) {
        this.invalidate(generation, session);
        return null;
      }
      return accepted;
    } catch (error) {
      if (!this.owns(generation, session)) return null;
      if (error.status === 401 || ["stale_session_revision", "session_binding_changed", "csrf_denied", "account_session_required"].includes(error.code)) {
        this.invalidate(generation, session);
      }
      throw error;
    }
  }
}
