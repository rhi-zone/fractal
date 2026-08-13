// tooling/comment-approval/comments.ts
//
// Pure comment-extraction + hashing. No filesystem, no git, no CLI — those
// live in manifest.ts and cli.ts respectively, so this module is trivially
// unit-testable against inline source strings.
//
// Extraction walks a real parsed AST (`ts.createSourceFile` + `ts.get*CommentRanges`)
// rather than a hand-rolled regex/state-machine over `//`/`/*`/`*/`, or even a
// standalone `ts.createScanner` loop — both would have to separately
// reimplement string/template/regex-literal awareness to avoid treating
// `"// not a comment"` or a regex literal containing `/*` as a comment. Only
// the real parser resolves that ambiguity correctly (see extractComments's
// own doc comment for why). `typescript` is already a root devDependency
// (see package.json), so this costs nothing new to depend on.
//
// Scope: every `//` line comment and `/* */` block comment (JSDoc `/** */`
// is syntactically a block comment — no separate handling needed) in a
// `.ts`/`.tsx`/`.js`/`.jsx`/`.mts`/`.cts` file. A contiguous run of `//`
// lines at the same indentation, with no blank/code line between them, is
// treated as ONE logical comment (matching how a person reads a `//`
// paragraph, and how a `/* */` block already is one unit) — see
// extractComments's grouping note. Explicitly NOT extracted: shebang lines
// (`#!/usr/bin/env bun` — a directive, not prose) and anything inside a
// string/template/regex literal (never trivia in the first place — it's
// part of the literal).

import ts from "typescript"

export type CommentKind = "line" | "block"

export interface ExtractedComment {
  readonly kind: CommentKind
  /** Raw source text of the comment, including its `//`/`/*`/`*​/` delimiters. */
  readonly raw: string
  /** Delimiter-stripped, reindentation-normalized text — see normalizeComment. */
  readonly normalized: string
  /** sha256 hex digest of `normalized`. This is the identity `manifest.ts` tracks. */
  readonly hash: string
  /** 1-based line the comment starts on, for human-facing reports only — never
   *  part of identity (comments moving around must not invalidate approval,
   *  per the whole point of hashing content instead of position). */
  readonly line: number
}

/** File extensions this tool considers source — matches the languages the
 *  TypeScript scanner can tokenize. Anything else (`.md`, `.json`, `.sh`, …)
 *  is out of scope: those don't have `//`/`/* *​/`-style comments in the
 *  first place, or (for `.sh`) use a wholly different comment syntax this
 *  scanner doesn't understand. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"] as const

export function isSourceFile(fileName: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => fileName.endsWith(ext))
}

/** Strips comment delimiters and normalizes incidental formatting that
 *  carries no meaning change, so a comment's hash survives the kind of edit
 *  that shouldn't force re-review:
 *
 *  - For a "line" comment, `raw` may be several `//`-prefixed physical lines
 *    joined with `"\n"` (extractComments merges a contiguous same-indentation
 *    run into one logical comment) — the `//` (and one optional following
 *    space) is stripped from EACH line independently.
 *  - For a "block" comment, the wrapping `/*` / `*​/` are removed, and a
 *    single leading `*` (with one optional following space) is stripped per
 *    line — the conventional JSDoc continuation-line decoration
 *    (`/**\n * like this\n *​/`). Reflowing/realigning that decoration (e.g.
 *    a formatter changing indentation) doesn't change what the comment says.
 *  - Every line is trimmed of leading/trailing whitespace.
 *  - Leading/trailing blank lines are dropped.
 *
 *  Deliberately NOT normalized: internal wording, punctuation, or blank
 *  lines in the middle of a comment — those are content, and a change there
 *  is exactly the kind of change that should force re-approval. */
export function normalizeComment(raw: string, kind: CommentKind): string {
  let lines: string[]
  if (kind === "line") {
    lines = raw.split("\n").map((line) => line.replace(/^\s*\/\/\s?/, "").trim())
  } else {
    const body = raw.replace(/^\/\*/, "").replace(/\*\/$/, "")
    lines = body.split("\n").map((line) => line.replace(/^\s*\*\s?/, "").trim())
  }

  while (lines.length > 0 && lines[0] === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  return lines.join("\n")
}

export async function hashText(text: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(text)
  return hasher.digest("hex")
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

interface RawRange {
  readonly kind: CommentKind
  readonly pos: number
  readonly end: number
  readonly line: number // 1-based
  readonly column: number // 0-based
}

/** Extracts every `//` and `/* *​/` comment from `sourceText`, in source
 *  order. `fileName` only picks TS/TSX/JS/JSX parsing mode — extraction
 *  never reads the file itself.
 *
 *  Walks the real parsed AST (`ts.createSourceFile`) and asks
 *  `ts.get{Leading,Trailing}CommentRanges` for the trivia around every
 *  node's start/end (plus the end-of-file token's, which catches trailing
 *  comments after the last statement). This — not a standalone
 *  `ts.createScanner` loop — is what correctly disambiguates `/` as
 *  division vs. the start of a regex literal: that disambiguation is
 *  inherently a *parser* decision (it depends on whether an expression is
 *  expected at that position), which only the real parser resolves
 *  correctly. A bare scanner has no such context and will misparse a regex
 *  literal containing `/*` or `//` as a comment. Both leading (comment
 *  preceded by a line break) and trailing (comment on the same line as the
 *  preceding token, e.g. `const x = 1 // hi`) ranges are collected at every
 *  node, deduped by position — TS treats those as two different trivia
 *  categories and a same-line trailing comment would otherwise be missed.
 *
 *  A contiguous run of `//` line comments — same starting column, each on
 *  the very next line after the previous one — is merged into ONE logical
 *  `ExtractedComment`: that's how a multi-line `//` paragraph reads to a
 *  person (and it's already how a `/* *​/` block comment behaves, being a
 *  single token). Without merging, a 10-line `//` paragraph would hash as
 *  ten independent one-line comments, which is both a much noisier manifest
 *  (ten near-identical excerpts instead of one) and a poor match for how
 *  review actually happens (a paragraph is read and approved as a unit).
 *  The same-column requirement keeps a trailing same-line comment
 *  (`const x = 1 // hi`, typically far to the right) from accidentally
 *  swallowing a following standalone `//` paragraph that starts at the
 *  code's own indentation. */
export async function extractComments(sourceText: string, fileName = "file.ts"): Promise<ExtractedComment[]> {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ false, scriptKindFor(fileName))

  const seen = new Set<string>()
  const rawRanges: RawRange[] = []

  function addRanges(found: readonly ts.CommentRange[] | undefined) {
    if (!found) return
    for (const range of found) {
      const key = `${range.pos}:${range.end}`
      if (seen.has(key)) continue
      seen.add(key)
      const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, range.pos)
      rawRanges.push({
        kind: range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block",
        pos: range.pos,
        end: range.end,
        line: line + 1,
        column: character,
      })
    }
  }

  function visit(node: ts.Node) {
    addRanges(ts.getLeadingCommentRanges(sourceText, node.getFullStart()))
    addRanges(ts.getTrailingCommentRanges(sourceText, node.getEnd()))
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  addRanges(ts.getLeadingCommentRanges(sourceText, sourceFile.endOfFileToken.getFullStart()))
  addRanges(ts.getTrailingCommentRanges(sourceText, sourceFile.endOfFileToken.getFullStart()))
  rawRanges.sort((a, b) => a.pos - b.pos)

  // Group consecutive "line" ranges at the same column, one source line
  // apart, into a single logical comment (see doc comment above).
  const groups: RawRange[][] = []
  for (const range of rawRanges) {
    const prevGroup = groups[groups.length - 1]
    const prev = prevGroup?.[prevGroup.length - 1]
    if (prev && prev.kind === "line" && range.kind === "line" && range.line === prev.line + 1 && range.column === prev.column) {
      prevGroup!.push(range)
    } else {
      groups.push([range])
    }
  }

  const out: ExtractedComment[] = []
  for (const group of groups) {
    const kind = group[0]!.kind
    const raw = group.map((r) => sourceText.slice(r.pos, r.end)).join("\n")
    const normalized = normalizeComment(raw, kind)
    out.push({
      kind,
      raw,
      normalized,
      hash: await hashText(normalized),
      line: group[0]!.line,
    })
  }

  return out
}
