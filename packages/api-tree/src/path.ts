// Escape-aware segment join — the one primitive every projector's flat-name
// derivation (MCP tool/resource names, JSON-RPC method names, GraphQL lookup
// keys, CLI completion levels, HTTP/OpenAPI operation names) is supposed to
// funnel through instead of re-deriving its own unescaped
// `prefix + delimiter + segment` concatenation at every branch level of a
// tree walk.
//
// The bug this closes: an unescaped join is not injective. Two DIFFERENT
// segment arrays can produce the IDENTICAL joined string whenever an
// authored segment (a tree key, a `meta.*.segment`/`meta.*.name` override)
// itself contains the delimiter — e.g. with "_" as delimiter, branch
// `"books"` → leaf `"get"` joins to `"books_get"`, the exact same string a
// single leaf literally named `"books_get"` at the tree root also produces.
// A caller that then uses the joined string as a map/dispatch-table key
// (every one of the call sites above does) silently loses one of the two
// tree positions to the other. `assertUniqueName` (./tree.ts) turns that
// silent loss into a thrown error for two of these six call sites, but a
// thrown error is a symptom patch, not a fix — the real fix is to stop
// producing colliding strings in the first place.
//
// `escapeJoin` fixes this with textbook backslash-escaping: within each
// segment, every backslash is doubled and every occurrence of the delimiter
// is backslash-prefixed, THEN the escaped segments are joined with the
// delimiter, unescaped. Given the joined output, `unescapeJoin` reverses the
// transform exactly (backslash-backslash → one backslash,
// backslash-delimiter → one literal delimiter character, any other
// occurrence of the delimiter → segment boundary) — this file's test proves
// `unescapeJoin(escapeJoin(segments, d), d)` returns `segments` for a wide
// randomized/adversarial sample of segments and delimiters, which is exactly
// what makes `escapeJoin` injective: if two different segment arrays ever
// produced the same joined string, unescaping that string could not recover
// both, contradicting the round-trip property the test establishes.
//
// Parametrized over `delimiter` (not fixed to "_") because different
// projectors join on different characters/strings — "_" for MCP/CLI/HTTP
// codegen names, "." for JSON-RPC method names, "/" for MCP resource URIs —
// while sharing this one escaping implementation rather than each hand-rolling
// its own.
//
// What this does NOT cover: GraphQL's `camelJoin` (graphql-api-projector's
// project.ts) produces a value that must itself be a syntactically valid
// GraphQL/JS identifier (`/^[_A-Za-z][_0-9A-Za-z]*$/`) — backslash-escaping
// would produce a string containing "\", which is not a legal identifier
// character, so this scheme cannot be applied there without changing what a
// camelCase-joined field name is allowed to look like. See that file's own
// note for the open question this leaves.

const ESCAPE = "\\";

/**
 * Join `segments` on `delimiter`, backslash-escaping the delimiter and the
 * escape character itself within each segment first, so the result is
 * injective: two different (non-empty) segment arrays can never produce the
 * same joined string, for a fixed `delimiter`. See module doc for the
 * escaping scheme and the collision this closes.
 *
 * Throws on an empty `delimiter` (nothing to escape against) or a
 * `delimiter` containing the escape character itself ("\\" is reserved by
 * this scheme; a delimiter built from it would make the escape/delimiter
 * byte streams ambiguous to reverse). Throws on an empty `segments` array —
 * every real caller joins at least one path segment (a leaf's own tree key,
 * at minimum), and admitting the empty array would make `escapeJoin([], d)`
 * and `escapeJoin([""], d)` collide (both would otherwise join to `""`),
 * which is exactly the kind of silent collision this function exists to
 * rule out.
 */
export function escapeJoin(segments: readonly string[], delimiter: string): string {
  assertValidDelimiter(delimiter, "escapeJoin");
  if (segments.length === 0) {
    throw new Error("escapeJoin: segments must be non-empty");
  }
  return segments.map((seg) => escapeSegment(seg, delimiter)).join(delimiter);
}

/**
 * `delimiter` must be exactly one character, not merely non-empty. A
 * MULTI-character delimiter breaks this scheme's own injectivity: escaping
 * only removes an unescaped delimiter occurrence from WITHIN a single
 * segment, but a segment ending in a partial prefix of the delimiter,
 * immediately followed by the real (unescaped) inter-segment delimiter, can
 * form a NEW delimiter-shaped substring straddling that boundary that was
 * never escaped (e.g. delimiter `"::"`, segments `[":", ""]` joins to
 * `":::"`\` — the real delimiter sits at offset 1, but a left-to-right scan
 * also matches one at offset 0, formed by the trailing `":"` of the first
 * segment plus the leading `":"` of the delimiter). Every real caller in
 * this codebase joins on a single character ("_", ".", "/", " "), so this
 * restriction costs nothing in practice; solving the general multi-character
 * case would need a self-synchronizing code (e.g. length-prefixing) instead
 * of plain backslash-escaping, which is more machinery than any current
 * consumer needs.
 */
function assertValidDelimiter(delimiter: string, fn: string): void {
  if (delimiter.length !== 1) {
    throw new Error(
      `${fn}: delimiter must be exactly one character (got ${JSON.stringify(delimiter)}) — ` +
        `see escapeJoin's doc comment for why a multi-character delimiter isn't safe under ` +
        `this escaping scheme.`,
    );
  }
  if (delimiter === ESCAPE) {
    throw new Error(
      `${fn}: delimiter cannot be "\\" — this escaping scheme reserves it as the escape ` +
        `character.`,
    );
  }
}

/** Escape one segment's own backslashes, then its own delimiter occurrences — order matters, see `unescapeJoin`'s matching order. */
function escapeSegment(segment: string, delimiter: string): string {
  const backslashesEscaped = segment.split(ESCAPE).join(ESCAPE + ESCAPE);
  return backslashesEscaped.split(delimiter).join(ESCAPE + delimiter);
}

/**
 * Reverse `escapeJoin`: recover the original segment array from a string it
 * produced (with the same `delimiter`). Scans left to right; `"\\\\"`
 * decodes to one literal backslash, `` "\\" + delimiter `` decodes to one
 * literal (unescaped) delimiter character folded into the current segment,
 * and any other occurrence of `delimiter` ends the current segment and
 * starts the next one.
 *
 * Exists to make `escapeJoin`'s injectivity checkable by round-trip (see
 * path.test.ts) rather than asserted without proof; no production call site
 * needs to un-join a derived name today, but the inverse is what the
 * collision-freedom claim rests on.
 */
export function unescapeJoin(joined: string, delimiter: string): string[] {
  assertValidDelimiter(delimiter, "unescapeJoin");
  const segments: string[] = [];
  let current = "";
  let i = 0;
  while (i < joined.length) {
    if (joined.startsWith(ESCAPE + ESCAPE, i)) {
      current += ESCAPE;
      i += 2;
      continue;
    }
    if (joined.startsWith(ESCAPE + delimiter, i)) {
      current += delimiter;
      i += ESCAPE.length + delimiter.length;
      continue;
    }
    if (joined.startsWith(delimiter, i)) {
      segments.push(current);
      current = "";
      i += delimiter.length;
      continue;
    }
    current += joined[i];
    i += 1;
  }
  segments.push(current);
  return segments;
}
