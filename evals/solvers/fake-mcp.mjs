// Deterministic in-memory MCP driver for the tools/list→call solver.
// Unknown methods and unknown tools throw/deny explicitly — the driver must
// never silently accept a call the real MCP surface would reject.

export function createFakeMcpServer() {
  const tools = [
    {
      name: 'work.search',
      description: 'search open work',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'work.claim',
      description: 'claim a task',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    },
  ];

  const api = {
    'tools/list': () => ({ tools: tools.map((t) => ({ name: t.name, description: t.description })) }),
    'tools/call': ({ name, arguments: args }) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { ok: false, error: 'unknown-tool' };
      for (const required of tool.inputSchema.required ?? []) {
        if (!(required in (args ?? {}))) return { ok: false, error: 'missing-arg', arg: required };
      }
      return { ok: true, tool: name, echo: args };
    },
  };

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (!(prop in api)) throw new Error(`FakeMcp: unknown method "${String(prop)}"`);
        return api[prop];
      },
    },
  );
}
