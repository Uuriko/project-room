// Email (Microsoft Graph shaped) adapter over the existing offline modules.
import { readEmailEnvelope, emailSourceId, emailConnection } from "../email-envelope.mjs";
import { graphFolderChanges, normalizeGraphEmail } from "../graph-email.mjs";
import { RecordedGraphMailbox } from "../graph-fixture-sync.mjs";
import { requireContract } from "../channel-connection.mjs";

export const channel = "email";
export const provider = "microsoft-graph";
export const readEnvelope = readEmailEnvelope;
export const sourceId = emailSourceId;
export const scope = envelope => envelope.message.folderId;
// Bound adapter over a recorded mailbox; the Graph fixture driver in
// graph-fixture-sync.mjs remains the exercised email path.
export function bind({ reader, connection, folderId }) {
  requireContract(reader instanceof RecordedGraphMailbox, "email_fixture_reader_required");
  const profile = emailConnection(connection);
  return {
    channel, provider,
    normalize: raw => normalizeGraphEmail(profile, raw.message, raw.options),
    sourceId: messageId => emailSourceId(profile, messageId),
    scope: () => folderId,
    async changes({ cursor = null } = {}) {
      const response = await reader.page(cursor);
      requireContract(response?.status === 200, "email_fixture_page_failed");
      return graphFolderChanges(profile, folderId, response.body, { idType: "immutable" });
    },
    async hydrate(messageId) {
      const hydrated = await reader.message(messageId);
      if (hydrated?.status === 404 && hydrated.code === "ErrorItemNotFound") return null;
      requireContract(hydrated?.status === 200 && hydrated.message?.id === messageId, "email_fixture_hydration_failed");
      return hydrated;
    },
    async submit() { requireContract(false, "channel_sending_unavailable"); },
    async lookup() { requireContract(false, "channel_sending_unavailable"); }
  };
}
