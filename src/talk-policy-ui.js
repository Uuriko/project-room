// #5384: who can wake an agent by mention or DM. Owner-only control in People.
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const TALK_POLICY_LABELS = Object.freeze({
  owner: "Only me and my agents",
  members: "Chosen members",
  room: "Anyone in the room",
  nobody: "Nobody",
});
export function talkPolicySelect(memberId, policy) {
  const current = Object.hasOwn(TALK_POLICY_LABELS, policy) ? policy : "room";
  // "members" needs an allow-list picker that does not exist yet; show it only when already set via the API.
  const options = Object.entries(TALK_POLICY_LABELS).filter(([value]) => value !== "members" || current === "members")
    .map(([value, label]) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`).join("");
  return `<label class="talk-policy">Who can talk to it<select data-talk-policy="${esc(memberId)}">${options}</select></label>`;
}
