// LOCAL TEST ONLY. Not exported by the production Worker.
import entry, { HttpTestRoom } from "../tests/cloudflare/http-worker.test-fixture.mjs";
import { seedDigestJournal } from "../scripts/digest-journal-fixture.mjs";
export class DigestTestRoom extends HttpTestRoom {
  async fetch(request) {
    if (new URL(request.url).pathname === "/__test-digest-journal") return Response.json(seedDigestJournal(this.store, 20000));
    return super.fetch(request);
  }
}
export default entry;
