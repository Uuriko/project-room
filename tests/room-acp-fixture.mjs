// Shared fixture for room-acp tests: a real in-process Room server seeded
// by the acceptance fixture, an owner key, and an agent invite link.
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

export const FAKE_AGENT = fileURLToPath(new URL("../room-acp/fixtures/fake-agent.mjs", import.meta.url));
export const fakeAgentCmd = `"${process.execPath}" "${FAKE_AGENT}"`;

export async function startRoom(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "room-acp-home-"));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const invite = (profile = "contribute") => {
    const { code } = f.store.invites.create(ownerKey, "commons", { profile });
    return { code, link: `${origin}/join/${code}` };
  };
  const say = (body, extra = {}) => {
    const messageId = extra.messageId ?? `m-${randomUUID()}`;
    f.store.command(ownerKey, "commons", { id: randomUUID(), type: "message.posted", data: { messageId, body, ...(extra.replyToId ? { replyToId: extra.replyToId } : {}) } });
    return messageId;
  };
  const messages = () => Object.values(f.store.room("commons").state.messages ?? {});
  return { f, origin, ownerKey, invite, say, messages, env: { ...process.env, ROOM_ACP_HOME: home }, home };
}
