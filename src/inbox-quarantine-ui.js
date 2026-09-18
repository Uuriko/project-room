// Quarantine review surface: the owner's held-message backlog. The
// auto-quarantine policy (docs/AUTO-QUARANTINE-POLICY.md §3) requires this
// screen before any enforcement: one list of held messages with their score,
// the exact signals that fired (plain-language details, so the owner sees
// *why*), sender, channel, and age; one-tap Confirm / Dismiss / Split per
// item, with an optional review note. The section is built here so no static
// markup changes are needed (same pattern as the read toggle and the search
// form in inbox-ui.js); it is mounted inside the inbox panel sidebar by
// installInbox and refreshes whenever the inbox list loads.
//
// Confirm accepts the message into the inbox (owner verdict: not spam).
// Dismiss drops the review item as spam — the record stays for audit, and
// the message stays out of the inbox read paths. Split separates the held
// message off its thread; the review state stays held, so a split item
// still needs Confirm or Dismiss.
//
// Honest scope: a verdict is a visibility change for the main inbox views
// (server/inbox.mjs quarantinedSourceIds): held and dismissed messages are
// held out of list/search/threads/read, released messages return. The
// review surface itself stays the only view that shows held/dismissed rows.
// Dismiss arms on the first click (two deliberate taps, like the
// connection "Remove" flow) — a dismissal is a verdict, not a glance.
export function installQuarantineReview({ api, ownerKey }) {
  const $ = selector => document.querySelector(selector);
  const text = (selector, value) => { $(selector).textContent = value; };
  const owns = () => ownerKey() !== null;
  const channelLabel = { email: "Email", telegram: "Telegram", whatsapp: "WhatsApp" };
  let epoch = 0, busy = new Set(), armed = new Set();
  const ageOf = at => {
    const ms = Date.now() - at;
    if (ms < 60000) return "just now";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "1d ago" : `${days}d ago`;
  };
  // Built once, like the search form: the section lives in the inbox
  // sidebar between the message list and the connections cards.
  function section() {
    let el = $("#inbox-quarantine");
    if (el) return el;
    el = document.createElement("section");
    el.id = "inbox-quarantine"; el.className = "inbox-quarantine"; el.setAttribute("aria-label", "Quarantine review");
    const header = document.createElement("header"); header.className = "inbox-quarantine-header";
    const heading = document.createElement("h2"); heading.className = "form-hint"; heading.textContent = "Quarantine review";
    const count = document.createElement("span"); count.id = "inbox-quarantine-count"; count.className = "inbox-channel-badge";
    const filter = document.createElement("select"); filter.id = "inbox-quarantine-status"; filter.setAttribute("aria-label", "Review status");
    for (const [value, label] of [["held", "Held"], ["released", "Released"], ["dismissed", "Dismissed"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; filter.append(option);
    }
    filter.addEventListener("change", () => { if (owns()) refresh(); });
    const reload = document.createElement("button"); reload.type = "button"; reload.className = "button ghost";
    reload.textContent = "↻"; reload.setAttribute("aria-label", "Refresh quarantine review");
    reload.addEventListener("click", () => { if (owns() && !reload.disabled) refresh(); });
    header.append(heading, count, filter, reload);
    const status = document.createElement("p"); status.id = "inbox-quarantine-status-line"; status.className = "form-hint"; status.setAttribute("role", "status");
    const list = document.createElement("div"); list.id = "inbox-quarantine-list";
    el.append(header, status, list);
    $("#inbox-connections").before(el);
    return el;
  }
  function scoreBadge(score) {
    const badge = document.createElement("span");
    badge.className = "inbox-channel-badge"; badge.textContent = `Score ${score}/100`;
    badge.title = "Spam score 0–100; the hold threshold is 60.";
    return badge;
  }
  function itemCard(item) {
    const card = document.createElement("article"); card.className = "inbox-quarantine-item"; card.dataset.quarantineId = item.id;
    const head = document.createElement("div"); head.className = "inbox-quarantine-head";
    const sender = document.createElement("strong"); sender.textContent = item.sender ?? "(unknown sender)";
    const badge = document.createElement("span"); badge.className = "inbox-channel-badge"; badge.textContent = channelLabel[item.channel] ?? item.channel;
    const age = document.createElement("span"); age.className = "form-hint"; age.textContent = ageOf(item.quarantinedAt);
    head.append(sender, badge, scoreBadge(item.score), age);
    card.append(head);
    if (item.subject) { const subject = document.createElement("p"); subject.className = "inbox-quarantine-subject"; subject.textContent = item.subject; card.append(subject); }
    if (item.excerpt) { const excerpt = document.createElement("p"); excerpt.className = "inbox-quarantine-excerpt"; excerpt.textContent = "“" + item.excerpt + "”"; card.append(excerpt); }
    const reasons = document.createElement("ul"); reasons.className = "inbox-quarantine-reasons";
    for (const reason of item.reason) {
      const entry = document.createElement("li");
      entry.textContent = `${reason.detail} (+${reason.weight})`;
      entry.title = `Signal ${reason.key}`;
      reasons.append(entry);
    }
    card.append(reasons);
    const meta = document.createElement("p"); meta.className = "form-hint";
    const metaParts = [`Held ${new Date(item.quarantinedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`];
    if (item.split) metaParts.push(`Split off its thread ${ageOf(item.split.splitAt)} by ${item.split.reviewer}${item.split.reason ? ` — ${item.split.reason}` : ""}`);
    if (item.status !== "held") metaParts.push(`${item.status === "released" ? "Confirmed" : "Dismissed"} by ${item.reviewedBy ?? "unknown"}${item.reviewedAt ? " · " + ageOf(item.reviewedAt) : ""}${item.note ? ` — ${item.note}` : ""}`);
    meta.textContent = metaParts.join(" · ");
    card.append(meta);
    if (item.status === "held") {
      const note = document.createElement("input");
      note.type = "text"; note.maxLength = 2048; note.placeholder = "Review note (optional)";
      note.setAttribute("aria-label", "Review note for " + item.id);
      const actions = document.createElement("div"); actions.className = "inbox-draft-actions";
      const confirm = document.createElement("button"); confirm.type = "button"; confirm.className = "button secondary"; confirm.textContent = "Confirm";
      confirm.title = "Accept this message into the inbox (owner verdict: not spam).";
      const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.className = "button ghost"; dismiss.textContent = "Dismiss";
      dismiss.title = "Drop this message as spam. The record stays for audit.";
      const split = document.createElement("button"); split.type = "button"; split.className = "button ghost";
      split.textContent = "Split";
      split.title = item.split ? "Already split off its thread."
        : "Separate this message off its native thread. The message stays held for review.";
      split.disabled = Boolean(item.split);
      confirm.addEventListener("click", () => act(item.id, "release", note.value, [confirm, dismiss, split]));
      dismiss.addEventListener("click", () => {
        if (!armed.has(item.id)) { armed.add(item.id); dismiss.textContent = "Dismiss?"; dismiss.focus(); return; }
        armed.delete(item.id); act(item.id, "dismiss", note.value, [confirm, dismiss, split]);
      });
      split.addEventListener("click", () => act(item.id, "split", note.value, [confirm, dismiss, split]));
      actions.append(confirm, dismiss, split);
      card.append(note, actions);
    }
    return card;
  }
  async function act(id, action, noteText, buttons) {
    if (!owns() || busy.has(id)) return;
    const note = noteText.trim() ? noteText.trim() : null;
    // A split reason is 256 chars at most (the note box allows 2048 for
    // release/dismiss verdicts) — say so up front instead of failing the
    // split with a generic 422.
    if (action === "split" && note !== null && note.length > 256) {
      text("#inbox-quarantine-status-line", "Split reasons are 256 characters at most — shorten the note.");
      return;
    }
    busy.add(id); armed.delete(id);
    for (const button of buttons) button.disabled = true;
    text("#inbox-quarantine-status-line", { release: "Confirming…", dismiss: "Dismissing…", split: "Splitting thread…" }[action]);
    try {
      if (action === "release") await api.quarantineRelease(id, note);
      else if (action === "dismiss") await api.quarantineDismiss(id, note);
      else await api.quarantineSplit(id, note);
      if (owns()) await refresh({ silent: true });
    } catch (error) {
      if (owns()) text("#inbox-quarantine-status-line",
        error.code === "quarantine_already_reviewed" ? "Already reviewed — refresh to see the current state."
        : error.code === "quarantine_already_split" ? "Already split off its thread."
        : error.code === "quarantine_not_held" ? "Only held messages can be split."
        : "Couldn’t complete that action. Try again.");
    } finally { busy.delete(id); }
  }
  async function refresh({ silent = false } = {}) {
    const el = section();
    if (!owns()) return;
    const turn = ++epoch;
    const status = $("#inbox-quarantine-status").value;
    const reload = el.querySelector("header button");
    if (!silent) { reload.disabled = true; text("#inbox-quarantine-status-line", "Loading…"); }
    try {
      const result = await api.quarantine({ status });
      if (!owns() || turn !== epoch) return;
      armed.clear(); // Fresh cards rebuild the buttons; a stale arm would skip the two-tap guard.
      text("#inbox-quarantine-count", `${result.counts.held} held`);
      $("#inbox-quarantine-list").replaceChildren(
        ...result.items.map(itemCard),
        ...(!result.items.length ? [Object.assign(document.createElement("p"), { className: "form-hint", textContent:
          status === "held" ? "No messages held. The spam guard files tripped messages here for your review." : `No ${status} messages.` })] : []));
      if (!silent) text("#inbox-quarantine-status-line", "");
    } catch (error) {
      if (owns() && turn !== epoch) return;
      if (owns()) text("#inbox-quarantine-status-line", "Couldn’t load the quarantine review. Try again.");
    } finally { if (owns() && turn === epoch) reload.disabled = false; }
  }
  function reset() {
    epoch++; busy.clear(); armed.clear();
    $("#inbox-quarantine")?.remove();
  }
  return { refresh, reset, section };
}
