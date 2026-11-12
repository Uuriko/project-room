// Synthetic provisioning only; never deployed.
import entry, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
export class DocsTestRoom extends ProjectRoom {
  async fetch(request) {
    if (new URL(request.url).pathname === '/__test-docs-seed') {
      for (const id of ['commons', 'other']) if (!this.store.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(id)) this.store.initialize(initialRoom(id));
      return Response.json({ key: this.store.issueAccessKey('commons', 'owner'), otherKey: this.store.issueAccessKey('other', 'owner') });
    }
    return super.fetch(request);
  }
}
export default entry;
