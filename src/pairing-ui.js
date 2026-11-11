const $ = selector => document.querySelector(selector);

export function installPairing({ client, getState }) {
  const section = $("#agent-pairs");
  const list = $("#agent-pair-list");
  if (!section || !list) return { refresh() {} };
  const can = () => {
    const member = getState()?.members?.[client.session?.member?.id];
    return member?.active !== false && (member?.id === getState()?.room?.ownerId
      || member?.permissions?.includes("invite_member")
      || member?.permissions?.includes("manage_members"));
  };
  async function refresh() {
    if (!can() || !client.session?.roomId) { section.hidden = true; list.replaceChildren(); return; }
    try {
      const body = await client.request(client.path("/pairs"));
      const pairs = body.pairs ?? [];
      list.replaceChildren();
      section.hidden = pairs.length === 0;
      for (const pair of pairs) list.append(row(pair));
    } catch { section.hidden = true; }
  }
  function row(pair) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = pair.displayName;
    item.append(name);
    if (pair.userCode) {
      const code = document.createElement("code");
      code.textContent = pair.userCode;
      item.append(code);
    }
    if (pair.possibleDuplicate) {
      const flag = document.createElement("span");
      flag.textContent = "Possible duplicate";
      item.append(flag);
    }
    const decide = (decision, reconnect) => client.request(client.path(`/pairs/${encodeURIComponent(pair.pairId)}/decide`), {
      method: "POST", data: { decision, reconnect, profile: "contribute" }
    }).then(() => refresh());
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "button";
    approve.textContent = "Approve";
    approve.addEventListener("click", () => { void decide("approve", false); });
    item.append(approve);
    if (pair.possibleDuplicate) {
      const reconnect = document.createElement("button");
      reconnect.type = "button";
      reconnect.className = "button";
      reconnect.textContent = "Reconnect";
      reconnect.addEventListener("click", () => { void decide("approve", true); });
      item.append(reconnect);
    }
    const deny = document.createElement("button");
    deny.type = "button";
    deny.textContent = "Deny";
    deny.addEventListener("click", () => { void decide("deny", false); });
    item.append(deny);
    return item;
  }
  document.getElementById("agent-connect-dialog")?.addEventListener("toggle", () => { if ($("#agent-connect-dialog")?.open) void refresh(); });
  return { refresh };
}
