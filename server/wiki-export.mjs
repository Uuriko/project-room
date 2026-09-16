// Wiki export as Markdown bundle (W013). A pure exporter: given wiki
// pages, build a Markdown bundle (index + pages). The module is pure and
// dependency-free. Frozen outputs; malformed inputs throw ExportError.
// ZIP packaging/UI is a later slice.
class ExportError extends Error { constructor(code, message) { super(message); this.name = "ExportError"; this.code = code; } }
const fail = (code, message) => { throw new ExportError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_export", message); };
// Build a Markdown bundle from wiki pages.
// pages: [{ pageId, title, content, updatedAt }]
// Returns { index, pages: [{ filename, content }] }
export function exportWiki({ pages, title }) {
  check(Array.isArray(pages), "pages must be an array");
  check(title === undefined || typeof title === "string", "title must be a string if given");
  const bundleTitle = title || "Wiki Export";
  const exported = [];
  const indexLines = [`# ${bundleTitle}`, "", `Exported ${pages.length} pages.`, "", "## Pages", ""];
  for (const p of pages) {
    check(typeof p.pageId === "string" && p.pageId.length > 0, "pageId must be non-empty");
    check(typeof p.title === "string" && p.title.length > 0, "title must be non-empty");
    check(typeof p.content === "string", "content must be a string");
    const filename = `${p.pageId.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}.md`;
    const content = `# ${p.title}\n\n${p.content}\n`;
    exported.push(Object.freeze({ pageId: p.pageId, filename, content }));
    indexLines.push(`- [${p.title}](${filename})`);
  }
  return Object.freeze({ title: bundleTitle, pageCount: pages.length,
    index: indexLines.join("\n") + "\n", pages: Object.freeze(exported) });
}
export { ExportError };
