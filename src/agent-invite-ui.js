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

export const JOIN_LINK_CODE_PATTERN = /^RM-[A-Z0-9]+$/;
export const BULK_MINT_COUNTS = Object.freeze([1, 5, 10, 25]);

// Self-serve join link: the recipient opens it, reviews the invite, enters a
// name, and joins — no CLI, no docs. The code stays single-use and 24h.
export function agentInviteJoinLink(code, locationLike = globalThis.location) {
  if (!JOIN_LINK_CODE_PATTERN.test(code)) throw new Error("Invalid agent invite");
  const base = humanJoinShareBase(locationLike), url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || !["", "/", "/room"].includes(url.pathname)) throw new Error("Invalid Room address");
  return `${base}/join/${code}`;
}

export function agentInviteHandoff(code, locationLike = globalThis.location) {
  const link = agentInviteJoinLink(code, locationLike);
  return { link, code, text: `Join me in Project Room: ${link}\nOr from a Project Room runtime checkout, run:\nnode scripts/agent-inbox.mjs join ${JSON.stringify(link)} ./room-connection --name "My agent"\nReview the room and permissions, then repeat with --accept. Keep and reuse room-connection to resume or join another room. No human account is required. This connects room access; a running host is needed to answer requests.` };
}

// Mint one invite and build its self-serve join link. The caller loops for
// bulk mints so partial progress survives a later failure.
export async function mintInviteLink({ requestBody, mintOne, locationLike }) {
  const created = await mintOne(requestBody());
  if (typeof created?.code !== "string" || !JOIN_LINK_CODE_PATTERN.test(created.code)) throw new Error("Invite could not be confirmed.");
  const code = created.code;
  return { code, link: agentInviteJoinLink(code, locationLike) };
}

export function inviteLinksText(links) {
  return links.map(entry => entry.link).join("\n");
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
  const bulkCount = () => {
    const value = Number($("#agent-invite-count")?.value);
    return BULK_MINT_COUNTS.includes(value) ? value : 1;
  };

  function render() {
    button.hidden = !allowed();
    form.hidden = Boolean(minted);
    if (result) result.hidden = !minted;
    const single = Boolean(minted) && minted.length === 1;
    const bulk = Boolean(minted) && minted.length > 1;
    if ($("#agent-invite-single")) $("#agent-invite-single").hidden = !single;
    if ($("#agent-invite-bulk")) $("#agent-invite-bulk").hidden = !bulk;
    for (const input of form.querySelectorAll("input,select,button")) input.disabled = busy;
    if ($("#agent-invite-copy")) $("#agent-invite-copy").disabled = copying || !single;
    if ($("#agent-invite-copy-all")) $("#agent-invite-copy-all").disabled = copying || !bulk;
    if ($("#agent-invite-another")) $("#agent-invite-another").disabled = busy;
  }

  function renderLinks() {
    const list = $("#agent-invite-links");
    if (!list) return;
    list.textContent = "";
    for (const entry of minted ?? []) {
      const item = document.createElement("li");
      const input = document.createElement("input");
      input.type = "text"; input.readOnly = true; input.value = entry.link;
      input.setAttribute("aria-label", "Invite link");
      input.autocomplete = "off"; input.spellcheck = false;
      item.appendChild(input);
      list.appendChild(item);
    }
  }

  function resetForm() {
    minted = null;
    const instructions = dialog.querySelector(".agent-invite-instructions"); if (instructions) instructions.open = false;
    form.reset();
    if ($("#agent-invite-profile")) $("#agent-invite-profile").value = "contribute";
    if ($("#agent-invite-count")) $("#agent-invite-count").value = "1";
    if ($("#agent-invite-code")) $("#agent-invite-code").value = "";
    if ($("#agent-invite-share")) $("#agent-invite-share").textContent = "";
    renderLinks();
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

  async function copyText(text, doneMessage) {
    if (!owns() || copying) return;
    copying = true; render();
    try {
      const write = navigator.clipboard?.writeText?.(text);
      if (!write) throw new Error("clipboard");
      await Promise.race([write, new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard")), 800))]);
      if (owns()) status(doneMessage);
    } catch {
      if (owns()) status("Select and copy the invite link(s).");
    } finally { copying = false; render(); }
  }

  async function mint(event) {
    event.preventDefault();
    if (!owns() || busy || minted) return;
    const count = bulkCount();
    let profile, name;
    try {
      profile = $("#agent-invite-profile")?.value; name = $("#agent-invite-name")?.value;
      inviteMintBody(profile, name); // validates before any mint
    } catch (error) { status(error.message); return; }
    busy = true; status(count === 1 ? "Minting…" : `Minting 1 of ${count}…`); render();
    const roomId = getSession().roomId;
    const links = [];
    try {
      for (let index = 0; index < count; index++) {
        if (count > 1) status(`Minting ${index + 1} of ${count}…`);
        const link = await mintInviteLink({
          requestBody: () => inviteMintBody(profile, count === 1 ? name : name?.trim() ? `${name.trim()} ${index + 1}` : ""),
          mintOne: async body => {
            const created = await client.request(client.path("/agent-invites"), { method: "POST", data: body });
            if (created?.roomId !== roomId) throw new Error("Invite could not be confirmed.");
            return created;
          },
          locationLike: globalThis.location,
        });
        links.push(link);
      }
      if (!owns()) return;
      minted = links;
      if (count === 1) {
        if ($("#agent-invite-code")) $("#agent-invite-code").value = links[0].link;
        if ($("#agent-invite-share")) $("#agent-invite-share").textContent = agentInviteHandoff(links[0].code).text;
      } else {
        renderLinks();
        if ($("#agent-invite-share")) $("#agent-invite-share").textContent = inviteLinksText(links);
      }
      status(count === 1 ? "Invite ready. Copy the link and give it to your agent." : `${count} invites ready. Copy the links — each works once.`);
    } catch (error) {
      if (!owns()) return;
      // A failed mint keeps the links that already succeeded.
      if (links.length) {
        minted = links;
        if (count === 1) {
          if ($("#agent-invite-code")) $("#agent-invite-code").value = links[0].link;
          if ($("#agent-invite-share")) $("#agent-invite-share").textContent = agentInviteHandoff(links[0].code).text;
        } else {
          renderLinks();
          if ($("#agent-invite-share")) $("#agent-invite-share").textContent = inviteLinksText(links);
        }
        status(`${links.length} of ${count} invites ready; the next mint failed (${typeof error.message === "string" && error.message.length <= 120 ? error.message : "error"}). Copy what you have.`);
      } else {
        status(typeof error.message === "string" && error.message.length <= 180
          ? error.message
          : "Could not mint. Owner or invite_member; codes stay agent-safe.");
      }
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
  dialog.addEventListener("close", () => { if (!busy) resetForm(); });
  form.addEventListener("submit", mint);
  $("#agent-invite-copy")?.addEventListener("click", () => {
    if (minted?.length === 1) void copyText(minted[0].link, "Copied the invite link. Share it with your agent.");
  });
  $("#agent-invite-copy-all")?.addEventListener("click", () => {
    if (minted?.length > 1) void copyText(inviteLinksText(minted), `Copied ${minted.length} invite links. Share them with your agents.`);
  });
  $("#agent-invite-another")?.addEventListener("click", () => { if (!busy) resetForm(); });
  render();
  return { sync, reset };
}
