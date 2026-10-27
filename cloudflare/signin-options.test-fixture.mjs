// LOCAL TEST ONLY: wraps the production Room entry with a Durable Object
// subclass that counts how many requests actually reach the object's
// fetch(). The signin-options parity check uses the count as its zero-DO
// evidence: a Worker-served answer must leave it untouched. The count is
// read back over DO RPC, which constructs the object but never calls
// fetch(), so reading it cannot pollute the measurement.
import entry, { ProjectRoom } from "./room.mjs";

let fetches = 0;

export class SigninOptionsTestRoom extends ProjectRoom {
  async fetch(request) {
    fetches += 1;
    return super.fetch(request);
  }

  signinOptionsFetchCount() {
    return fetches;
  }
}

export default entry;
