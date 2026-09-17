// LOCAL TEST ONLY: exposes the bootstrap outcome of the real ProjectRoom
// constructor so bootstrap.check.mjs can prove an expired or malformed operator
// window is logged and skipped instead of failing every request. Never deploy.
import entry, { ProjectRoom } from './room.mjs';

const warnings = [];
const warn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); warn(...args); };

export class BootstrapTestRoom extends ProjectRoom {
  fetch(request) {
    if (new URL(request.url).pathname === '/__test-bootstrap-state') {
      return Response.json({
        rooms: this.store.db.prepare('SELECT count(*) n FROM rooms').get().n,
        credentials: this.store.db.prepare('SELECT count(*) n FROM credentials').get().n,
        warnings: warnings.filter(line => line.includes('Operator bootstrap skipped')).length
      });
    }
    return super.fetch(request);
  }
}
export default entry;
