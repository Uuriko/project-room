import { uiText } from "./strings.js";
// One selected pair, not a second room cache. Replacements discard older pages;
// identity/selection changes make in-flight responses inert.
export function createDirectConversationWindow({ read, changed = () => {} }) {
  let epoch = 0, selected = null, identity = null, wanted = null, attempted = null;
  let anchor = null, anchorMessage = null, anchorAttempted = null;
  let messages = [], cursor = null, checkpoint = null, error = null, loading = false;
  const view = () => ({ peerMemberId: selected, messages, anchorMessage, cursor, error, loading });
  function select(peerMemberId, boundary) {
    if (selected === peerMemberId && identity === boundary) return;
    epoch++; selected = peerMemberId; identity = boundary;
    anchor = anchorMessage = anchorAttempted = null;
    wanted = attempted = null; messages = []; cursor = checkpoint = error = null; loading = false;
  }
  async function load(older = false) {
    if (!selected || loading || older && !cursor) return;
    const ticket = epoch, peerMemberId = selected, sequence = wanted, selectedAnchor = anchor;
    const previousCursor = cursor;
    loading = true; error = null; attempted = sequence; anchorAttempted = selectedAnchor; changed(view());
    try {
      let page = await read({ peerMemberId, limit: 50, ...(older ? { cursor } : checkpoint ? { since: checkpoint } : {}) });
      if (ticket !== epoch) return;
      if (page.mode === 'reset') {
        // One explicit restart. Never recursively walk history or retry resets.
        page = await read({ peerMemberId, limit: 50 });
        if (ticket !== epoch) return;
        older = false;
      }
      if (page.mode === 'reset') throw new Error(uiText("direct.changedAgain"));
      let nextAnchor = page.messages?.find(message => message.id === selectedAnchor) ?? null;
      if (selectedAnchor && !nextAnchor) {
        try {
          const selectedPage = await read({ peerMemberId, messageId: selectedAnchor, limit: 1 });
          if (ticket !== epoch) return;
          nextAnchor = selectedPage.messages?.[0] ?? null;
        } catch (cause) {
          if (ticket !== epoch) return;
          if (cause.status !== 404) throw cause;
        }
      }
      if (anchor === selectedAnchor) anchorMessage = nextAnchor;
      if (page.mode === 'replace') {
        if (older && page.nextCursor === previousCursor) throw new Error(uiText("direct.pageStalled"));
        messages = older ? [...new Map([...page.messages, ...messages].map(message => [message.id, message])).values()] : page.messages;
        cursor = page.nextCursor;
        if (!older) checkpoint = page.checkpoint;
      }
    } catch (cause) {
      if (ticket === epoch) error = cause;
    } finally {
      if (ticket === epoch) {
        loading = false; changed(view());
        if (wanted !== sequence || anchor !== selectedAnchor) void load();
      }
    }
  }
  return {
    select, view,
    pin(messageId) { anchor = messageId; if (!messageId) anchorMessage = null; },
    sync(sequence) { wanted = sequence; if (!loading && (attempted !== sequence || anchorAttempted !== anchor)) void load(); },
    older: () => load(true),
    retry: () => load(),
    clear: () => select(null, null),
  };
}

// A deep link retains only its target and ancestry, never an unrelated page.
// Every snapshot change revalidates the selection; late account/link reads die.
export function createMessageSelection({ read, changed = () => {} }) {
  let epoch = 0, selected = null, boundary = null, wanted = null, attempted = null;
  let messages = [], error = null, loading = false;
  const view = () => ({ messages, error, loading });
  async function load() {
    if (!selected || loading) return;
    const ticket = epoch, sequence = wanted;
    loading = true; attempted = sequence; error = null;
    try {
      const records = [], seen = new Set();
      let id = selected, head = null;
      while (id) {
        if (seen.has(id) || records.length >= 32) throw new Error(uiText('direct.unavailableThread'));
        seen.add(id);
        const page = await read({ messageId: id, limit: 1 });
        if (ticket !== epoch) return;
        if (head !== null && head !== page.sequence) throw new Error(uiText('direct.changedAgain'));
        head = page.sequence;
        const message = page.messages?.[0];
        if (page.mode !== 'replace' || message?.id !== id) throw new Error(uiText('direct.unavailableThread'));
        records.unshift(message); id = message.replyToId;
      }
      messages = records;
    } catch (cause) {
      if (ticket === epoch) { messages = []; error = cause; }
    } finally {
      if (ticket === epoch) {
        loading = false; changed(view());
        if (wanted !== sequence) void load();
      }
    }
  }
  function select(id, identity) {
    if (selected === id && boundary === identity) return;
    epoch++; selected = id; boundary = identity;
    messages = []; error = null; loading = false; wanted = attempted = null;
  }
  return { view, select,
    sync(sequence) { wanted = sequence; if (attempted !== sequence) void load(); },
    clear() { select(null, null); },
  };
}

export function createConversationDirectory({ read, changed = () => {} }) {
  let epoch = 0, identity = null, wanted = null, attempted = null;
  let peers = [], cursor = null, error = null, loading = false;
  const view = () => ({ peers, cursor, error, loading });
  async function load(more = false) {
    if (identity === null || loading || more && !cursor) return;
    const ticket = epoch, sequence = wanted, previous = cursor;
    attempted = sequence; loading = true; error = null; changed();
    try {
      let page = await read({ limit: 50, cursor: more ? cursor : null });
      if (ticket !== epoch) return;
      if (page.mode === 'reset') { page = await read({ limit: 50 }); more = false; }
      if (ticket !== epoch) return;
      if (page.mode === 'reset' || more && page.nextCursor === previous) throw new Error(uiText('direct.changedAgain'));
      peers = more ? [...new Map([...peers, ...page.peers].map(peer => [peer.memberId, peer])).values()] : page.peers;
      cursor = page.nextCursor;
    } catch (cause) { if (ticket === epoch) { error = cause; if (!more) { peers = []; cursor = null; } } }
    finally {
      if (ticket === epoch) {
        loading = false; changed();
        if (wanted !== sequence) void load();
      }
    }
  }
  return { view,
    sync(boundary, sequence) {
      if (identity !== boundary) { epoch++; identity = boundary; wanted = attempted = null; peers = []; cursor = error = null; loading = false; }
      wanted = sequence; if (attempted !== sequence) void load();
    },
    more: () => load(true), retry: () => load(),
    clear() { epoch++; identity = wanted = attempted = null; peers = []; cursor = error = null; loading = false; }
  };
}
