import { uiText } from "./strings.js";

const $ = selector => document.querySelector(selector);
const ACCESS = [
  ["open", "publicAgent.open"],
  ["knock", "publicAgent.knock"],
  ["closed", "publicAgent.closed"],
];
const STATUS = {
  knock: "publicAgent.statusKnock",
  open: "publicAgent.statusOpen",
  answered: "publicAgent.statusAnswered",
  rejected: "publicAgent.statusRejected",
};

const segments = (...parts) => parts.join("");
const httpUrl = value => {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch { return ""; }
};

export function installPublicAgentPages({ client, getState }) {
  const button = $("#public-agent-open");
  const dialog = $("#public-agent-dialog");
  const root = $("#public-agent-root");
  const statusEl = $("#public-agent-status");
  const close = $("#public-agent-close");
  if (!button || !dialog || !root || !statusEl || !close) return { sync() {} };

  let key = null;
  let flight = 0;
  let busyToken = 0;
  let pages = [];
  let asks = new Map();
  let suppressClose = false;

  const roomKey = () => {
    const state = getState();
    const roomId = state?.room?.id;
    const memberId = client.session?.member?.id;
    if (!roomId || !memberId || roomId !== client.session?.roomId) return "";
    return [client.generation, roomId, memberId].join(":");
  };
  const roomId = () => client.session.roomId;
  const listPath = () => segments("/api/rooms/", encodeURIComponent(roomId()), "/public-agent");
  const pagePath = memberId => segments(listPath(), "/", encodeURIComponent(memberId));
  const asksPath = memberId => segments(pagePath(memberId), "/asks");
  const actPath = (memberId, askId) => segments(asksPath(memberId), "/", encodeURIComponent(askId));
  const say = text => { statusEl.textContent = text; };
  const own = token => token === flight;

  function applyBusy() {
    const busy = busyToken !== 0;
    const controls = [
      ...root.querySelectorAll("button"),
      ...root.querySelectorAll("input"),
      ...root.querySelectorAll("select"),
      ...root.querySelectorAll("textarea"),
    ];
    for (const control of controls) {
      if (busy) { control.disabled = true; continue; }
      if (control.dataset.needs === "page") {
        const section = control.closest("section");
        const access = section.querySelector("select");
        const slug = section.querySelector("input[name=slug]");
        control.disabled = !access.value || !slug.value.trim();
      } else if (control.dataset.needs === "answer") {
        const answer = control.closest("article").querySelector("textarea");
        control.disabled = !answer.value.trim();
      } else control.disabled = false;
    }
  }
  function begin() {
    const token = ++flight;
    busyToken = token;
    applyBusy();
    return token;
  }
  function end(token) {
    if (busyToken !== token) return;
    busyToken = 0;
    applyBusy();
  }
  function label(keyName, control) {
    const node = document.createElement("label");
    node.append(document.createTextNode(uiText(keyName)), control);
    return node;
  }
  function check(keyName, control) {
    const node = document.createElement("label");
    node.className = "check";
    node.append(control, document.createTextNode(uiText(keyName)));
    return node;
  }
  function actionButton(keyName, onClick, ghost = false) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = ghost ? "button ghost" : "button secondary";
    node.textContent = uiText(keyName);
    node.addEventListener("click", () => { void onClick(); });
    return node;
  }
  function waitingCount(rows) {
    return rows.filter(ask => ask.status === "knock" || ask.status === "open").length;
  }
  function renderAsk(page, ask) {
    const block = document.createElement("article");
    const question = document.createElement("p");
    question.textContent = typeof ask.question === "string" ? ask.question : "";
    block.append(question);
    if (typeof ask.from === "string" && ask.from.trim()) {
      const from = document.createElement("p");
      from.className = "form-hint";
      from.textContent = uiText("publicAgent.from", { name: ask.from });
      block.append(from);
    }
    const stateLine = document.createElement("p");
    stateLine.className = "form-hint";
    stateLine.textContent = STATUS[ask.status] ? uiText(STATUS[ask.status]) : "";
    block.append(stateLine);
    if (ask.status === "knock") {
      block.append(actionButton("publicAgent.accept", () => act(page, ask, { action: "accept" }, "publicAgent.accepted")));
      block.append(actionButton("publicAgent.reject", () => act(page, ask, { action: "reject" }, "publicAgent.rejected"), true));
    } else if (ask.status === "open") {
      block.append(actionButton("publicAgent.reject", () => act(page, ask, { action: "reject" }, "publicAgent.rejected"), true));
      const answer = document.createElement("textarea");
      answer.maxLength = 4000;
      answer.rows = 3;
      const send = document.createElement("button");
      send.type = "button";
      send.className = "button primary";
      send.dataset.needs = "answer";
      send.textContent = uiText("publicAgent.send");
      send.disabled = true;
      answer.addEventListener("input", applyBusy);
      send.addEventListener("click", () => {
        const text = answer.value.trim();
        if (!text) return;
        void act(page, ask, { action: "answer", answer: text }, "publicAgent.answered");
      });
      block.append(label("publicAgent.answer", answer), send);
    } else if (ask.status === "answered" && typeof ask.answer === "string" && ask.answer) {
      const body = document.createElement("p");
      body.textContent = ask.answer;
      block.append(body);
    }
    return block;
  }
  function renderPage(page) {
    const section = document.createElement("section");
    const title = document.createElement("h3");
    title.textContent = typeof page.name === "string" && page.name.trim() ? page.name : "Agent";
    section.append(title);
    const rows = asks.get(page.memberId);
    if (!Array.isArray(rows)) {
      const loading = document.createElement("p");
      loading.className = "form-hint";
      loading.textContent = uiText("publicAgent.loading");
      section.append(loading);
    } else {
      const waiting = document.createElement("p");
      waiting.className = "form-hint";
      waiting.textContent = uiText("publicAgent.waiting", { count: waitingCount(rows) });
      section.append(waiting);
    }
    const access = document.createElement("select");
    access.name = "access";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = uiText("publicAgent.choose");
    access.append(blank);
    for (const [value, keyName] of ACCESS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = uiText(keyName);
      access.append(option);
    }
    if (page.access) access.value = page.access;
    const slug = document.createElement("input");
    slug.name = "slug";
    slug.type = "text";
    slug.maxLength = 40;
    slug.autocomplete = "off";
    slug.spellcheck = false;
    slug.value = page.slug ?? "";
    const blurb = document.createElement("input");
    blurb.type = "text";
    blurb.maxLength = 280;
    blurb.value = page.blurb ?? "";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = page.enabled === true;
      const save = document.createElement("button");
    save.type = "button";
    save.className = "button primary";
    save.dataset.needs = "page";
    save.textContent = uiText("publicAgent.save");
    save.disabled = !access.value || !slug.value.trim();
    access.addEventListener("change", applyBusy);
    slug.addEventListener("input", applyBusy);
    save.addEventListener("click", () => {
      void savePage(page, {
        access: access.value,
        slug: slug.value.trim(),
        blurb: blurb.value.trim(),
        enabled: enabled.checked,
      });
    });
    section.append(
      label("publicAgent.access", access),
      label("publicAgent.address", slug),
      label("publicAgent.blurb", blurb),
      check("publicAgent.enabled", enabled),
      save,
    );
    const pageUrl = httpUrl(page.page);
    if (pageUrl) {
      const linkWrap = document.createElement("p");
      const link = document.createElement("a");
      link.href = pageUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = pageUrl;
      linkWrap.append(link);
      section.append(linkWrap);
    }
    if (Array.isArray(rows) && rows.length === 0) {
      const none = document.createElement("p");
      none.className = "form-hint";
      none.textContent = uiText("publicAgent.none");
      section.append(none);
    } else if (Array.isArray(rows)) {
      for (const ask of rows) section.append(renderAsk(page, ask));
    }
    return section;
  }
  function paint() {
    root.replaceChildren();
    if (!pages.length) {
      const empty = document.createElement("p");
      empty.className = "form-hint";
      empty.textContent = uiText("publicAgent.empty");
      root.append(empty);
      return;
    }
    for (const page of pages) root.append(renderPage(page));
    applyBusy();
  }
  async function readAll(token, binding) {
    const body = await client.request(listPath());
    if (!own(token) || key !== binding || !dialog.open) return null;
    const nextPages = Array.isArray(body?.pages) ? body.pages : [];
    const nextAsks = new Map();
    await Promise.all(nextPages.map(async page => {
      const result = await client.request(asksPath(page.memberId));
      if (!Array.isArray(result?.asks)) throw new Error(uiText("publicAgent.failed"));
      nextAsks.set(page.memberId, result.asks);
    }));
    if (!own(token) || key !== binding || !dialog.open) return null;
    return { pages: nextPages, asks: nextAsks };
  }
  function showRead(read) {
    pages = read.pages;
    asks = read.asks;
    paint();
  }
  async function openDialog() {
    if (!key) return;
    const binding = key;
    const token = begin();
    say("");
    pages = [];
    asks = new Map();
    root.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "form-hint";
    loading.textContent = uiText("publicAgent.loading");
    root.append(loading);
    if (!dialog.open) dialog.showModal();
    try {
      const read = await readAll(token, binding);
      if (!read) return;
      showRead(read);
    } catch (error) {
      if (!own(token)) return;
      root.replaceChildren();
      say(error.message || uiText("publicAgent.failed"));
    } finally { end(token); }
  }
  async function write(path, data, okKey) {
    if (busyToken !== 0 || !dialog.open || !key) return;
    const binding = key;
    const token = begin();
    say("");
    try {
      await client.request(path, { method: "POST", data });
      const read = await readAll(token, binding);
      if (!read) return;
      showRead(read);
      say(uiText(okKey));
    } catch (error) {
      if (!own(token)) return;
      say(error.message || uiText("publicAgent.failed"));
    } finally { end(token); }
  }
  function savePage(page, data) {
    return write(pagePath(page.memberId), data, "publicAgent.saved");
  }
  function act(page, ask, data, okKey) {
    return write(actPath(page.memberId, ask.id), data, okKey);
  }
  function sync() {
    const next = roomKey();
    if (next === key) return;
    key = next;
    const token = ++flight;
    if (busyToken !== 0) busyToken = 0;
    button.hidden = true;
    pages = [];
    asks = new Map();
    say("");
    root.replaceChildren();
    if (dialog.open) {
      suppressClose = true;
      dialog.close();
      suppressClose = false;
    }
    if (!next) return;
    client.request(listPath()).then(body => {
      if (!own(token) || key !== next) return;
      button.hidden = !Array.isArray(body?.pages);
    }).catch(() => {
      if (!own(token)) return;
      button.hidden = true;
    });
  }
  button.addEventListener("click", () => { void openDialog(); });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (suppressClose) return;
    flight++;
    if (busyToken !== 0) busyToken = 0;
  });
  return { sync };
}
