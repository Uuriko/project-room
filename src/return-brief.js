// Own both successes and failures by session and by one pagination chain.
// A new refresh always replaces the chain, even when its horizon is unchanged.
export class ReturnBrief {
  constructor(client, { onChange = () => {}, onError = () => {} } = {}) {
    Object.assign(this, { client, onChange, onError });
    this.chain = null;
    this.brief = null;
    this.message = "";
  }
  owner() {
    const { generation, session } = this.client;
    return session ? { generation, room: session.roomId, viewer: session.member.id } : null;
  }
  owns(chain) {
    const owner = this.owner();
    return Boolean(chain && chain === this.chain && owner && Object.keys(owner).every(key => owner[key] === chain.owner[key]));
  }
  get busy() { return Boolean(this.chain?.loading || this.chain?.acknowledging); }
  reset() { this.chain = null; this.brief = null; this.message = ""; this.onChange(); }
  refresh() {
    const owner = this.owner();
    if (!owner) { this.reset(); return Promise.resolve(); }
    this.brief = null;
    const chain = this.chain = { owner, loading: true };
    this.message = "Loading your catch-up…";
    this.onChange();
    return this.fetchPage(chain);
  }
  more() {
    const chain = this.chain;
    if (!chain || !this.owns(chain)) { this.reset(); return Promise.resolve(); }
    if (this.busy) return chain.flight || Promise.resolve();
    const continuation = this.brief?.history.continuation;
    if (!continuation) return Promise.resolve();
    chain.loading = true;
    this.message = "Loading more changes…";
    this.onChange();
    return this.fetchPage(chain, continuation);
  }
  fetchPage(chain, continuation = null) {
    chain.flight = (async () => {
      try {
        const page = await this.client.returnBrief(continuation || {});
        if (!this.owns(chain)) return;
        if (page.roomId !== chain.owner.room || page.viewerId !== chain.owner.viewer) {
          this.client.endAccess();
          this.reset();
          return;
        }
        if (continuation) {
          const history = this.brief.history;
          if (history.continuation !== continuation || page.history.evaluatedThrough !== history.evaluatedThrough || page.history.cursor !== history.cursor) {
            throw new Error("The catch-up page changed. Refresh your catch-up to continue.");
          }
          let previous = continuation.after;
          for (const item of page.history.items) {
            if (item.sequence <= previous || item.sequence > history.evaluatedThrough) throw new Error("The catch-up page is out of order. Refresh to continue.");
            previous = item.sequence;
          }
          if (page.history.hasMore && (!page.history.items.length || page.history.continuation?.after !== previous)) throw new Error("The catch-up page did not advance. Refresh to continue.");
          this.brief = { ...page, history: { ...page.history, items: [...history.items, ...page.history.items] } };
        } else this.brief = page;
        this.message = "";
      } catch (error) {
        if (!this.owns(chain)) return;
        if (continuation && error.code === "cursor_changed") {
          await this.refresh();
          return;
        }
        this.message = "Catch-up could not load. Retry when connected.";
        this.onError(error);
      } finally {
        if (this.owns(chain)) { chain.loading = false; chain.flight = null; this.onChange(); }
      }
    })();
    return chain.flight;
  }
  acknowledge() {
    const chain = this.chain;
    if (!chain || !this.owns(chain) || this.busy || !this.brief) return Promise.resolve();
    const horizon = this.brief.history.evaluatedThrough;
    if (horizon === this.brief.history.cursor) return Promise.resolve();
    chain.acknowledging = true;
    this.message = "Saving your caught-up position…";
    this.onChange();
    return (async () => {
      let saved = false;
      try {
        await this.client.caughtUp(horizon); // Exactly H. Events arriving after H remain new.
        if (!this.owns(chain)) return;
        saved = true;
        await this.client.refresh();
        if (!this.owns(chain)) return;
        await this.refresh();
      } catch (error) {
        if (!this.owns(chain)) return;
        this.message = saved ? "Position saved. Refresh to see the latest changes." : "Saving could not be confirmed. Refresh to check your position before retrying.";
        this.onError(error);
      } finally {
        if (this.owns(chain)) { chain.acknowledging = false; this.onChange(); }
      }
    })();
  }
}
