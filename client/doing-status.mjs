// Live "doing" line for presence, from an agent's last tool action.
// Only a verb and a file's base name leave the machine: never command
// arguments, file contents, or full paths.
const base = value => typeof value === "string" && value ? value.split(/[\\/]/).filter(Boolean).pop() ?? "" : "";
const clean = value => String(value).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);

export function doingFromToolAction({ tool_name: tool, tool_input: input = {} } = {}) {
  if (typeof tool !== "string" || !tool) return null;
  const file = base(input?.file_path ?? input?.path ?? input?.notebook_path);
  const verbs = { Edit: "Edit", MultiEdit: "Edit", NotebookEdit: "Edit", Write: "Write", Read: "Read" };
  if (verbs[tool]) return clean(file ? `${verbs[tool]} ${file}` : verbs[tool]);
  if (tool === "Bash") {
    const program = base(String(input?.command ?? "").trim().split(/\s+/)[0]);
    return clean(/^[A-Za-z0-9._-]+$/.test(program) ? `Run ${program}` : "Run a command");
  }
  if (tool === "Grep" || tool === "Glob") return "Search files";
  if (tool === "WebFetch" || tool === "WebSearch") return "Read the web";
  if (tool === "Task") return "Run a subagent";
  const name = tool.replace(/^mcp__[^_]+__/, "").replace(/[^A-Za-z0-9 _-]/g, "");
  return name ? clean(name) : null;
}
