export class RoomClient {
  constructor({ fetcher = globalThis.fetch.bind(globalThis), events = globalThis.EventSource, onSnapshot = () => {}, onStatus = () => {}, onAccessEnded = () => {} } = {}) {
    Object.assign(this, { fetcher, events, onSnapshot, onStatus, onAccessEnded });
    this.session = null;
    this.sequence = 0;
    this.generation = 0;
  }
  async request(path, { method = "GET", data } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetcher(path, { method, credentials: "same-origin", signal: controller.signal,
        headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...(this.session?.csrf ? { "X-CSRF-Token": this.session.csrf } : {}) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const body = await response.json();
      if (!response.ok) { const error = new Error(body.error?.message || "Request failed"); error.status = response.status; error.code = body.error?.code; throw error; }
      return body;
    } finally { clearTimeout(timer); }
  }
  async restore() { this.disconnect(); this.sequence = 0; this.session = await this.request("/api/session"); await this.refresh(); this.connect(); return this.session; }
  async login(accessKey) {
    this.disconnect(); this.sequence = 0;
    this.session = await this.request("/api/session", { method: "POST", data: { accessKey } });
    await this.refresh(); this.connect(); return this.session;
  }
  async logout() {
    await this.request("/api/session", { method: "DELETE" });
    this.endAccess();
  }
  path(suffix = "") { return `/api/rooms/${encodeURIComponent(this.session.roomId)}${suffix}`; }
  refresh() {
    const generation = this.generation;
    if (this.flight?.generation === generation) { this.flight.again = true; return this.flight.promise; }
    const flight = { generation, again: false };
    this.flight = flight;
    flight.promise = (async () => {
      do {
        flight.again = false;
        const snapshot = await this.request(this.path());
        if (generation !== this.generation || !this.session) return;
        if (snapshot.viewerId !== this.session.member.id) { this.endAccess(); return; }
        if (snapshot.sequence >= this.sequence) { this.sequence = snapshot.sequence; this.onSnapshot(snapshot, this.session); }
      } while (flight.again);
    })().finally(() => { if (this.flight === flight) this.flight = null; });
    return flight.promise;
  }
  async send(command) {
    const generation = this.generation;
    try {
      const receipt = await this.request(this.path("/commands"), { method: "POST", data: command });
      // A committed receipt remains a success even when the subsequent snapshot fetch fails.
      if (generation === this.generation && this.session) {
        try { await this.refresh(); } catch (error) { if (generation === this.generation) this.handleFailure(error); }
      }
      return receipt;
    } catch (error) { if (generation === this.generation && [401, 403].includes(error.status)) this.handleFailure(error); throw error; }
  }
  async caughtUp(sequence = this.sequence) { return this.request(this.path("/cursor"), { method: "POST", data: { sequence } }); }
  // Return brief: history fixed through H (frozen on the first page, continuations carry it),
  // current live through N. Fetching never acknowledges; only caughtUp() does, explicitly.
  async returnBrief({ horizon = null, after = null, limit = null } = {}) {
    const params = new URLSearchParams();
    if (horizon !== null) { params.set("horizon", horizon); params.set("after", after); }
    if (limit !== null) params.set("limit", limit);
    const query = params.toString();
    return this.request(this.path(`/return-brief${query ? `?${query}` : ""}`));
  }
  connect() {
    this.stream?.close();
    if (!this.events || !this.session) { this.onStatus("Manual refresh available; live updates unavailable"); return; }
    const stream = new this.events(`${this.path("/stream")}?after=${this.sequence}`);
    this.stream = stream;
    stream.addEventListener("open", () => {
      if (this.stream !== stream) return;
      this.onStatus("Connected to room service · no peer read or processing receipt");
      this.refresh().catch(error => this.handleFailure(error));
    });
    stream.addEventListener("room-event", () => {
      if (this.stream === stream) this.refresh().catch(error => this.handleFailure(error));
    });
    stream.addEventListener("access-ended", () => { if (this.stream === stream) this.endAccess(); });
    stream.addEventListener("error", () => {
      if (this.stream !== stream) return;
      this.onStatus("Reconnecting · displayed history may be stale");
      this.refresh().catch(error => this.handleFailure(error));
    });
  }
  handleFailure(error) {
    if ([401, 403].includes(error.status)) this.endAccess();
    else this.onStatus("Connection interrupted · refresh to recover; no peer activity inferred");
  }
  disconnect() { this.generation++; this.stream?.close(); this.stream = null; }
  endAccess() { this.disconnect(); this.session = null; this.sequence = 0; this.onAccessEnded(); }
}

// Retain the ID for an unchanged retry, never blindly replay a changed revision or payload.
export function draftCommand(previous, type, data, causationId = null) {
  const contents = JSON.stringify({ type, data, causationId });
  return previous?.contents === contents ? previous : { contents, command: { id: crypto.randomUUID(), type, data, ...(causationId ? { causationId } : {}) } };
}
