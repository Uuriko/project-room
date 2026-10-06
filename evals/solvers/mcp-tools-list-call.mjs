// Solver: the MCP tools/list → tools/call agent workflow under test.
// The agent must list first and then call a tool it actually saw listed,
// with the arguments that tool's schema requires.

import { createFakeMcpServer } from './fake-mcp.mjs';

export async function solveMcpListCall(task) {
  const mcp = createFakeMcpServer();
  const trajectory = [];
  const call = (tool, args) => {
    const result = mcp[tool](args);
    trajectory.push({ tool, args, result });
    return result;
  };

  const listed = call('tools/list', {});
  const names = (listed.tools ?? []).map((t) => t.name);
  const name = names.includes(task.toolName) ? task.toolName : names[0];
  const response = call('tools/call', { name, arguments: task.args ?? {} });

  return { trajectory, finalAnswer: response };
}
