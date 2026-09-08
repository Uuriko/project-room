// LOCAL TEST ONLY: public Room entrypoint never exports this provisioning route.
import entry, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
export class HttpTestRoom extends ProjectRoom {
  fetch(request) {
    if (new URL(request.url).pathname === '/__test-provision') {
      this.store.initialize(initialRoom());
      return Response.json({ ownerKey: this.store.issueAccessKey('commons', 'owner') });
    }
    return super.fetch(request);
  }
}
export default entry;
