import { canInviteMembers } from "./events.js";
import { publicRoomDeepLink } from "./room-deep-link.js";

const $ = selector => document.querySelector(selector);

// Owner-minted collaborate shape. invite_member-only issuers cannot grant steer;
// they should mint contribute. Server profile name "collaborate" may land with
// bootstrap-agent-room; explicit permissions work on today's live profiles.
export const COLLABORATE_PERMISSIONS = Object.freeze(["steer", "accept_work", "complete_work", "verify"]);

export function inviteMintBody(profile, displayName) {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (name.length > 80) throw new Error("Name must be 80 characters or fewer.");
  const extra = name ? { displayName: name } : {};
  if (profile === "collaborate") return { permissions: [...COLLABORATE_PERMISSIONS], ...extra };
  if (profile === "contribute" || profile === "review" || profile === "chat") return { profile, ...extra };
  throw new Error("Choose contribute, collaborate, or review.");
}

export function installAgentInvites({ client, getState, getSession }) {
  const dialog = $("#agent-invite-dialog");
  const form = $("#agent-invite-form");
  const result = $("#agent-invite-result");
  const button = $("#invite-agents-button");
  if (!dialog || !form || !button) return { sync() {}, reset() {} };

  let owner = null, generation = null, busy = false, copying = false, minted = null;
  const member = () => getState()?.members[getSession()?.member?.id];
  const allowed = () => Boolean(getSession() && getState()?.room?.id === getSession().roomId
    && canInviteMembers(getState(), getSession().member.id));
  const owns = () => allowed() && owner === getSession() && generation === client.generation
    && member()?.id === getSession()?.member?.id;
  const status = text => { if ($("#agent-invite-status")) $("#agent-invite-status").textContent = text; };

  function render() {
    button.hidden = !allowed();
    form.hidden = Boolean(minted);
    if (result) result.hidden = !minted;
    for (const input of form.querySelectorAll("input,select,button")) input.disabled = busy;
    if ($("#agent-invite-copy")) $("#agent-invite-copy").disabled = copying || !minted;
    if ($("#agent-invite-another")) $("#agent-invite-another").disabled = busy;
  }

  function resetForm() {
    minted = null;
    form.reset();
    if ($("#agent-invite-profile")) $("#agent-invite-profile").value = "contribute";
    if ($("#agent-invite-code")) $("#agent-invite-code").value = "";
    if ($("#agent-invite-share")) $("#agent-invite-share").textContent = "";
    status("");
    render();
  }

  function reset() {
    owner = null; generation = null; busy = false; copying = false;
    resetForm();
    if (dialog.open) dialog.close();
  }

  function sync() {
    if (owner && !owns()) reset();
    else render();
  }

  async function copyCode() {
    if (!owns() || !minted || copying) return;
    copying = true; render();
    try {
      const write = navigator.clipboard?.writeText?.(minted.code);
      if (!write) throw new Error("clipboard");
      await Promise.race([write, new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard")), 800))]);
      if (owns()) status("Copied. Shown once — peer redeem-invite. No Room key in chat.");
    } catch {
      if (owns()) status("Select and copy the code. Shown once.");
    } finally { copying = false; render(); }
  }

  async function mint(event) {
    event.preventDefault();
    if (!owns() || busy || minted) return;
    let body;
    try { body = inviteMintBody($("#agent-invite-profile")?.value, $("#agent-invite-name")?.value); }
    catch (error) { status(error.message); return; }
    busy = true; status("Minting…"); render();
    try {
      const created = await client.request(client.path("/agent-invites"), { method: "POST", data: body });
      if (!owns()) return;
      if (typeof created?.code !== "string" || !created.code.startsWith("RM-") || created.roomId !== getSession().roomId) {
        throw new Error("Invite could not be confirmed.");
      }
      minted = created;
      if ($("#agent-invite-code")) $("#agent-invite-code").value = created.code;
      if ($("#agent-invite-share")) {
        const link = publicRoomDeepLink(created.roomId);
        $("#agent-invite-share").textContent = link
          ? `Peer redeem-invite with this code. Deep-link: ${link}`
          : "Peer redeem-invite with this code.";
      }
      status("Invite minted. Copy it now — the code is shown once. Agent-safe only.");
    } catch (error) {
      if (!owns()) return;
      status(typeof error.message === "string" && error.message.length <= 180
        ? error.message
        : "Could not mint. Owner or invite_member; codes stay agent-safe.");
    } finally { if (owns()) { busy = false; render(); } }
  }

  button.addEventListener("click", () => {
    if (!allowed()) return;
    if (!owner) { owner = getSession(); generation = client.generation; }
    if (!owns()) { reset(); return; }
    if (!minted) resetForm();
    render();
    dialog.showModal();
    $("#agent-invite-profile")?.focus();
  });
  $("#agent-invite-close")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { if (!busy) { minted = null; if ($("#agent-invite-code")) $("#agent-invite-code").value = ""; } });
  form.addEventListener("submit", mint);
  $("#agent-invite-copy")?.addEventListener("click", () => { void copyCode(); });
  $("#agent-invite-another")?.addEventListener("click", () => { if (!busy) resetForm(); });
  render();
  return { sync, reset };
}
