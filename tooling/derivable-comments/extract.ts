// tooling/derivable-comments/extract.ts
//
// Comment extraction + declaration-signature association. No hashing, no
// manifest, no approval state — this module answers "what comments exist,
// and what does the declaration above each one actually declare", nothing
// more. checks.ts asks whether the comment's content is recoverable from
// that declaration.
//
// Extraction walks a real parsed AST (`ts.createSourceFile` +
// `ts.get*CommentRanges`) rather than a hand-rolled regex/state-machine over
// `//`/`/* */` — a scanner alone can't tell a comment from a `/` inside a
// regex literal or a `"//"` string; that disambiguation is a parser
// decision. `typescript` is already a root devDependency and this is the
// same primitive `packages/type-ir/src/from-typescript.ts` and
// `packages/api-tree/src/extract.ts` build on — no new parsing machinery
// needed. This tool never needs a `ts.Program`/`TypeChecker` (no cross-file
// type resolution, no inference): every check below is a syntactic fact —
// a parameter's own written type annotation, a function's own written
// return-type annotation, a same-file interface's own field names — so a
// bare `ts.createSourceFile` per file is enough and stays cheap.

import ts from "typescript";

export type CommentKind = "line" | "block";

/** Syntactic facts about the declaration a comment sits directly above.
 *  Absent (`undefined` on `ExtractedComment.facts`) when the comment isn't
 *  the leading comment of a function-like declaration (e.g. it's mid-body,
 *  or above an interface/const-that-isn't-a-function) — the signature
 *  checks simply don't run for those comments. */
export interface DeclarationFacts {
  readonly name?: string | undefined;
  readonly params: ReadonlyArray<{ readonly name: string; readonly typeText?: string | undefined }>;
  readonly returnTypeText?: string | undefined;
  /** paramName -> set of field names, resolved only for params whose type
   *  is a bare identifier naming an `interface`/`type` declared in the SAME
   *  file. Cross-file/library types are left unresolved (empty set) rather
   *  than guessed at — a param whose field can't be verified never
   *  contributes a false "restates the signature" match. */
  readonly localFields: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ExtractedComment {
  readonly kind: CommentKind;
  /** Raw source text, delimiters included; a contiguous same-column run of
   *  `//` lines is joined with "\n" into one logical comment (matches how a
   *  `//` paragraph reads, and how a `/* *​/` block already is one unit). */
  readonly raw: string;
  /** 1-based line the comment starts on. */
  readonly line: number;
  readonly facts?: DeclarationFacts | undefined;
}

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

export function isSourceFile(fileName: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

interface RawRange {
  readonly kind: CommentKind;
  readonly pos: number;
  readonly end: number;
  readonly line: number; // 1-based
  readonly column: number; // 0-based
}

/** Same-file `interface`/`type X = { ... }` field names, keyed by type name.
 *  Deliberately shallow (own members only, no `extends`/intersection
 *  resolution) — a field this misses just never contributes a match,
 *  favoring precision over completeness. */
function localTypeFields(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const membersOf = (members: ts.NodeArray<ts.TypeElement>) => {
    const fields = new Set<string>();
    for (const m of members) {
      if (
        (ts.isPropertySignature(m) || ts.isMethodSignature(m)) &&
        m.name &&
        ts.isIdentifier(m.name)
      ) {
        fields.add(m.name.text);
      }
    }
    return fields;
  };
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      out.set(stmt.name.text, membersOf(stmt.members));
    } else if (ts.isTypeAliasDeclaration(stmt) && ts.isTypeLiteralNode(stmt.type)) {
      out.set(stmt.name.text, membersOf(stmt.type.members));
    }
  }
  return out;
}

function buildFacts(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration,
  name: string | undefined,
  typeFields: ReadonlyMap<string, Set<string>>,
): DeclarationFacts {
  const params = fn.parameters.map((p) => ({
    name: ts.isIdentifier(p.name) ? p.name.text : p.name.getText(),
    typeText: p.type?.getText().trim(),
  }));
  const localFields = new Map<string, ReadonlySet<string>>();
  for (const p of params) {
    if (!p.typeText) continue;
    const bareName = /^[A-Za-z_$][\w$]*$/.test(p.typeText) ? p.typeText : undefined;
    const fields = bareName ? typeFields.get(bareName) : undefined;
    if (fields) localFields.set(p.name, fields);
  }
  return {
    name,
    params,
    returnTypeText: fn.type?.getText().trim(),
    localFields,
  };
}

/** Resolve a declaration-like statement/node to the function-like node (and
 *  its declared name) whose signature a leading comment above it documents.
 *  Handles `function f() {}`, `const f = () => {}` / `const f = function(){}`
 *  (leading trivia attaches to the VariableStatement, not the initializer),
 *  and class/object method declarations. Anything else (interfaces, plain
 *  const values, type aliases) yields `undefined` — those comments still
 *  get extracted, just without signature facts. */
function resolveFunctionDecl(node: ts.Node):
  | {
      fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
      name?: string | undefined;
    }
  | undefined {
  if (ts.isFunctionDeclaration(node)) return { fn: node, name: node.name?.text };
  if (ts.isMethodDeclaration(node)) {
    return { fn: node, name: ts.isIdentifier(node.name) ? node.name.text : undefined };
  }
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    if (
      decl &&
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
    ) {
      return {
        fn: decl.initializer,
        name: ts.isIdentifier(decl.name) ? decl.name.text : undefined,
      };
    }
  }
  return undefined;
}

export function extractComments(sourceText: string, fileName = "file.ts"): ExtractedComment[] {
  // setParentNodes: true — required for node.getText()/parent-chain lookups
  // used below (param/return type text, statement resolution); the old
  // comment-approval tool's extractor didn't need it because it never called
  // getText() on anything, only sliced raw comment ranges out of sourceText.
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );
  const typeFields = localTypeFields(sourceFile);

  const seen = new Set<string>();
  const rawRanges: RawRange[] = [];
  // Keyed by the END offset of a declaration's last leading comment range —
  // lets a finished comment group look itself up by its own end position.
  const declByCommentEnd = new Map<number, DeclarationFacts>();

  function addRanges(found: readonly ts.CommentRange[] | undefined) {
    if (!found) return;
    for (const range of found) {
      const key = `${range.pos}:${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, range.pos);
      rawRanges.push({
        kind: range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block",
        pos: range.pos,
        end: range.end,
        line: line + 1,
        column: character,
      });
    }
  }

  function visit(node: ts.Node) {
    addRanges(ts.getLeadingCommentRanges(sourceText, node.getFullStart()));
    addRanges(ts.getTrailingCommentRanges(sourceText, node.getEnd()));
    const resolved = resolveFunctionDecl(node);
    if (resolved) {
      const leading = ts.getLeadingCommentRanges(sourceText, node.getFullStart());
      if (leading && leading.length > 0) {
        declByCommentEnd.set(
          leading[leading.length - 1]!.end,
          buildFacts(resolved.fn, resolved.name, typeFields),
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  addRanges(ts.getLeadingCommentRanges(sourceText, sourceFile.endOfFileToken.getFullStart()));
  addRanges(ts.getTrailingCommentRanges(sourceText, sourceFile.endOfFileToken.getFullStart()));
  rawRanges.sort((a, b) => a.pos - b.pos);

  // Group consecutive "line" ranges at the same column, one source line
  // apart, into a single logical comment (matches how a `//` paragraph
  // reads as one unit, same as an old `/* */` block already does).
  const groups: RawRange[][] = [];
  for (const range of rawRanges) {
    const prevGroup = groups[groups.length - 1];
    const prev = prevGroup?.[prevGroup.length - 1];
    if (
      prev &&
      prev.kind === "line" &&
      range.kind === "line" &&
      range.line === prev.line + 1 &&
      range.column === prev.column
    ) {
      prevGroup!.push(range);
    } else {
      groups.push([range]);
    }
  }

  return groups.map((group) => {
    const kind = group[0]!.kind;
    const raw = group.map((r) => sourceText.slice(r.pos, r.end)).join("\n");
    const lastEnd = group[group.length - 1]!.end;
    return {
      kind,
      raw,
      line: group[0]!.line,
      facts: declByCommentEnd.get(lastEnd),
    };
  });
}
