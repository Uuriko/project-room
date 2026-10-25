// Closed panel bodies and dialog contents are in the document at parse time.
// Detach them until the person opens that panel, so the first paint does not
// build every form. The details or dialog element stays, which is what
// getElementById and the settings grouper look up. Listeners already bound
// on a detached node survive the move back.

const PARKED = new WeakMap();
const parkedRoots = new Set();
let patched = false;
const docProto = globalThis.Document?.prototype;
const elProto = globalThis.Element?.prototype;
const nativeDocQuery = docProto?.querySelector;
const nativeDocQueryAll = docProto?.querySelectorAll;
const nativeDocById = docProto?.getElementById;
const nativeElQuery = elProto?.querySelector;
const nativeElQueryAll = elProto?.querySelectorAll;

function park(root, keep) {
  if (PARKED.has(root)) return;
  const all = [...root.childNodes];
  let removed = 0;
  for (const node of all) {
    if (keep?.(node)) continue;
    node.remove();
    removed += 1;
  }
  if (!removed) return;
  PARKED.set(root, { all });
  parkedRoots.add(root);
}

function restore(root) {
  const saved = PARKED.get(root);
  if (!saved) return;
  PARKED.delete(root);
  parkedRoots.delete(root);
  for (const node of saved.all) root.appendChild(node);
}

function parkedFragments(doc) {
  const nodes = [];
  for (const root of parkedRoots) {
    if (root.ownerDocument !== doc) continue;
    const saved = PARKED.get(root);
    if (!saved) continue;
    for (const node of saved.all) {
      if (node.nodeType === 1 && node.parentNode !== root) nodes.push(node);
    }
  }
  return nodes;
}

function matchesIn(node, selector) {
  const found = [];
  if (node.matches(selector)) found.push(node);
  for (const element of nativeElQueryAll.call(node, selector)) found.push(element);
  return found;
}

function fragmentVisibleTo(scope, root) {
  if (!scope) return true;
  if (scope === root || scope.contains(root)) return true;
  // A details element parked inside a dialog is detached, so scope.contains
  // misses it. Follow the parked root that still holds it.
  for (const ancestor of parkedRoots) {
    if (ancestor === root) continue;
    const saved = PARKED.get(ancestor);
    if (!saved?.all.some(node => node === root || (node.nodeType === 1 && node.contains?.(root)))) continue;
    if (scope === ancestor || scope.contains(ancestor)) return true;
  }
  return false;
}

function firstInParked(doc, selector, scope) {
  for (const root of parkedRoots) {
    if (root.ownerDocument !== doc || !fragmentVisibleTo(scope, root)) continue;
    const saved = PARKED.get(root);
    if (!saved) continue;
    for (const node of saved.all) {
      if (node.nodeType !== 1 || node.parentNode === root) continue;
      const found = matchesIn(node, selector);
      if (found.length) return found[0];
    }
  }
  return null;
}

function allInParked(doc, selector, scope) {
  const found = [];
  for (const root of parkedRoots) {
    if (root.ownerDocument !== doc || !fragmentVisibleTo(scope, root)) continue;
    const saved = PARKED.get(root);
    if (!saved) continue;
    for (const node of saved.all) {
      if (node.nodeType !== 1 || node.parentNode === root) continue;
      found.push(...matchesIn(node, selector));
    }
  }
  return found;
}

function onPointerDown(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;
  const summary = target.closest("summary");
  const details = summary?.closest("details");
  if (details) restore(details);
}

function onToggle(event) {
  const details = event.target;
  if (details?.nodeName === "DETAILS" && details.open) restore(details);
}

function patchPrototypes() {
  if (patched || !docProto || !elProto || !nativeDocQuery || !nativeDocQueryAll || !nativeDocById || !nativeElQuery || !nativeElQueryAll) return;
  patched = true;
  const detailsProto = globalThis.HTMLDetailsElement?.prototype;
  const open = detailsProto && Object.getOwnPropertyDescriptor(detailsProto, "open");
  if (open?.get && open?.set) {
    Object.defineProperty(detailsProto, "open", {
      configurable: true, enumerable: open.enumerable,
      get() { return open.get.call(this); },
      set(value) { if (value) restore(this); open.set.call(this, value); }
    });
  }
  const dialogProto = globalThis.HTMLDialogElement?.prototype;
  if (dialogProto) {
    for (const name of ["show", "showModal"]) {
      const original = dialogProto[name];
      if (typeof original !== "function") continue;
      dialogProto[name] = function patchedDialogShow(...args) {
        restore(this);
        return original.apply(this, args);
      };
    }
  }
  docProto.querySelector = function querySelector(selector) {
    const hit = nativeDocQuery.call(this, selector);
    if (hit || this.nodeType !== 9) return hit;
    return firstInParked(this, selector, null);
  };
  docProto.querySelectorAll = function querySelectorAll(selector) {
    const found = [...nativeDocQueryAll.call(this, selector)];
    if (this.nodeType !== 9) return found;
    found.push(...allInParked(this, selector, null));
    return found;
  };
  docProto.getElementById = function getElementById(id) {
    const hit = nativeDocById.call(this, id);
    if (hit || typeof id !== "string" || id.length === 0) return hit;
    for (const node of parkedFragments(this)) {
      if (node.id === id) return node;
      for (const element of nativeElQueryAll.call(node, "*")) if (element.id === id) return element;
    }
    return null;
  };
  elProto.querySelector = function querySelector(selector) {
    const hit = nativeElQuery.call(this, selector);
    if (hit) return hit;
    return firstInParked(this.ownerDocument, selector, this);
  };
  elProto.querySelectorAll = function querySelectorAll(selector) {
    return [...nativeElQueryAll.call(this, selector), ...allInParked(this.ownerDocument, selector, this)];
  };
}

export function installLazyPanels(doc = globalThis.document) {
  if (!doc?.documentElement || doc.documentElement.dataset.panelsLazy === "1") return;
  doc.documentElement.dataset.panelsLazy = "1";
  const details = [...doc.querySelectorAll("details")];
  const inAuth = new Set(details.filter(element => element.closest("#auth-panel")));
  // Park closed details before dialog contents, so a details element inside
  // a dialog is keyed while it is still in that dialog.
  for (const element of details) {
    if (inAuth.has(element) || element.open) continue;
    park(element, node => node.nodeName === "SUMMARY");
  }
  for (const dialog of doc.querySelectorAll("dialog")) {
    if (dialog.id === "settings-dialog") continue;
    park(dialog);
  }
  patchPrototypes();
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("toggle", onToggle, true);
}
