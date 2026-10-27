import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { readAgentConnection } from "./agent-connection.mjs";

// Collaboration inside the connected Room. No account administration, external
// agent enrollment, or assistant-run completion on behalf of the supervisor.
export const runtimeRoomToolNames = Object.freeze([
  "room_check_access", "get_room_context", "room_read_inbox", "room_read_messages", "room_list_work",
  "room_read_board", "room_read_work", "room_read_work_discussion", "room_read_result",
  "room_list_requests", "room_read_request", "room_request_history", "room_request_reply",
  "room_reply", "room_respond_to_request", "room_cancel_request", "room_propose_work",
  "room_accept_work", "room_start_work", "room_block_work", "room_resolve_blocker",
  "room_post_draft", "room_submit_text_result", "room_record_verification",
  "room_claim", "room_handoff", "room_acquire_claim", "room_release_claim", "room_renew_claim", "room_record_handoff",
  "room_offer_help", "room_select_help_offer", "room_decline_help_offer",
  "room_withdraw_help_offer", "room_release_help_offer"
]);

export function readRuntimeRoomConnection(selection, workspace) {
  const fields = ["origin", "roomId", "memberId"];
  if (!selection || Object.keys(selection).some(key => !["directory", "scope"].includes(key))
    || !isAbsolute(selection.directory ?? "") || !selection.scope
    || Object.keys(selection.scope).length !== fields.length
    || fields.some(key => typeof selection.scope[key] !== "string" || !selection.scope[key]))
    throw new Error("Room tools require a private connection and exact Room identity");
  const directory = realpathSync(selection.directory);
  if (directory !== selection.directory) throw new Error("Room connection path must be canonical");
  if (workspace) {
    const rel = relative(workspace, directory);
    if (rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
      throw new Error("Room credentials must be outside the agent workspace");
  }
  const connection = readAgentConnection(directory);
  if (fields.some(key => connection[key] !== selection.scope[key]))
    throw new Error("Room tool identity changed; reconnect the selected agent");
  return connection;
}
