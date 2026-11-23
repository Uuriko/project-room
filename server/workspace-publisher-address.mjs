export function workspacePublisherAddress(value) {
  const url = typeof value === "string" && URL.parse(value);
  if (!url || url.protocol !== "tls:" || url.username || url.password || url.search || url.hash
      || (url.pathname && url.pathname !== "/") || !url.port || Number(url.port) < 1 || Number(url.port) > 65535
      || !/^[a-z][a-z0-9.-]*$/i.test(url.hostname)) {
    throw new Error("Choose a tls://hostname:port Workspace publisher address");
  }
  return `tls://${url.hostname.toLowerCase()}:${Number(url.port)}`;
}
