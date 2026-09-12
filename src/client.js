import { verifyWorkResult } from "./work-packet.js";
import { validateCharterRead } from "./room-charter.js";
import { validId } from "./events.js";

const accountSessionError = message => {
  const error = new Error(message);
  error.status = 401;
  error.code = "account_session_required";
  return error;
};

const sameAccountSession = (candidate, owner) => Boolean(candidate?.account && owner?.account)
  && candidate.account.id === owner.account.id
  && candidate.account.authEpoch === owner.account.authEpoch
  && candidate.sessionRevision === owner.sessionRevision
  && candidate.sessionBinding === owner.sessionBinding;

export class AccountClient {
  constructor({ fetcher = globalThis.fetch.bind(globalThis) } = {}) {
    this.fetcher = fetcher;
    this.session = null;
    this.generation = 0;
  }
  async request(path, { method = "GET", data, credentials = "same-origin", session = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetcher(path, { method, credentials, signal: controller.signal,
        headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(session?.csrf ? { "X-CSRF-Token": session.csrf } : {}), ...(session?.sessionBinding ? { "X-Session-Binding": session.sessionBinding } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const body = await response.json();
      if (!response.ok) { const error = new Error(body.error?.message || "Request failed"); error.status = response.status; error.code = body.error?.code; throw error; }
      return body;
    } finally { clearTimeout(timer); }
  }
  owns(generation, session) { return generation === this.generation && this.session === session; }
  invalidate(generation, session) {
    if (!this.owns(generation, session)) return false;
    this.generation++;
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
    const value = await this.request("/api/account-session");
    if (!this.owns(generation, session)) return null;
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
    const preview = await this.request("/api/share-links/preview", { method: "POST", credentials: "omit", data: { linkToken } });
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

export class RoomClient {
  constructor({ fetcher = globalThis.fetch.bind(globalThis), events = globalThis.EventSource, accountClient = null, onSnapshot = () => {}, onStatus = () => {}, onAccessEnded = () => {} } = {}) {
    Object.assign(this, { fetcher, events, accountClient, onSnapshot, onStatus, onAccessEnded });
    this.session = null;
    this.sequence = 0;
    this.generation = 0;
    this.accountOwnership = null;
    this.streamRetryDelay = 1000;
    this.fileTransfers = new Set();
  }
  setAccountClient(accountClient) {
    if (this.accountClient === accountClient) return this;
    const hadSession = Boolean(this.session);
    this.disconnect();
    this.session = null;
    this.sequence = 0;
    this.accountOwnership = null;
    this.accountClient = accountClient;
    if (hadSession) this.onAccessEnded();
    return this;
  }
  async request(path, { method = "GET", data, authMode = this.session?.authMode, authSession = this.session, offerContext = false, maxResponseBytes = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let reader;
    if (maxResponseBytes !== null) this.fileTransfers.add(controller);
    try {
      const response = await this.fetcher(path, { method, credentials: "same-origin", signal: controller.signal,
        headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(authSession?.csrf ? { "X-CSRF-Token": authSession.csrf } : {}),
          ...(offerContext ? { "X-Project-Room-Offer-Context": "1" } : {}),
          ...(authMode === "account" ? { "X-Project-Room-Auth": "account", ...(authSession?.sessionBinding ? { "X-Session-Binding": authSession.sessionBinding } : {}) } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      let body;
      if (maxResponseBytes === null) body = await response.json();
      else {
        if (!response.body?.getReader) throw new Error('File status unavailable');
        reader = response.body.getReader();
        const chunks = []; let length = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new DOMException('Recovery cancelled', 'AbortError');
          if (done) break;
          length += value.byteLength;
          if (length > maxResponseBytes) throw new Error('File status response is too large');
          chunks.push(value);
        }
        const raw = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
        body = JSON.parse(new TextDecoder().decode(raw));
      }
      if (!response.ok) { const error = new Error(body.error?.message || "Request failed"); error.status = response.status; error.code = body.error?.code; throw error; }
      return body;
    } finally {
      clearTimeout(timer);
      if (maxResponseBytes !== null) {
        controller.abort(); this.fileTransfers.delete(controller);
        if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      }
    }
  }
  async restoreAttachment(item, pendingMessageId = null) {
    const session = this.session, generation = this.generation;
    if (!session || !this.ownsAccountSession()) throw accountSessionError('Reopen the Room before restoring files');
    const receipt = await this.request(this.path(`/attachments/${encodeURIComponent(item.id)}/status`), { authSession: session, maxResponseBytes: 4096 });
    if (session !== this.session || generation !== this.generation || !this.ownsAccountSession()) throw new DOMException('Recovery cancelled', 'AbortError');
    if (receipt.id !== item.id || receipt.roomId !== session.roomId || receipt.uploaderId !== session.member.id
      || receipt.filename !== item.file.name || receipt.byteLength !== item.file.size
      || receipt.mediaType !== (item.file.type || 'application/octet-stream') || !/^[a-f0-9]{64}$/.test(receipt.sha256)
      || item.expectedSha256 && receipt.sha256 !== item.expectedSha256)
      throw new Error('Saved file could not be verified');
    if (receipt.state !== 'staged' && !(pendingMessageId && receipt.messageId === pendingMessageId && ['committed', 'deleted'].includes(receipt.state)))
      throw new Error('File unavailable. Remove it and choose it again.');
    return receipt;
  }
  async uploadAttachment(id, file, { signal } = {}) {
    if (!validId(id) || !(file instanceof Blob) || typeof file.name !== 'string' || !file.name.trim()
      || file.size > 1048576) throw new Error('Choose a file up to 1 MiB');
    const session = this.session, generation = this.generation;
    const owns = () => this.session === session && this.generation === generation && this.ownsAccountSession();
    if (!session || !owns()) throw accountSessionError('Reopen the Room before uploading');
    const controller = new AbortController(); this.fileTransfers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 10000);
    const current = () => {
      if (!owns() || controller.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    };
    let reader;
    try {
      current();
      const bytes = new Uint8Array(await file.arrayBuffer()); current();
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      current();
      const mediaType = file.type || 'application/octet-stream';
      const response = await this.fetcher(`/api/rooms/${encodeURIComponent(session.roomId)}/attachments/${encodeURIComponent(id)}`, {
        method: 'PUT', credentials: 'same-origin', signal: controller.signal, body: bytes,
        headers: { 'Content-Type': mediaType, 'X-File-Name': encodeURIComponent(file.name),
          ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}),
          ...(session.sessionBinding ? { 'X-Session-Binding': session.sessionBinding } : {}),
          ...(session.authMode === 'account' ? { 'X-Project-Room-Auth': 'account' } : {}) }
      });
      current();
      if (!response.ok) { const error = new Error(response.status === 413 ? 'File is too large' : 'Upload failed. Retry the same file.'); error.status = response.status; throw error; }
      if (!response.body?.getReader) throw new Error('Upload receipt unavailable');
      reader = response.body.getReader();
      const chunks = []; let length = 0;
      while (true) {
        const { done, value } = await reader.read(); current();
        if (done) break;
        length += value.byteLength;
        if (length > 4096) throw new Error('Upload receipt is too large');
        chunks.push(value);
      }
      const raw = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
      const receipt = JSON.parse(new TextDecoder().decode(raw));
      if (receipt?.id !== id || receipt.roomId !== session.roomId || receipt.uploaderId !== session.member.id
        || receipt.filename !== file.name || receipt.mediaType !== mediaType || receipt.byteLength !== bytes.length
        || receipt.sha256 !== sha256 || !['staged', 'committed'].includes(receipt.state)
        || !Number.isSafeInteger(receipt.createdAt) || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt <= receipt.createdAt)
        throw new Error('Upload could not be verified. Retry the same file.');
      current(); return receipt;
    } finally {
      controller.abort();
      if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.fileTransfers.delete(controller);
    }
  }
  async downloadAttachment(file, { signal } = {}) {
    if (!validId(file?.id) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > 1048576
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new Error('Invalid file reference');
    const session = this.session, generation = this.generation;
    const owns = () => this.session === session && this.generation === generation && this.ownsAccountSession();
    if (!session || !owns()) throw accountSessionError('Reopen the Room before downloading');
    const controller = new AbortController();
    this.fileTransfers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 10000);
    let reader;
    try {
      const response = await this.fetcher(`/api/rooms/${encodeURIComponent(session.roomId)}/attachments/${encodeURIComponent(file.id)}`, {
        credentials: 'same-origin', signal: controller.signal,
        headers: { ...(session.sessionBinding ? { 'X-Session-Binding': session.sessionBinding } : {}),
          ...(session.authMode === 'account' ? { 'X-Project-Room-Auth': 'account' } : {}) }
      });
      if (!owns() || controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (!response.ok) {
        // Do not parse an unbounded error body or expose server-provided markup.
        const error = new Error(response.status === 404 ? 'File unavailable' : 'Download failed');
        error.status = response.status; throw error;
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== file.byteLength)) throw new Error('File size did not match');
      if (!response.body?.getReader) throw new Error('Download stream unavailable');
      reader = response.body.getReader();
      const bytes = new Uint8Array(file.byteLength);
      let offset = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (!owns() || controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
        if (done) break;
        if (!(value instanceof Uint8Array) || offset + value.length > bytes.length) throw new Error('File size did not match');
        bytes.set(value, offset); offset += value.length;
      }
      if (offset !== bytes.length) throw new Error('File size did not match');
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      if (!owns() || controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
      if (hash !== file.sha256) throw new Error('File could not be verified');
      return new Blob([bytes], { type: 'application/octet-stream' });
    } finally {
      controller.abort();
      if (reader) { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.fileTransfers.delete(controller);
    }
  }
  async restore(roomId = null) {
    this.disconnect(); this.sequence = 0; this.session = null; this.accountOwnership = null;
    const generation = this.generation;
    const accountMode = roomId !== null;
    const accountClient = accountMode ? this.accountClient : null;
    const accountSession = accountClient?.session ?? null;
    const accountGeneration = accountClient?.generation ?? null;
    if (accountMode && (!accountClient || !accountSession?.authenticated || !accountSession.account)) {
      throw accountSessionError("Restore and sign in to the account session before opening a Room");
    }
    try {
      const restored = await this.request(accountMode ? `/api/session?room=${encodeURIComponent(roomId)}` : "/api/session",
        accountMode ? { authMode: "account", authSession: accountSession } : {});
      if (generation !== this.generation) return null;
      if (accountMode && (accountClient !== this.accountClient || accountGeneration !== accountClient.generation || accountSession !== accountClient.session
        || restored?.authMode !== "account" || restored.roomId !== roomId || !sameAccountSession(restored, accountSession))) return null;
      this.session = restored;
      if (accountMode) this.accountOwnership = { client: accountClient, generation: accountGeneration, session: accountSession };
      await this.refresh();
      if (generation !== this.generation || this.session !== restored) return null;
      this.connect(); return this.session;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (accountMode && (accountClient !== this.accountClient || accountGeneration !== accountClient.generation || accountSession !== accountClient.session)) return null;
      // refresh() may already have exposed one snapshot before a coalesced follow-up
      // fails. Fail closed through the UI clearing callback whenever identity existed.
      if (this.session) this.endAccess();
      else { this.session = null; this.sequence = 0; }
      throw error;
    }
  }
  async login(accessKey) {
    this.disconnect(); this.sequence = 0; this.session = null; this.accountOwnership = null;
    const generation = this.generation;
    try {
      const loggedIn = await this.request("/api/session", { method: "POST", data: { accessKey } });
      if (generation !== this.generation) return null;
      this.session = loggedIn;
      await this.refresh();
      if (generation !== this.generation || this.session !== loggedIn) return null;
      this.connect(); return this.session;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (this.session) this.endAccess();
      else { this.session = null; this.sequence = 0; }
      throw error;
    }
  }
  async logout() {
    const generation = this.generation, session = this.session;
    if (session?.authMode === "account" && this.accountClient) {
      // Never let an old Room sign out the replacement identity now occupying the
      // shared account-session slot.
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      try {
        const loggedOut = await this.accountClient.logout();
        if (generation !== this.generation || this.session !== session) return null;
        this.endAccess();
        return loggedOut;
      } catch (error) {
        if (generation === this.generation && this.session === session && !this.ownsAccountSession()) this.endAccess();
        throw error;
      }
    }
    await this.request("/api/session", { method: "DELETE" });
    // A delayed response belongs only to the session that issued it. An access-ended
    // stream may already have exposed sign-in and allowed a different account to enter.
    if (generation === this.generation && this.session === session) this.endAccess();
  }
  path(suffix = "") { return `/api/rooms/${encodeURIComponent(this.session.roomId)}${suffix}`; }
  ownsAccountSession() {
    if (this.session?.authMode !== "account") return true;
    const owner = this.accountOwnership;
    return Boolean(owner && owner.client === this.accountClient && owner.generation === owner.client.generation && owner.session === owner.client.session
      && sameAccountSession(this.session, owner.session));
  }
  ownsResponse(payload, session = this.session) {
    return Boolean(session?.account && typeof session.account.id === "string" && Number.isSafeInteger(session.account.authEpoch) && typeof session.sessionBinding === "string")
      && (session.authMode !== "account" || this.ownsAccountSession())
      && payload.roomId === session.roomId
      && payload.viewerId === session.member.id
      && payload.viewerAccountId === session.account.id
      && payload.viewerAuthEpoch === session.account.authEpoch
      && payload.viewerSessionBinding === session.sessionBinding
      && (!Number.isSafeInteger(session.sessionRevision) || payload.viewerSessionRevision === session.sessionRevision);
  }
  refresh() {
    if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return Promise.resolve(); }
    const generation = this.generation;
    if (this.flight?.generation === generation) { this.flight.again = true; return this.flight.promise; }
    const flight = { generation, again: false };
    this.flight = flight;
    flight.promise = (async () => {
      try {
        do {
          flight.again = false;
          const snapshot = await this.request(this.path(), { offerContext: true });
          if (generation !== this.generation || !this.session) return;
          if (!this.ownsResponse(snapshot)) { this.endAccess(); return; }
          if (snapshot.sequence >= this.sequence) { this.sequence = snapshot.sequence; this.onSnapshot(snapshot, this.session); }
        } while (flight.again);
      } catch (error) {
        if (generation !== this.generation) return;
        if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return; }
        throw error;
      }
    })().finally(() => { if (this.flight === flight) this.flight = null; });
    return flight.promise;
  }
  async send(command) {
    if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); throw accountSessionError("Account session changed; reopen the Room before sending"); }
    const generation = this.generation;
    try {
      const receipt = await this.request(this.path("/commands"), { method: "POST", data: command });
      // A committed receipt remains a success even when the subsequent snapshot fetch fails.
      if (generation === this.generation && this.session) {
        if (!this.ownsAccountSession()) this.endAccess();
        else {
          try { await this.refresh(); } catch (error) { if (generation === this.generation) this.handleFailure(error); }
        }
      }
      return receipt;
    } catch (error) {
      if (generation === this.generation) {
        if (this.session?.authMode === "account" && !this.ownsAccountSession()) this.endAccess();
        else if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      }
      throw error;
    }
  }
  async replyContext(requestMessageId) {
    const session = this.session, generation = this.generation;
    if (!session || !this.ownsAccountSession()) throw new Error("Sign in again to read this request");
    const current = () => generation === this.generation && this.session === session && this.ownsAccountSession();
    let cursor = null, horizon = null, last = 0;
    const seen = new Set();
    for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
      const query = new URLSearchParams({ requestMessageId, limit: "50", ...(cursor ? { cursor } : {}) });
      const result = await this.request(this.path(`/reply-context?${query}`));
      if (!current()) throw new Error("Room identity changed");
      if (!this.ownsResponse(result, session)) { this.endAccess(); throw new Error("Room identity changed"); }
      const page = result?.page;
      const anchor = JSON.stringify([page?.horizonSequence, page?.horizonEventId]);
      if (result.contractVersion !== 1 || result.selection?.requestMessageId !== requestMessageId
        || result.request?.id !== requestMessageId || !page || !Array.isArray(page.items)
        || page.items.length > 50 || typeof page.hasMore !== "boolean"
        || !Number.isSafeInteger(page.horizonSequence) || page.horizonSequence < 1
        || page.cursor !== cursor || page.afterSequence !== last || horizon !== null && anchor !== horizon
        || page.items.some(item => item.requestMessageId !== requestMessageId
          || !Number.isSafeInteger(item.sequence) || item.sequence <= last || item.sequence > page.horizonSequence))
        throw new Error("Request context could not be confirmed. Refresh context");
      horizon = anchor;
      for (const item of page.items) {
        if (item.sequence <= last) throw new Error("Request context is out of order");
        last = item.sequence;
      }
      if (!page.hasMore) {
        if (page.nextCursor !== null) throw new Error("Request context is incomplete");
        return result;
      }
      if (!page.items.length || typeof page.nextCursor !== "string" || !page.nextCursor || seen.has(page.nextCursor))
        throw new Error("Request context did not advance");
      seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new Error("Request context is too large. Open a new request");
  }
  async caughtUp(sequence = this.sequence) {
    if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    const result = await this.request(this.path("/cursor"), { method: "POST", data: { sequence } });
    if (generation !== this.generation || this.session !== session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    return result;
  }
  async reminders(request = null) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const result = await this.request(this.path("/reminders"), request ? { method: "POST", data: request } : {});
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(result, session)) { this.endAccess(); return null; }
      return result;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async charter(revision) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    try {
      const value = await this.request(this.path(`/charter${revision === undefined ? "" : `?revision=${revision}`}`));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(value, session)) { this.endAccess(); return null; }
      validateCharterRead(value, session.roomId, revision);
      return value;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  async workResult(workItemId, { completionEventId = null, draftMessageId = null } = {}) {
    if (!this.session) return null;
    if (!this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session, params = new URLSearchParams({ workItemId });
    if (completionEventId !== null) params.set("completionEventId", completionEventId);
    if (draftMessageId !== null) params.set("draftMessageId", draftMessageId);
    try {
      const value = await this.request(this.path(`/work-result?${params}`));
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsResponse(value, session)) { this.endAccess(); return null; }
      await verifyWorkResult(value, { roomId: session.roomId, workItemId, completionEventId, draftMessageId });
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      return value;
    } catch (error) {
      if (generation !== this.generation || session !== this.session) return null;
      if (!this.ownsAccountSession()) { this.endAccess(); return null; }
      if ([401, 403].includes(error.status) || error.code === "session_binding_changed") this.handleFailure(error);
      throw error;
    }
  }
  // Return brief: history fixed through H (frozen on the first page, continuations carry it),
  // current live through N. Fetching never acknowledges; only caughtUp() does, explicitly.
  async returnBrief({ horizon = null, after = null, cursor = null, limit = null } = {}) {
    if (this.session?.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return null; }
    const generation = this.generation, session = this.session;
    const params = new URLSearchParams();
    if (horizon !== null) { params.set("horizon", horizon); params.set("after", after); params.set("cursor", cursor); }
    if (limit !== null) params.set("limit", limit);
    const query = params.toString();
    const brief = await this.request(this.path(`/return-brief${query ? `?${query}` : ""}`));
    if (generation !== this.generation || this.session !== session) return null;
    if (!this.ownsResponse(brief, session)) {
      this.endAccess();
      return null;
    }
    return brief;
  }
  connect() {
    clearTimeout(this.streamRetry); this.streamRetry = null;
    this.stream?.close();
    if (!this.events || !this.session) { this.onStatus("Manual refresh available; live updates unavailable"); return; }
    if (this.session.authMode === "account" && !this.ownsAccountSession()) { this.endAccess(); return; }
    const generation = this.generation, session = this.session;
    const stream = new this.events(`${this.path("/stream")}?after=${this.sequence}${this.session.authMode === "account" ? `&auth=account&binding=${encodeURIComponent(this.session.sessionBinding)}` : ""}`);
    this.stream = stream;
    const ownsStream = () => this.stream === stream && this.generation === generation && this.session === session;
    const refreshStream = () => this.refresh().catch(error => { if (ownsStream()) this.handleFailure(error); });
    stream.addEventListener("open", () => {
      if (!ownsStream()) return;
      this.streamRetryDelay = 1000;
      this.onStatus("Connected to room service · no peer read or processing receipt");
      refreshStream();
    });
    stream.addEventListener("room-event", () => {
      if (ownsStream()) refreshStream();
    });
    stream.addEventListener("access-ended", () => { if (ownsStream()) this.endAccess(); });
    stream.addEventListener("error", () => {
      if (!ownsStream()) return;
      this.onStatus("Reconnecting · displayed history may be stale");
      refreshStream();
      // Native retry handles CONNECTING, but HTTP refusals leave EventSource CLOSED.
      // Replace only that stream, with backoff and the same session ownership.
      if (ownsStream() && stream.readyState === 2 && !this.streamRetry) {
        this.streamRetry = setTimeout(() => {
          this.streamRetry = null;
          if (ownsStream()) this.connect();
        }, this.streamRetryDelay + Math.random() * this.streamRetryDelay / 4);
        this.streamRetryDelay = Math.min(this.streamRetryDelay * 2, 30000);
      }
    });
  }
  handleFailure(error) {
    if ([401, 403].includes(error.status) || (this.session?.authMode === "account" && error.code === "session_binding_changed")) this.endAccess();
    else this.onStatus("Connection interrupted · refresh to recover; no peer activity inferred");
  }
  disconnect() {
    for (const controller of this.fileTransfers) controller.abort();
    this.fileTransfers.clear();
    this.generation++; clearTimeout(this.streamRetry); this.streamRetry = null; this.streamRetryDelay = 1000;
    this.stream?.close(); this.stream = null;
  }
  endAccess() { this.disconnect(); this.session = null; this.sequence = 0; this.accountOwnership = null; this.onAccessEnded(); }
}

// The explicit name documents the legacy room-key session transport while RoomClient
// remains the stable public name used by the current application.
export { RoomClient as RoomSessionClient };

// Retain the ID for an unchanged retry, never blindly replay a changed revision or payload.
// Unknown commits stay locked across pre-ledger refusals (including rate/size
// limits). Only a rejection after exact retry lookup resolves an unknown original.
export function retryUnconfirmed(error, wasUnconfirmed = false) {
  const scopeRejected = (error.status === 409 && error.code === "claim_conflict")
    || (error.status === 422 && error.code === "invalid_claim_scope");
  const rejected = error.status >= 400 && error.status < 500
    && ["command_rejected", "invalid_command", "invalid_cause", "pilot_limit", "too_large"].includes(error.code);
  const originalRejected = ([409, 422].includes(error.status) && error.code === "command_rejected")
    || (error.status === 422 && error.code === "invalid_cause") || (error.status === 409 && error.code === "pilot_limit");
  return !(scopeRejected || (wasUnconfirmed ? originalRejected : rejected));
}

export function draftCommand(previous, type, data, causationId = null) {
  const contents = JSON.stringify({ type, data, causationId });
  return previous?.contents === contents ? previous : { contents, command: { id: crypto.randomUUID(), type, data, ...(causationId ? { causationId } : {}) } };
}
