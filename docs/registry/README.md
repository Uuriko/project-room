# Prepared MCP Registry metadata (not published)

`server.next.json` is `server.json` plus publisher extra metadata under
`_meta["io.modelcontextprotocol.registry/publisher-provided"]` (kept under 4 KB).
It lives here on purpose: a push to main that changes `server.json` publishes to
the registry. To publish, the owner copies it over `server.json` in its own
change. Nothing here is read by the server or CI publishing.
