// tooling/derivable-comments/checks.ts
//
// The five derivability checks. Each is a cheap string/regex test against
// facts the code already gives you (a parameter's own declared type, a
// function's own declared return type, whether a referenced path exists on
// disk) — no inference, no manifest, no notion of "approved".
//
// What this module deliberately does NOT do: decide that a whole comment is
// worthless and should be deleted. Findings point at a specific line and
// (for the signature checks) a specific quoted fragment; whether the rest of
// that comment still earns its place is a human call every time. See each
// check's own doc comment for the precision reasoning specific to it.

import type { DeclarationFacts, ExtractedComment } from "./extract.ts";

export type CheckId =
  | "param-restatement"
  | "signature-restatement"
  | "rotting-count"
  | "path-reference"
  | "decoration";

export interface Finding {
  readonly check: CheckId;
  /** Line number relative to the comment's own start (0-based) — the
   *  caller adds `comment.line` to get an absolute file line. */
  readonly lineOffset: number;
  readonly excerpt: string;
  readonly reason: string;
}

// ============================================================================
// Shared line-scanning helpers
// ============================================================================

/** Physical lines of a raw comment, with fenced (```) code regions marked so
 *  callers can skip them — a usage example inside a doc comment legitimately
 *  repeats real signatures/types, that's not restatement, it's the comment
 *  doing its job. Line indices are preserved (fenced lines are kept, just
 *  flagged) so `lineOffset` stays accurate. */
function linesOf(raw: string): { text: string; fenced: boolean }[] {
  const physical = raw.split("\n");
  const out: { text: string; fenced: boolean }[] = [];
  let inFence = false;
  for (const text of physical) {
    const isFenceDelim = /```/.test(text);
    const fenced = inFence || isFenceDelim;
    if (isFenceDelim) inFence = !inFence;
    out.push({ text, fenced });
  }
  return out;
}

const BACKTICK = /`([^`]+)`/g;

/** Strip comment decoration (`/**`, `*​/`, leading `*`/`//`) off one physical
 *  line, for paragraph-boundary detection only — never used for reporting,
 *  which always quotes the original line verbatim. */
function stripDelim(line: string): string {
  return line
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/, "")
    .replace(/^\s*\/\/\s?/, "")
    .trim();
}

/** Assigns each physical line a paragraph id, so prose that a formatter has
 *  wrapped across lines is judged as one unit instead of per fragment-line.
 *  Without this, "requires `name`, the method's own key, and\n
 *  `libraryName`)." reads its second physical line in isolation — just a
 *  bare param mention — and misreads the wrap as "this line's entire
 *  content is naming the param", even though the sentence plainly isn't.
 *  A paragraph break is a blank comment line, or the start of a new
 *  bullet/numbered list item (this repo's doc comments use both `- ` bullets
 *  and blank-line-separated prose, and bullets often run one after another
 *  with no blank line between them). */
function paragraphIds(lines: readonly string[]): number[] {
  const ids: number[] = [];
  let id = 0;
  let atParagraphStart = true;
  for (const raw of lines) {
    const s = stripDelim(raw);
    const isBlank = s.length === 0;
    const isBulletStart = /^([-*•]|\d+[.)])\s/.test(s);
    if (isBlank) {
      ids.push(id);
      id++;
      atParagraphStart = true;
      continue;
    }
    if (isBulletStart && !atParagraphStart) id++;
    ids.push(id);
    atParagraphStart = false;
  }
  return ids;
}

/** Joined, delimiter-stripped text for the paragraph containing line `i`. */
function paragraphTextAt(lines: readonly string[], ids: readonly number[], i: number): string {
  const id = ids[i];
  return lines
    .filter((_, j) => ids[j] === id)
    .map(stripDelim)
    .join(" ");
}

// ============================================================================
// Check 1 — param-restatement
//
// Fires only when a line's entire informational content is "here is the
// parameter/field name", e.g. "Swap individual transforms via
// `opts.transforms`:". A bare mention of a param name is common and
// legitimate when it's attached to real explanation ("`opts.transforms`
// must preserve method-setting rewriters or `applyMethods`'s output
// breaks") — those survive because real content words remain after
// stripping the quoted reference and a small connector-word stoplist.
// This is the precision-critical check: the stoplist + "nothing left"
// bar is deliberately strict, trading recall (some restatement-flavored
// prose won't get flagged) for not flagging legitimate explanation.
// ============================================================================

const CONNECTOR_STOPLIST = new Set(
  `via using through by with pass passing set sets setting override overriding
   overrides swap swapping change changing provide providing specify specifying
   configure configuring use uses individual individually the a an of to for
   and or this that its your you can is are as into onto from`
    .split(/\s+/)
    .filter(Boolean),
);

/** Split an identifier into lowercase word parts: "idParam" -> ["id","param"],
 *  "transforms" -> ["transforms"]. Used so a residual word that just spells
 *  out part of the already-quoted name (rather than repeating it verbatim)
 *  still counts as "no new information". */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function paramRestatement(
  facts: DeclarationFacts,
  text: string,
): { path: string; span: string } | undefined {
  for (const m of text.matchAll(BACKTICK)) {
    const content = m[1]!.trim();
    const dotted = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(content);
    if (dotted) {
      const [, paramName, field] = dotted;
      const param = facts.params.find((p) => p.name === paramName);
      const fields = param ? facts.localFields.get(param.name) : undefined;
      if (param && fields?.has(field!)) return { path: content, span: m[0] };
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(content) && facts.params.some((p) => p.name === content)) {
      return { path: content, span: m[0] };
    }
  }
  return undefined;
}

function checkParamRestatement(comment: ExtractedComment): Finding[] {
  if (!comment.facts || comment.facts.params.length === 0) return [];
  const out: Finding[] = [];
  const lineObjs = linesOf(comment.raw);
  const lineTexts = lineObjs.map((l) => l.text);
  const ids = paragraphIds(lineTexts);
  lineObjs.forEach(({ text, fenced }, i) => {
    if (fenced) return;
    const match = paramRestatement(comment.facts!, text);
    if (!match) return;
    const pathWords = new Set(match.path.split(".").flatMap(nameWords));
    // Judge against the whole paragraph (see paragraphIds), not just this
    // physical line — a formatter-wrapped sentence must not read its own
    // tail-end line as the sentence's entire content. Strip only the ONE
    // matched span, not every backtick span in the paragraph: a second,
    // unrelated backtick reference (e.g. naming the helper function a param
    // is delegated to) is real content and must survive into the residual
    // count, not be silently swallowed by a blind "remove all backticks"
    // pass.
    const paragraph = paragraphTextAt(lineTexts, ids, i);
    const withoutMatch = paragraph.replace(match.span, " ");
    const residual = withoutMatch
      .split(/[^A-Za-z]+/)
      .map((w) => w.toLowerCase())
      .filter(Boolean)
      .filter((w) => !CONNECTOR_STOPLIST.has(w) && !pathWords.has(w));
    if (residual.length === 0) {
      out.push({
        check: "param-restatement",
        lineOffset: i,
        excerpt: text.trim(),
        reason: `only names parameter${match.path.includes(".") ? "/field" : ""} \`${match.path}\`, already visible in the signature — no other content in this paragraph`,
      });
    }
  });
  return out;
}

// ============================================================================
// Check 2 — signature-restatement
//
// Fires whenever a backtick span is literally `` `LeftType => RightType` ``
// and LeftType/RightType exactly match one of the function's own written
// parameter types and its own written return type. Unlike check 1, this
// does NOT require the rest of the line to be empty: a written type
// expression never carries explanation by construction (it's structure, not
// prose), so quoting one back is always mechanically reproducible from the
// signature regardless of what surrounds it in the sentence — the
// surrounding words are judged separately by a human, this only points at
// the redundant fragment itself.
// ============================================================================

const ARROW_TYPE = /^([\w.[\]<>]+)\s*=>\s*([\w.[\]<>]+)$/;

function checkSignatureRestatement(comment: ExtractedComment): Finding[] {
  const facts = comment.facts;
  if (!facts || (facts.params.length === 0 && !facts.returnTypeText)) return [];
  const paramTypes = new Set(facts.params.map((p) => p.typeText).filter((t): t is string => !!t));
  const out: Finding[] = [];
  const lines = linesOf(comment.raw);
  lines.forEach(({ text, fenced }, i) => {
    if (fenced) return;
    for (const m of text.matchAll(BACKTICK)) {
      const arrow = ARROW_TYPE.exec(m[1]!.trim());
      if (!arrow) continue;
      const [, left, right] = arrow;
      if (paramTypes.has(left!) && right === facts.returnTypeText) {
        out.push({
          check: "signature-restatement",
          lineOffset: i,
          excerpt: text.trim(),
          reason: `\`${arrow[0]}\` restates the declared signature (param type \`${left}\` -> return type \`${right}\`) verbatim`,
        });
      }
    }
  });
  return out;
}

// ============================================================================
// Check 3 — rotting-count
//
// A hardcoded count paired with a countable noun ("~7 lines", "three
// pieces") is a fact about the code's current shape, not about what it
// does — it silently goes stale the next time a line is added or a step is
// refactored, and nothing forces the comment to be revisited. This is
// necessarily lower-precision than checks 1/2: it flags the *pattern*
// (a number bound to a countable noun), not a verified-wrong count, because
// verifying most of these nouns (lines, pieces, steps) against the real code
// isn't a cheap string check. The one exception: when the noun is
// param(s)/argument(s) and the comment sits above a declaration, the actual
// parameter count is known for free, so a mismatch there is reported as
// already-wrong rather than merely rot-prone.
// ============================================================================

// "one" is deliberately excluded: it's overwhelmingly used idiomatically in
// this codebase's prose ("the one place that knows", "joins them into one
// file") rather than as a count of code structure, and including it made
// the check noisy enough to bury the real hits. Two-through-ten and bare
// digits stay in — "joins into one file" is idiom, "two fields with the
// same name" is a real count.
const NUMBER_WORD: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
// `(?<![\d.§=])` keeps this off version numbers ("JSON-RPC 2.0 method"),
// spec section refs ("§4.8.24.2 Properties"), and variable-equals-value math
// notation ("the N=1 case") — all three put a countable-looking noun right
// after a digit that isn't counting anything in this codebase.
const COUNT_PATTERN =
  /(~?(?<![\d.§=])\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\b)\s+(lines?|pieces?|steps?|cases?|params?|parameters?|arguments?|args?|properties|fields?|functions?|methods?|files?|times?|places?)\b/gi;

function checkRottingCount(comment: ExtractedComment): Finding[] {
  const out: Finding[] = [];
  const lines = linesOf(comment.raw);
  lines.forEach(({ text, fenced }, i) => {
    if (fenced) return;
    for (const m of text.matchAll(COUNT_PATTERN)) {
      const [full, , rawNum, noun] = m;
      const n = /^\d+$/.test(rawNum!) ? Number(rawNum) : NUMBER_WORD[rawNum!.toLowerCase()];
      const isParamNoun = /^(params?|parameters?|arguments?|args?)$/i.test(noun!);
      if (isParamNoun && comment.facts && n !== undefined) {
        const actual = comment.facts.params.length;
        if (actual !== n) {
          out.push({
            check: "rotting-count",
            lineOffset: i,
            excerpt: text.trim(),
            reason: `says "${full}" but the declaration has ${actual} parameter${actual === 1 ? "" : "s"} — already wrong`,
          });
          continue;
        }
      }
      out.push({
        check: "rotting-count",
        lineOffset: i,
        excerpt: text.trim(),
        reason: `hardcoded count "${full}" — will silently go stale as the code changes; consider dropping the number or checking it's still right`,
      });
    }
  });
  return out;
}

// ============================================================================
// Check 4 — path-reference
//
// A hand-maintained repo-relative path (`docs/design/foo.md`,
// `examples/library-api/src/tree.ts`) is a cross-reference nothing keeps in
// sync with a rename/move — the check flags every one it finds; whether the
// target still exists on disk is a fact this tool CAN check cheaply (via
// `existsPath`, injected by the caller so this module stays fs-free and
// testable on strings alone), and upgrades the finding from "rots silently"
// to "already broken" when it doesn't.
// ============================================================================

// Anchored to this repo's actual top-level directories, not any
// slash-separated-looking token. An unanchored pattern also matches
// illustrative/placeholder paths used in prose to explain a general rule
// ("`src/X.ts` maps to `dist/X.js`") — those aren't repo cross-references at
// all, and this repo's real files never sit under a bare top-level `src/`
// (they're nested under `packages/*/src/`), so requiring one of the real
// top-level names as the first segment rules those out for free.
const REPO_TOP_LEVEL = ["docs", "examples", "packages", "scripts", "spike", "tooling"] as const;
// `(?<![\w/])` before the top-level name rules out a path-shaped tail
// embedded in a longer URL (a doc comment linking
// "https://github.com/.../blob/main/docs/enums.md" is not a reference to
// THIS repo's docs/enums.md just because the suffix happens to match one of
// our top-level directory names) — a real in-prose reference to a repo path
// is always preceded by whitespace/punctuation, never chained directly onto
// another path segment.
const PATH_PATTERN = new RegExp(
  `(?<![\\w/])((?:${REPO_TOP_LEVEL.join("|")})(?:/[\\w.-]+)+\\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|md|json|sh|toml|yaml|yml))\\b`,
  "g",
);

function checkPathReference(
  comment: ExtractedComment,
  existsPath: (relPath: string) => boolean,
  selfPath?: string,
): Finding[] {
  const out: Finding[] = [];
  const lines = linesOf(comment.raw);
  lines.forEach(({ text, fenced }, i) => {
    if (fenced) return;
    for (const m of text.matchAll(PATH_PATTERN)) {
      const p = m[1]!;
      // A file naming its own path in its own header comment (this repo's
      // convention — every file in this tool does it) isn't a cross-file
      // reference that can drift out of sync with a rename anywhere else in
      // the tree; skip it rather than flag a pattern this codebase uses on
      // purpose, everywhere, by design.
      if (selfPath && p === selfPath) continue;
      const exists = existsPath(p);
      out.push({
        check: "path-reference",
        lineOffset: i,
        excerpt: text.trim(),
        reason: exists
          ? `references \`${p}\` — a hand-maintained cross-reference that rots silently if the target moves`
          : `references \`${p}\`, which no longer exists — already broken`,
      });
    }
  });
  return out;
}

// ============================================================================
// Check 5 — decoration
//
// A line that is nothing but repeated symbol characters (banner rules like
// `// ====...====`) carries zero information beyond "here is a section
// break", which the code's own blank lines and declaration order already
// show. High precision by construction: the whole line has to be symbol
// repeats and nothing else.
// ============================================================================

const BANNER_PATTERN = /^[/*\s]*([=\-*#~])\1{4,}[/*\s]*$/;

function checkDecoration(comment: ExtractedComment): Finding[] {
  const out: Finding[] = [];
  const lines = linesOf(comment.raw);
  lines.forEach(({ text, fenced }, i) => {
    if (fenced) return;
    if (BANNER_PATTERN.test(text)) {
      out.push({
        check: "decoration",
        lineOffset: i,
        excerpt: text.trim(),
        reason: "pure decoration — a run of repeated symbol characters, zero information",
      });
    }
  });
  return out;
}

// ============================================================================
// Entry point
// ============================================================================

export function runChecks(
  comment: ExtractedComment,
  existsPath: (relPath: string) => boolean,
  selfPath?: string,
): Finding[] {
  return [
    ...checkParamRestatement(comment),
    ...checkSignatureRestatement(comment),
    ...checkRottingCount(comment),
    ...checkPathReference(comment, existsPath, selfPath),
    ...checkDecoration(comment),
  ];
}
