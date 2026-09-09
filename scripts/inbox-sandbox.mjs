// Explicit local sample launcher. Not part of the production runtime package.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { SyntheticInboxTransport } from "../server/inbox-transport.mjs";
import { SyntheticMailFixture } from "./synthetic-mail-fixture.mjs";

export async function createInboxSandbox() {
  const directory = mkdtempSync(join(tmpdir(), "project-room-inbox-sample-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const accountId = "sample-owner";
  store.createAccount(accountId); store.bindHumanAccount("commons", "owner", accountId);
  const accountKey = store.issueAccountAccessKey(accountId), slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, accountKey, 0);
  for (const [id, subject, paragraphs] of [
    ["launch", "A quieter launch", ["Could we make the launch note warmer?", "One clear next step would be perfect."]],
    ["weekend", "A small idea for the weekend", ["Want to sketch out something useful together?"]]
  ]) store.inbox.apply(slot.token, { action: "source.save", requestId: id, sourceId: id, expectedRevision: 0,
    data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject, paragraphs } }, session.sessionBinding);
  const provider = new SyntheticMailFixture(join(directory, "synthetic-mail.sqlite"));
  const server = createRoomServer({ store, syntheticInboxTransport: new SyntheticInboxTransport(store.inbox, provider) });
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
  catch (error) { provider.close(); store.close(); throw error; }
  return { directory, accountKey, url: "http://127.0.0.1:" + server.address().port + "/?room=commons",
    close: async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); provider.close(); store.close();
    } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--start") throw new Error("Explicit opt-in: node scripts/inbox-sandbox.mjs --start");
  const sample = await createInboxSandbox();
  console.log("Local sample only — no real messages or agents.");
  console.log(sample.url);
  console.log("Private sample sign-in key: " + sample.accountKey);
  console.log("Sample data retained at: " + sample.directory);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await sample.close(); process.exit(0); };
  process.on("SIGINT", close); process.on("SIGTERM", close);
}
