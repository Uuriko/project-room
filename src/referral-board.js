// Referral board: newest-first join graph, a plain leaderboard ranked by
// successful referrals, and the caller's own rows plus a "my referral link"
// mint-and-copy action. Member-visible; the API carries ids and display
// names only, no credential data.

import { mintInviteLink, inviteMintBody } from "./agent-invite-ui.js";
import { canInviteMembers } from "./events.js";

const $ = selector => document.querySelector(selector);

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

export function formatReferralWhen(completedAt) {
  const date = new Date(completedAt);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Pure view model for the board: newest-first rows (server-ordered),
// plain leaderboard ranking, and the caller's own rows. Tested without DOM.
export function referralBoardModel(data) {
  const referrals = data?.referrals ?? [];
  const leaderboard = data?.leaderboard ?? [];
  const mine = data?.myReferrals ?? [];
  return {
    count: referrals.length,
    myItems: mine.map(r => ({ referee: r.refereeDisplayName, when: formatReferralWhen(r.completedAt) })),
    leaderboard: leaderboard.map((entry, index) => ({ rank: index + 1, name: entry.displayName, count: entry.referralCount })),
    recent: referrals.slice(0, 20).map(r => ({ from: r.referrerDisplayName, to: r.refereeDisplayName, when: formatReferralWhen(r.completedAt) })),
  };
}

export function installReferralBoard({ client, getState, getSession }) {
  const panel = $("#referral-panel");
  const board = $("#referral-board");
  const button = $("#referral-link-button");
  const result = $("#referral-link-result");
  const myList = $("#referral-my-list"), myItems = $("#referral-my-items");
  const lbWrap = $("#referral-leaderboard-wrap"), lbList = $("#referral-leaderboard");
  const recentWrap = $("#referral-recent-wrap"), recentList = $("#referral-recent");
  const countChip = $("#referral-count");
  if (!panel || !board || !button) return { sync() {}, reset() {} };

  let loaded = false, busy = false, generation = 0;

  // "My referral link" mints through the protected agent-invite route: only
  // members with invite authority see the button. Everyone else still gets
  // the board, the leaderboard, and their own referrals.
  const canMintLink = () => Boolean(getSession() && getState()?.room?.id === getSession().roomId
    && canInviteMembers(getState(), getSession().member.id));
  function syncLinkButton() { if (button) button.hidden = !canMintLink(); }

  function status(text) { if (result) { result.hidden = !text; result.textContent = text ?? ""; } }

  function render(data) {
    const model = referralBoardModel(data);
    if (countChip) countChip.textContent = String(model.count);
    // My referrals.
    if (myList) myList.hidden = model.myItems.length === 0;
    if (myItems) myItems.innerHTML = model.myItems.map(r =>
      `<li>${escapeHtml(r.referee)} <span class="form-hint">joined ${escapeHtml(r.when)}</span></li>`).join("");
    // Plain leaderboard: rank by successful joins, most first.
    const leaderboard = data?.leaderboard ?? [];
    if (lbWrap) lbWrap.hidden = leaderboard.length === 0;
    if (lbList) lbList.innerHTML = model.leaderboard.map(entry =>
      `<li><span class="referral-rank">${entry.rank}.</span> ${escapeHtml(entry.name)} <span class="form-hint">${entry.count} referral${entry.count === 1 ? "" : "s"}</span></li>`).join("");
    // Newest-first join graph, server-ordered.
    if (recentWrap) recentWrap.hidden = model.count === 0;
    if (recentList) recentList.innerHTML = model.recent.map(r =>
      `<li>${escapeHtml(r.from)} <span aria-hidden="true">→</span> ${escapeHtml(r.to)} <span class="form-hint">${escapeHtml(r.when)}</span></li>`).join("");
  }

  async function load() {
    const session = getSession(), epoch = generation;
    if (!session || loaded || busy) return;
    const current = () => epoch === generation && getSession() === session;
    busy = true;
    try {
      const data = await client.request(client.path("/referrals"), { method: "GET" });
      if (current()) { render(data); loaded = true; }
    } catch {
      // The board is informational; a failed load leaves the panel quiet.
    } finally { if (current()) busy = false; }
  }

  async function mintMyLink() {
    const session = getSession(), epoch = generation;
    if (busy || !canMintLink()) return;
    const current = () => epoch === generation && getSession() === session;
    busy = true;
    status("Minting your referral link…");
    try {
      const roomId = session.roomId;
      const link = await mintInviteLink({
        requestBody: () => inviteMintBody("contribute", ""),
        mintOne: async body => {
          const created = await client.request(client.path("/agent-invites"), { method: "POST", data: body });
          if (created?.roomId !== roomId) throw new Error("Invite could not be confirmed.");
          return created;
        },
        locationLike: globalThis.location,
      });
      if (!current()) return;
      status("");
      const input = document.createElement("input");
      input.value = link.link;
      input.readOnly = true;
      input.setAttribute("aria-label", "Your referral link");
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "button secondary";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(link.link); copy.textContent = "Copied"; }
        catch { input.select(); copy.textContent = "Select and copy"; }
      });
      result.hidden = false;
      result.textContent = "";
      result.append(input, copy);
    } catch (error) {
      if (current()) status(error?.message ?? "Could not mint a referral link.");
    } finally { if (current()) busy = false; }
  }

  button.addEventListener("click", mintMyLink);
  panel.addEventListener("toggle", () => { if (panel.open) load(); });

  return {
    sync() { syncLinkButton(); if (panel.open) load(); },
    reset() { generation++; loaded = false; busy = false; syncLinkButton(); render(null); status(""); },
  };
}
