import { measureHost, doctorText } from "./measure.mjs";
import { identitySecret } from "./room.mjs";
import { postMessage } from "./room.mjs";
import { loadConfig } from "./config.mjs";

export async function doctorReport({ home, origin, roomId, secret } = {}) {
  const config = loadConfig(home);
  const facts = await measureHost();
  const body = doctorText(facts);
  const token = secret ?? await identitySecret(home);
  const targetOrigin = origin ?? config.roomOrigin;
  const targetRoom = roomId ?? config.roomId;
  if (!token || !targetOrigin || !targetRoom) return { ok: false, error: "not_enrolled", body };
  const posted = await postMessage(targetOrigin, targetRoom, token, body);
  return { ok: posted.ok, status: posted.status, body, facts };
}
