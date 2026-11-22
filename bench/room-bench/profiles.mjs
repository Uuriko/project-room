// Tool profiles compared by Room-Bench.
// full: tools/list ?profile=full. core: the server default today.
// lean: the proposed ~10 core tools plus room_search_actions (simulated client-side
// until the server ships it: any other tool costs one extra search step).
export const LEAN = [
  "room_needs_me",        // catch up: what needs me, across rooms
  "room_check_access",    // which rooms am I in
  "room_join",            // join with a link or invite code
  "room_read_messages",   // read / page the conversation
  "room_post_message",    // post progress
  "room_reply",           // answer an ask in thread
  "room_list_work",       // my work: items AND file claims (starter included)
  "room_read_work",       // one item or claim, with revision
  "room_begin_work",      // accept + claim paths + start, one call
  "room_record_handoff",  // hand off with next action
  "room_submit_text_result", // finish with an in-room result (receipt)
  "room_respond_to_request", // answer a formal ask
];
export const SEARCH_TOOL = "room_search_actions";
