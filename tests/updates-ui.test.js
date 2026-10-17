// Updates tab labels, stable wire queries, read-state filtering, and basis-token validation.
import test from "node:test";
import assert from "node:assert/strict";
import { mountUpdates, queryFor, visible, validBasis } from "../src/updates-ui.js";

test("the Read tab keeps its saved filter ID and names itself from its visible label", t => {
  const created = [];
  const selectors = new Map();
  function element(tag) {
    const node = {
      tag, dataset: {}, attrs: {}, children: [],
      append(...children) { this.children.push(...children); },
      prepend(...children) { this.children.unshift(...children); },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener() {},
      querySelector(selector) {
        assert.ok(selectors.has(selector), `Unexpected selector: ${selector}`);
        return selectors.get(selector);
      }
    };
    created.push(node);
    return node;
  }
  for (const selector of [".topbar-actions", ".updates-filters", ".updates-list", "#updates-status",
    "#updates-summary", "#updates-partial", "#updates-page-announcement", "#updates-load-more", "#updates-close"]) {
    selectors.set(selector, element("div"));
  }
  selectors.set("#main", null);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: element, body: element("body"),
    querySelector: selector => {
      assert.ok(selectors.has(selector), `Unexpected selector: ${selector}`);
      return selectors.get(selector);
    }
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  mountUpdates({ client: {} });
  const tabs = created.filter(node => node.role === "tab");
  assert.deepEqual(tabs.map(node => node.textContent), ["Needs me", "Mentions", "All activity", "Read"]);
  const read = tabs.find(node => node.dataset.updateFilter === "saved");
  assert.equal(read.textContent, "Read");
  assert.equal(read.attrs["aria-label"], undefined, "the visible Read label supplies the accessible name");
  assert.equal(read.attrs["aria-labelledby"], undefined);
});

test("queryFor: each filter issues its documented updates query", () => {
  assert.equal(queryFor("needs"), "state=actionable");
  assert.equal(queryFor("mentions"), "state=actionable&kinds=mention");
  assert.equal(queryFor("all"), "state=all");
  assert.equal(queryFor("saved"), "state=all");
  assert.equal(queryFor("bogus"), "state=actionable");
});

test("visible: the Read filter lists read items only under the stable saved ID", () => {
  const items = [
    { id: "a", state: "read" },
    { id: "b", state: "unread" },
    { id: "c", state: "read" },
    { id: "d", state: "handled" },
    { id: "e", state: "cleared" },
    { id: "f", state: "answered" },
  ];
  assert.deepEqual(visible(items, "saved").map(item => item.id), ["a", "c"]);
});

test("visible: other filters pass every item through", () => {
  const items = [
    { id: "a", state: "read" },
    { id: "b", state: "unread" },
  ];
  assert.deepEqual(visible(items, "needs").map(item => item.id), ["a", "b"]);
  assert.deepEqual(visible(items, "mentions").map(item => item.id), ["a", "b"]);
  assert.deepEqual(visible(items, "all").map(item => item.id), ["a", "b"]);
});

test("validBasis: accepts ub1_ plus 64 lowercase hex chars, nothing else", () => {
  const good = `ub1_${"a".repeat(64)}`;
  assert.equal(validBasis(good), true);
  assert.equal(validBasis(`ub1_${"0123456789abcdef".repeat(4)}`), true);
  assert.equal(validBasis(`ub1_${"A".repeat(64)}`), false);
  assert.equal(validBasis(`ub1_${"a".repeat(63)}`), false);
  assert.equal(validBasis(`ub1_${"a".repeat(65)}`), false);
  assert.equal(validBasis(`ub2_${"a".repeat(64)}`), false);
  assert.equal(validBasis("ub1_nothex!!"), false);
  assert.equal(validBasis(""), false);
  assert.equal(validBasis(null), false);
  assert.equal(validBasis(undefined), false);
  assert.equal(validBasis(42), false);
});
