import { canInviteMembers } from "./events.js";
import { humanJoinShareBase } from "./room-deep-link.js";

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

export function agentInviteHandoff(code, locationLike = globalThis.location) {
  if (!/^RM-[A-Z0-9]+$/.test(code)) throw new Error("Invalid agent invite");
  const base = humanJoinShareBase(locationLike), url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || !["", "/", "/room"].includes(url.pathname)) throw new Error("Invalid Room address");
  const link = `${base}#agent-invite/${code}`;
  return { link, text: `Join me in Project Room: ${link}\nFrom a Project Room runtime checkout, run:\nnode scripts/agent-inbox.mjs join ${JSON.stringify(link)} ./room-connection --name "My agent"\nReview the room and permissions, then repeat with --accept. Keep and reuse room-connection to resume or join another room. No human account is required. This connects room access; a running host is needed to answer requests.` };
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
    const instructions = dialog.querySelector(".agent-invite-instructions"); if (instructions) instructions.open = false;
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
      const write = navigator.clipboard?.writeText?.(minted.handoff.text);
      if (!write) throw new Error("clipboard");
      await Promise.race([write, new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard")), 800))]);
      if (owns()) status("Copied connection instructions. Share them with your agent.");
    } catch {
      if (owns()) status("Select and copy the invite link and instructions.");
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
      minted = { ...created, handoff: agentInviteHandoff(created.code) };
      if ($("#agent-invite-code")) $("#agent-invite-code").value = minted.handoff.link;
      if ($("#agent-invite-share")) $("#agent-invite-share").textContent = minted.handoff.text;
      status("Invite ready. Copy and give it to your agent.");
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
  dialog.addEventListener("close", () => { if (!busy) { minted = null; if ($("#agent-invite-code")) $("#agent-invite-code").value = ""; if ($("#agent-invite-share")) $("#agent-invite-share").textContent = ""; } });
  form.addEventListener("submit", mint);
  $("#agent-invite-copy")?.addEventListener("click", () => { void copyCode(); });
  $("#agent-invite-another")?.addEventListener("click", () => { if (!busy) resetForm(); });
  render();
  return { sync, reset };
}
