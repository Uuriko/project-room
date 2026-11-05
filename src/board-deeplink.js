// Agent first-run board intent is navigation only; room restoration still
// performs the existing session and membership checks before a snapshot.
export const BOARD_DEEP_LINK_PARAM = "board";
const BASE = "https://room.invalid";
const isAbsolute = href => /^[A-Za-z][A-Za-z\d+.-]*:|^\/\//.test(href);
const format = (url, original) => isAbsolute(original) ? url.href : [url.pathname, url.search, url.hash].join("");

export function withBoardDeepLink(target) {
  const url = new URL(target, BASE);
  url.searchParams.set(BOARD_DEEP_LINK_PARAM, "1");
  return format(url, target);
}

// A single exact value avoids conflicting or duplicated navigation intent.
export function boardDeepLinkWanted(search) {
  try {
    const values = new URL(search, BASE).searchParams.getAll(BOARD_DEEP_LINK_PARAM);
    return values.length === 1 && values[0] === "1";
  } catch { return false; }
}

export function stripBoardDeepLink(href) {
  try {
    const url = new URL(href, BASE);
    if (!boardDeepLinkWanted(url.search)) return href;
    url.searchParams.delete(BOARD_DEEP_LINK_PARAM);
    return format(url, href);
  } catch { return href; }
}

// Opening owns the intent only when the existing modal actually opened.
// Failure leaves the URL and ordinary Tasks button available for retry.
export function consumeBoardDeepLink(href, openBoard, replace) {
  if (!boardDeepLinkWanted(href)) return false;
  try {
    if (openBoard() !== true) return false;
    replace(stripBoardDeepLink(href));
    return true;
  } catch { return false; }
}
