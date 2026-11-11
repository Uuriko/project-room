// Keyword filter for one already-authorized room_read_messages page. It sees
// only what the page holds, so hidden or private history can't match, and
// the cursor still walks the same scanned window: an empty page may still
// have more history to search (follow next while hasMore).
export const MESSAGE_QUERY_MAX = 80;
export function validMessageQuery(query) {
  return typeof query === "string" && query.trim().length > 0 && query.length <= MESSAGE_QUERY_MAX;
}
export function filterMessagePage(page, query) {
  const needle = query.trim().toLocaleLowerCase();
  const matched = page.messages.filter(m => typeof m.body === "string" && m.body.toLocaleLowerCase().includes(needle));
  return { ...page, messages: matched, query: { text: query.trim(), scanned: page.messages.length, matched: matched.length } };
}
