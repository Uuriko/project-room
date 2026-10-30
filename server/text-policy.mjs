// Shared checks for characters that must not ride along in stored text.
// Bodies use the tag result. Filenames use every result. Search folding
// lives here so both sides of a match use one function.

const TAGS = /[\u{E0000}-\u{E007F}]/u;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/;

// Null when the string has none of these. Otherwise a phrase a caller can
// put after "must not contain". Tags win over bidi, and bidi over zero-width,
// so one character class is named.
export function invisibleCharIssue(str) {
  if (typeof str !== "string" || str.length === 0) return null;
  if (TAGS.test(str)) return "Unicode tag characters (U+E0000-E007F)";
  if (BIDI.test(str)) return "bidirectional embedding, override or isolate characters (U+202A-202E, U+2066-2069)";
  if (ZERO_WIDTH.test(str)) return "zero-width characters";
  return null;
}

// NFKC, then lower case, then drop the combining dot that JavaScript's
// toLowerCase leaves on İ (U+0130 → i + U+0307), then NFC. Both the query
// and the stored text go through this, so café (decomposed) and İstanbul match.
export function foldSearchText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\u0307/g, "").normalize("NFC");
}
