export const BEGIN = "# project-room:begin";
export const END = "# project-room:end";

export function jsonText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

export function planJson(path, before, update) {
  let data = {};
  if (before) {
    try { data = JSON.parse(before); }
    catch { throw new Error(`${path} is not valid JSON. Move it aside and run room setup again.`); }
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path} is not a JSON object`);
  }
  update(data);
  return jsonText(data);
}

export function planMarked(before, block) {
  const inner = block.endsWith("\n") ? block.slice(0, -1) : block;
  const wrapped = `${BEGIN}\n${inner}\n${END}\n`;
  if (!before) return wrapped;
  const start = before.indexOf(BEGIN);
  const end = before.indexOf(END);
  if (start !== -1 && end > start) {
    let rest = before.slice(end + END.length);
    if (rest.startsWith("\n")) rest = rest.slice(1);
    return before.slice(0, start) + wrapped + rest;
  }
  const sep = before.endsWith("\n") || before.length === 0 ? "" : "\n";
  return before + sep + wrapped;
}

export function unifiedDiff(path, before, after) {
  if (before === after) return "";
  const prior = before === null || before === undefined ? [] : before.split("\n");
  const next = after.split("\n");
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const line of prior) if (!next.includes(line)) lines.push("-" + line);
  for (const line of next) if (!prior.includes(line)) lines.push("+" + line);
  return lines.join("\n") + "\n";
}
