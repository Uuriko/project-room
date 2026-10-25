// Closed details and closed dialogs stay in the document. The room and the
// browser checks address those fields while the dialog is closed, and a node
// moved into a fragment is invisible to them. The park helpers remain for a
// dialog that opts in later. installLazyPanels does not call them.

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

// Opt-in. installLazyPanels does not call this. A dialog that wants its
// body detached until show or showModal passes itself here.
export function park(root, keep) {
  if (PARKED.has(root)) return;
  const all = [...root.childNodes];
  // A fragment keeps a parent, so after() and before() on a parked field
  // still insert. node.remove() would leave the field parentless and drop
  // that insert.
  const fragment = root.ownerDocument.createDocumentFragment();
  let removed = 0;
  for (const node of all) {
    if (keep?.(node)) continue;
    fragment.append(node);
    removed += 1;
  }
  if (!removed) return;
  PARKED.set(root, { all, fragment });
  parkedRoots.add(root);
}

function restore(root) {
  const saved = PARKED.get(root);
  if (!saved) return;
  PARKED.delete(root);
  parkedRoots.delete(root);
  // Replay the fragment, which is the removed nodes plus anything inserted
  // beside them, and leave a node that is already in that spot. Moving a
  // summary during pointerdown cancels the click that opens the details.
  const block = [...saved.fragment.childNodes];
  let previous = null;
  let index = 0;
  const place = node => {
    const expected = previous ? previous.nextSibling : root.firstChild;
    if (node !== expected) root.insertBefore(node, expected);
    previous = node;
  };
  for (const node of saved.all) {
    if (node.parentNode === root) {
      if (previous && node !== previous.nextSibling) root.insertBefore(node, previous.nextSibling);
      previous = node;
      continue;
    }
    while (index < block.length && block[index] !== node) {
      place(block[index]);
      index += 1;
    }
    place(node);
    index += 1;
  }
  while (index < block.length) {
    place(block[index]);
    index += 1;
  }
}

function parkedElements(saved) {
  const nodes = saved.fragment ? [...saved.fragment.childNodes] : saved.all;
  return nodes.filter(node => node.nodeType === 1);
}

function parkedFragments(doc) {
  const nodes = [];
  for (const root of parkedRoots) {
    if (root.ownerDocument !== doc) continue;
    const saved = PARKED.get(root);
    if (!saved) continue;
    for (const node of parkedElements(saved)) nodes.push(node);
  }
  return nodes;
}

function matchesIn(node, selector) {
  const found = [];
  if (node.matches(selector)) found.push(node);
  for (const element of nativeElQueryAll.call(node, selector)) found.push(element);
  return found;
}

// "#composer-options .panel" names the details element, which stays in the
// document while its children are detached. A query from those children
// cannot see that id, so retry the part after it.
function relativeToRoot(root, selector) {
  if (!root?.id || typeof selector !== "string") return null;
  const prefix = `#${CSS.escape(root.id)}`;
  if (!selector.startsWith(prefix)) return null;
  const rest = selector.slice(prefix.length);
  if (!/^[ >+~]/.test(rest)) return null;
  return rest.trim();
}

function matchesParked(node, selector, root) {
  try {
    const direct = matchesIn(node, selector);
    if (direct.length) return direct;
  } catch {
    return [];
  }
  const rest = relativeToRoot(root, selector);
  if (!rest) return [];
  try {
    if (rest.startsWith(">")) {
      const child = rest.slice(1).trim();
      return child && node.matches(child) ? [node] : [];
    }
    if (rest.startsWith("+") || rest.startsWith("~")) return [];
    return matchesIn(node, rest);
  } catch {
    return [];
  }
}

function scopeSeesParked(scope) {
  if (!scope) return true;
  for (const root of parkedRoots) {
    if (scope === root || scope.contains?.(root)) return true;
  }
  return false;
}

// A render of the message list calls querySelectorAll on nodes that do not
// contain a dialog. Searching every parked dialog from those calls held
// own-send behind the parent branch.
function elementTouchesParked(scope) {
  if (parkedRoots.size === 0 || !scope) return false;
  if (scopeSeesParked(scope)) return true;
  for (const root of parkedRoots) {
    const saved = PARKED.get(root);
    if (saved?.fragment.contains(scope)) return true;
  }
  return false;
}

function fragmentVisibleTo(scope, root) {
  if (!scope) return true;
  if (scope === root || scope.contains(root)) return true;
  // A details element parked inside a dialog is detached, so scope.contains
  // misses it. Follow the parked root that still holds it.
  for (const ancestor of parkedRoots) {
    if (ancestor === root) continue;
    const saved = PARKED.get(ancestor);
    if (!parkedElements(saved).some(node => node === root || node.contains?.(root))) continue;
    if (scope === ancestor || scope.contains(ancestor)) return true;
  }
  return false;
}

function firstInParked(doc, selector, scope) {
  for (const root of parkedRoots) {
    if (root.ownerDocument !== doc || !fragmentVisibleTo(scope, root)) continue;
    const saved = PARKED.get(root);
    if (!saved) continue;
    for (const node of parkedElements(saved)) {
      const found = matchesParked(node, selector, root);
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
    for (const node of parkedElements(saved)) found.push(...matchesParked(node, selector, root));
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
    if (hit || !elementTouchesParked(this)) return hit;
    return firstInParked(this.ownerDocument, selector, this);
  };
  elProto.querySelectorAll = function querySelectorAll(selector) {
    const found = [...nativeElQueryAll.call(this, selector)];
    if (!elementTouchesParked(this)) return found;
    found.push(...allInParked(this.ownerDocument, selector, this));
    return found;
  };
}

export function installLazyPanels(doc = globalThis.document) {
  if (!doc?.documentElement || doc.documentElement.dataset.panelsLazy === "1") return;
  doc.documentElement.dataset.panelsLazy = "1";
  // Closed details and closed dialogs stay in the document. The room and the
  // browser checks address those fields (work options, catch-up, room
  // overview) while the dialog is closed. Detaching them made those lookups
  // miss. The park helpers remain for a dialog that opts in later.
  patchPrototypes();
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("toggle", onToggle, true);
}
