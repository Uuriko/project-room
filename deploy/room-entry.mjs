import { createHash } from "node:crypto";
import { discoveryDoc, ROOM_ORIGIN, COMPUTE_DOOR, ROOM_PUBLIC_WWW } from "./agent-discovery.mjs";

const DOOR_PAGES = new Set(["/room", "/room/", "/project-room", "/project-room/"]);
export const PUBLIC_DOOR_PATHS = Object.freeze(["/room", "/room/"]);
// Hash-forward: Open/People get #room/{roomId}; Join CTA gets #join/<token>. No keys, no people-data.
export const ROOM_DEEP_LINK_SCRIPT = "(function(){function apply(){var h=location.hash;var m=/^#room\\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(h);var o=document.querySelector(\"a.open\"),p=document.querySelector(\"a.people\");if(m&&o){var u=new URL(o.getAttribute(\"href\"),location.href);u.hash=\"#room/\"+m[1];o.setAttribute(\"href\",u.href);if(p)p.setAttribute(\"href\",o.getAttribute(\"href\"));}var jm=/^#join\\/([A-Za-z0-9_-]{43}(?:\\/(?:work|message)\\/[^#]*)?)$/.exec(h);if(jm){var links=document.querySelectorAll(\"a[href]\");for(var i=0;i<links.length;i++){var a=links[i],href=a.getAttribute(\"href\")||\"\";if(href.indexOf(\"#join/\")===-1)continue;var ju=new URL(href,location.href);ju.hash=\"#join/\"+jm[1];a.setAttribute(\"href\",ju.href);}}}apply();addEventListener(\"hashchange\",apply);})();";
