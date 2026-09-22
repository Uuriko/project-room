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
// Each card also shows the shadow enforcement-hold context: whether
// auto-quarantine would actually have held the message under enforcement
// (score ≥ threshold, no hard gate blocked) or which gate blocked it. The
// shadow precision report measures over reviewed would-be holds only, so
// this line tells the reviewer what their verdict means for the report.
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
  // Hard-gate names (policy §2.3) in the reviewer's words: the precision
  // report measures over reviewed would-be holds, so a blocked card's
  // verdict labels differently (false_negative / true_negative) than a
  // would-hold card's (true/false positive).
  const gateLabel = { allowlisted: "owner allowlist", existingThread: "existing-thread reply",
    verifiedConnector: "verified connector", serviceNotification: "service notification",
    flagOnlyChannel: "flag-only channel" };
  let epoch = 0, busy = new Set(), armed = new Set();
  // The card a verdict was given from, so refresh() can put focus back there.
  let focusAfterVerdict = -1;
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
    el.hidden = true; // Keep a new inbox focused on connection and reading.
    el.id = "inbox-quarantine"; el.className = "inbox-quarantine"; el.setAttribute("aria-label", "Quarantine review");
    const header = document.createElement("header"); header.className = "inbox-quarantine-header";
    const heading = document.createElement("h2"); heading.className = "form-hint"; heading.textContent = "Quarantine review";
    const count = document.createElement("span"); count.id = "inbox-quarantine-count"; count.className = "inbox-channel-badge";
    const filter = document.createElement("select"); filter.id = "inbox-quarantine-status"; filter.setAttribute("aria-label", "Review status");
    for (const [value, label] of [["held", "Held"], ["released", "Released"], ["dismissed", "Dismissed"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; filter.append(option);
    }
    // A status change replaces the whole list, so the cards on screen are
    // about to stop belonging to the selected view. Clear them first: they
    // carry Confirm / Dismiss / Split, and a reviewer who acts on one during
    // the fetch is acting on a message that is not in the list they chose.
    filter.addEventListener("change", () => { if (owns()) refresh({ clear: true }); });
    const reload = document.createElement("button"); reload.type = "button"; reload.className = "button ghost";
    // Identified, not found by position: the coverage panel is prepended below
    // and carries its own header button, so "the first header button in this
    // section" resolves to the coverage one. refresh() was holding that button
    // and leaving this one live, so the review list had no busy state at all
    // and every impatient click started another fetch.
    reload.id = "inbox-quarantine-reload";
    reload.textContent = "↻"; reload.setAttribute("aria-label", "Refresh quarantine review");
    reload.addEventListener("click", () => { if (owns() && !reload.disabled) refresh(); });
    header.append(heading, count, filter, reload);
    const status = document.createElement("p"); status.id = "inbox-quarantine-status-line"; status.className = "form-hint"; status.setAttribute("role", "status");
    const list = document.createElement("div"); list.id = "inbox-quarantine-list";
    el.append(header, status, list);
    // Review-coverage dashboard (GET /api/inbox/quarantine/coverage): the
    // per-signal coverage panel rides inside the review section, above the
    // held list, so it refreshes and resets with the review surface.
    el.prepend(coverageSection());
    $("#inbox-connections").before(el);
    return el;
  }
  const pct = r => r === null ? "—" : `${Math.round(r * 100)}%`;
  // Review-coverage dashboard panel: account totals plus one row per signal
  // that fired on a held row, least-covered first (the server sorts). The
  // coverage-gap list calls out signals firing on live holds with no owner
  // verdict yet. Read-only; no PII beyond the signal keys the review list
  // already shows.
  function coverageSection() {
    let el = $("#inbox-quarantine-coverage");
    if (el) return el;
    el = document.createElement("section");
    el.id = "inbox-quarantine-coverage"; el.className = "inbox-quarantine-coverage"; el.setAttribute("aria-label", "Review coverage");
    const header = document.createElement("header"); header.className = "inbox-quarantine-header";
    const heading = document.createElement("h2"); heading.className = "form-hint"; heading.textContent = "Review coverage";
    const reload = document.createElement("button"); reload.type = "button"; reload.className = "button ghost";
    reload.textContent = "↻"; reload.setAttribute("aria-label", "Refresh review coverage");
    reload.addEventListener("click", () => { if (owns() && !reload.disabled) refreshCoverage(); });
    header.append(heading, reload);
    const summary = document.createElement("p"); summary.id = "inbox-quarantine-coverage-summary"; summary.className = "form-hint";
    const gap = document.createElement("p"); gap.id = "inbox-quarantine-coverage-gap"; gap.className = "inbox-quarantine-warning"; gap.hidden = true;
    const table = document.createElement("table"); table.id = "inbox-quarantine-coverage-table"; table.className = "inbox-quarantine-coverage-table";
    el.append(header, summary, gap, table);
    return el;
  }
  function coverageRow(signal) {
    const row = document.createElement("tr");
    const cell = value => { const td = document.createElement("td"); td.textContent = value; return td; };
    const key = document.createElement("th"); key.scope = "row"; key.textContent = signal.key;
    row.append(key,
      cell(String(signal.held)), cell(String(signal.reviewed)), cell(pct(signal.reviewCoverage)),
      cell(String(signal.confirmed)), cell(String(signal.dismissed)), cell(String(signal.split)),
      cell(signal.avgScore === null ? "—" : String(signal.avgScore)));
    return row;
  }
  function renderCoverage(report) {
    coverageSection();
    const t = report.totals;
    section().hidden = t.total === 0;
    const summary = $("#inbox-quarantine-coverage-summary");
    if (t.total === 0) {
      summary.textContent = "No quarantined messages yet — nothing to measure coverage over.";
    } else {
      summary.textContent = `${t.held} held · ${t.reviewed} reviewed of ${t.total} total · ${pct(t.reviewCoverage)} coverage — `
        + `${t.confirmed} confirmed, ${t.dismissed} dismissed, ${t.split} split.`;
    }
    const gap = $("#inbox-quarantine-coverage-gap");
    if (report.zeroCoverageSignals.length) {
      gap.hidden = false;
      gap.textContent = `Coverage gap: no owner verdict yet on live holds carrying ${report.zeroCoverageSignals.join(", ")}.`;
    } else {
      gap.hidden = true; gap.textContent = "";
    }
    const table = $("#inbox-quarantine-coverage-table");
    table.replaceChildren();
    if (report.perSignal.length) {
      const head = document.createElement("tr");
      for (const label of ["Signal", "Held", "Reviewed", "Coverage", "Confirmed", "Dismissed", "Split", "Avg score"]) {
        const th = document.createElement("th"); th.scope = "col"; th.textContent = label; head.append(th);
      }
      const thead = document.createElement("thead"); thead.append(head);
      const tbody = document.createElement("tbody");
      tbody.append(...report.perSignal.map(coverageRow));
      table.append(thead, tbody);
      table.hidden = false;
    } else {
      table.hidden = true;
    }
  }
  async function refreshCoverage(turn = epoch) {
    const el = coverageSection();
    if (!owns()) return;
    const reload = el.querySelector("header button");
    reload.disabled = true;
    try {
      const report = await api.quarantineCoverage();
      if (!owns() || turn !== epoch) return;
      renderCoverage(report);
    } catch (error) {
      if (owns() && turn === epoch)
        text("#inbox-quarantine-status-line", "Couldn’t load review coverage. Try again.");
    } finally {
      if (owns() && turn === epoch) reload.disabled = false;
    }
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
    // Enforcement-hold context: would auto-quarantine actually have held
    // this message, or did a hard gate block it? The shadow precision
    // report counts only reviewed would-be holds, so this line tells the
    // reviewer what their verdict means for the report.
    const shadowLine = document.createElement("p"); shadowLine.className = "form-hint";
    const shadow = item.shadow ?? null;
    if (shadow === null) {
      shadowLine.textContent = "No shadow decision recorded for this import — whether enforcement would hold it is unknown.";
    } else if (shadow.wouldHold) {
      shadowLine.textContent = `Auto-quarantine would hold this message (policy ${shadow.policyVersion ?? "unknown"}, threshold ${shadow.threshold ?? 60}).`;
    } else if (shadow.gateBlock) {
      shadowLine.textContent = `Auto-quarantine would not hold — blocked by the ${gateLabel[shadow.gateBlock] ?? shadow.gateBlock} gate.`;
    } else {
      shadowLine.textContent = "Auto-quarantine would not hold (shadow score below the hold threshold).";
    }
    card.append(shadowLine);
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
      note.dataset.quarantineNote = item.id;
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
      for (const [button, role] of [[confirm, "release"], [dismiss, "dismiss"], [split, "split"]]) {
        button.dataset.quarantineId = item.id; button.dataset.quarantineAction = role;
      }
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
    // Disabling the focused button blurs it, so by the time the list is
    // rebuilt focus has already fallen to the page body. Remember where the
    // reviewer was working first, and let refresh() put them back there.
    const list = $("#inbox-quarantine-list");
    if (list?.contains(document.activeElement)) {
      focusAfterVerdict = [...list.children].findIndex(card => card.contains(document.activeElement));
    }
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
    } finally {
      busy.delete(id);
      // A failure leaves the card on screen, and the status line tells the
      // reviewer to try again. Re-enable so that advice is actionable: without
      // this the only way back was the section reload or a filter change.
      // On success the card has already been replaced by the refresh above, so
      // these buttons belong to a detached node and this changes nothing.
      for (const button of buttons) button.disabled = false;
      // On a failure nothing was rebuilt, so refresh() never restored focus:
      // give it back to the card the reviewer was working in.
      if (focusAfterVerdict >= 0 && (document.activeElement === document.body || !document.activeElement)) {
        buttons.find(button => button.isConnected && !button.disabled)?.focus();
      }
      focusAfterVerdict = -1;
    }
  }
  async function refresh({ silent = false, clear = false } = {}) {
    const el = section();
    if (!owns()) return;
    const turn = ++epoch;
    const status = $("#inbox-quarantine-status").value;
    const reload = el.querySelector("#inbox-quarantine-reload");
    if (!silent) { reload.disabled = true; text("#inbox-quarantine-status-line", "Loading…"); }
    // Only on a status change: a plain reload keeps the same view's cards so
    // the list does not blink on every refresh.
    if (clear) { armed.clear(); $("#inbox-quarantine-list").replaceChildren(); }
    // The coverage panel refreshes with the review list, so a Confirm /
    // Dismiss / Split lands in the numbers on the same pass. It reads its
    // own endpoint; a failure there must not break the review list.
    refreshCoverage(turn);
    try {
      const result = await api.quarantine({ status });
      if (!owns() || turn !== epoch) return;
      if (result.items.length) el.hidden = false;
      armed.clear(); // Fresh cards rebuild the buttons; a stale arm would skip the two-tap guard.
      text("#inbox-quarantine-count", `${result.counts.held} held`);
      // Every card is rebuilt here, and a reviewer working down a backlog has
      // usually typed into more than one of them. Carry the typed notes and
      // the focused control across the rebuild, the way the room timeline
      // does with data-focus-key: before this, confirming card A silently
      // threw away the note half-written on card B, and every verdict dropped
      // keyboard focus to the page body.
      const list = $("#inbox-quarantine-list");
      const notes = new Map([...list.querySelectorAll("input[data-quarantine-note]")]
        .filter(input => input.value).map(input => [input.dataset.quarantineNote, input.value]));
      const active = list.contains(document.activeElement) ? document.activeElement : null;
      const focusIndex = active ? [...list.children].findIndex(card => card.contains(active)) : focusAfterVerdict;
      focusAfterVerdict = -1;
      const focusSelector = active?.dataset.quarantineNote ? `input[data-quarantine-note="${CSS.escape(active.dataset.quarantineNote)}"]`
        : active?.dataset.quarantineAction ? `button[data-quarantine-id="${CSS.escape(active.dataset.quarantineId)}"][data-quarantine-action="${active.dataset.quarantineAction}"]`
        : null;
      list.replaceChildren(
        ...result.items.map(itemCard),
        ...(!result.items.length ? [Object.assign(document.createElement("p"), { className: "form-hint", textContent:
          status === "held" ? "No messages held. The spam guard files tripped messages here for your review." : `No ${status} messages.` })] : []));
      for (const [id, value] of notes) {
        const input = list.querySelector(`input[data-quarantine-note="${CSS.escape(id)}"]`);
        if (input) input.value = value;
      }
      if (active || focusIndex >= 0) {
        // The same control if it survived; otherwise the card that moved into
        // the place of the one just decided, so the next Tab continues the
        // backlog instead of restarting at the top of the page.
        const same = focusSelector ? list.querySelector(focusSelector) : null;
        const next = list.children[Math.min(Math.max(focusIndex, 0), list.children.length - 1)];
        (same ?? next?.querySelector("input, button:not([disabled])") ?? null)?.focus();
      }
      if (!silent) text("#inbox-quarantine-status-line", "");
    } catch (error) {
      if (owns() && turn !== epoch) return;
      if (owns()) { el.hidden = false; text("#inbox-quarantine-status-line", "Couldn’t load the quarantine review. Try again."); }
    } finally { if (owns() && turn === epoch) reload.disabled = false; }
  }
  function reset() {
    epoch++; busy.clear(); armed.clear(); focusAfterVerdict = -1;
    $("#inbox-quarantine")?.remove();
  }
  return { refresh, reset, section };
}
