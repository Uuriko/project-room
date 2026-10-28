// Per-session ordering for read positions. Writes to one conversation complete
// in intent order; reads wait for prior writes and cannot repaint newer intent.
// This coordinates this client, not concurrent writes from another device.
export class ReadPositionOrder {
  constructor() { this.scopes = new Map(); }

  operation(key, request, write) {
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = { revision: 0, tail: Promise.resolve() };
      this.scopes.set(key, scope);
    }
    const revision = ++scope.revision;
    const result = scope.tail.then(request);
    if (write) scope.tail = result.catch(() => {});
    return { result, current: () => scope.revision === revision };
  }

  read(key, request) { return this.operation(key, request, false); }
  write(key, request) { return this.operation(key, request, true); }
}
