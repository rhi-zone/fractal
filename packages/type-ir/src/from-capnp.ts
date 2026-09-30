// Cap'n Proto schema language (https://capnproto.org/language.html) -> TypeRef,
// the reverse direction of capnp.ts's TypeRef -> Cap'n Proto projector
// (toCapnpType/toCapnpStruct/toCapnpInterface).
//
// Cap'n Proto has no widely-used JS parser library and no self-describing
// JSON descriptor format analogous to protobuf's `descriptor.proto` (its
// actual self-description mechanism, `schema.capnp`, is itself a `.capnp`
// schema compiled by `capnp compile` — circular for a from-scratch ingester),
// so this module hand-rolls a recursive-descent parser over the schema
// language's structural grammar: `struct`/`enum` declarations, fields with
// `@N` ordinals, named/anonymous `union`/`group` blocks, `List(T)`, default
// values (`= …`), annotations (`$name(value)`), `#` line-comment doc strings,
// `interface` declarations (methods with parameter/result lists, `extends`,
// generics, nested declarations), and `using`/`import`/`const`/`annotation`
// declarations (recognized and skipped structurally).
//
// Interfaces are parsed into `CapnpInterfaceDecl`s (`parseCapnpSchema`) and
// take part in name resolution, but `fromCapnp` converts only structs and
// enums. A field or parameter naming an interface is an `unknown` TypeRef
// carrying `meta.capnpInterface`; a generic parameter in scope is an
// `unknown` carrying `meta.capnpTypeParam`; a generic instantiation
// `Foo(Text)` is a `ref` to `Foo` carrying `meta.typeArgs`.
//
// `fromCapnp(schema)` returns a flat `Record<string, TypeRef>` — every
// struct/enum in the file (top-level and nested, keyed by dotted path, e.g.
// `"Person"`, `"Person.Address"`) — rather than a `TypeRefDocument`, since
// Cap'n Proto schema files (like protobuf files) commonly declare several
// independent, mutually-referential top-level types with no single "root".
// Struct/enum-typed fields become `{ kind: "ref", target }` pointing at
// another key in the same record.

import { t, types, type TypeRef } from "./index.ts";
import {
  bytes,
  float32,
  float64,
  int16,
  int32,
  int64,
  int8,
  uint16,
  uint32,
  uint64,
  uint8,
} from "./kinds/common.ts";

// ============================================================================
// Tokenizer
// ============================================================================

type TokenType = "id" | "num" | "str" | "punct" | "comment";
type Token = { readonly type: TokenType; readonly value: string; readonly line: number };

const PUNCT = "{}();:@=$,.-><[]";

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      let j = i + 1;
      while (j < n && src[j] !== "\n") j++;
      tokens.push({ type: "comment", value: src.slice(i + 1, j).trim(), line });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) {
          buf += src[j + 1];
          j += 2;
        } else {
          buf += src[j];
          j++;
        }
      }
      tokens.push({ type: "str", value: buf, line });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ type: "id", value: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      if (c === "0" && src[i + 1] === "x") {
        j = i + 2;
        while (j < n && /[0-9a-fA-F]/.test(src[j]!)) j++;
      } else {
        while (j < n && /[0-9.eE+-]/.test(src[j]!)) j++;
      }
      tokens.push({ type: "num", value: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (PUNCT.includes(c)) {
      tokens.push({ type: "punct", value: c, line });
      i++;
      continue;
    }
    // Unrecognized character (whitespace variant, stray symbol) — skip rather
    // than throw, matching this package's honest-degrade convention for
    // malformed/unanticipated input elsewhere (e.g. from-protobuf.ts's
    // dangling-ref fallback).
    i++;
  }
  return tokens;
}

function parseNumber(raw: string): number {
  return raw.startsWith("0x") || raw.startsWith("-0x") ? Number.parseInt(raw, 16) : Number(raw);
}

// ============================================================================
// AST — the subset of the schema grammar this converter cares about
// ============================================================================

export type CapnpTypeDesc = { readonly name: string; readonly args?: readonly CapnpTypeDesc[] };

export type CapnpAnnotation = { readonly name: string; readonly value?: string | number | boolean };

export type CapnpFieldMember = {
  readonly kind: "field";
  readonly name: string;
  readonly ordinal?: number;
  readonly type: CapnpTypeDesc;
  readonly default?: string | number | boolean;
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

export type CapnpGroupMember = {
  readonly kind: "group";
  readonly name: string;
  readonly ordinal?: number;
  readonly members: readonly CapnpMember[];
  /** `struct`/`enum` declarations nested directly inside this group's body —
   * a group is structurally just an inline, unnamed struct (see
   * `convertMembers`'s doc comment), so it can carry the same nested-type
   * declarations a struct body can. */
  readonly nestedStructs: readonly CapnpStructDecl[];
  readonly nestedEnums: readonly CapnpEnumDecl[];
  readonly nestedInterfaces: readonly CapnpInterfaceDecl[];
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

export type CapnpUnionMember = {
  readonly kind: "union";
  /** `undefined` for an anonymous union block (`union { ... }` with no name
   * directly inside a struct — see module doc comment). */
  readonly name?: string;
  readonly ordinal?: number;
  readonly variants: readonly CapnpFieldMember[];
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

export type CapnpMember = CapnpFieldMember | CapnpGroupMember | CapnpUnionMember;

export type CapnpStructDecl = {
  readonly kind: "struct";
  readonly name: string;
  /** The explicit `@0x...` id as written (hex text; 64-bit ids exceed `number` precision). */
  readonly id?: string;
  /** Generic parameter names, in declaration order. */
  readonly typeParams?: readonly string[];
  readonly members: readonly CapnpMember[];
  readonly nestedStructs: readonly CapnpStructDecl[];
  readonly nestedEnums: readonly CapnpEnumDecl[];
  readonly nestedInterfaces: readonly CapnpInterfaceDecl[];
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

/** One entry of a method's parameter list `(name :Type = default, ...)`. Its implicit ordinal is its index. */
export type CapnpMethodParam = {
  readonly name: string;
  readonly type: CapnpTypeDesc;
  readonly default?: string | number | boolean;
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

/** A method's parameter or result side: an inline `(name :Type, ...)` list, or the name of an existing struct type. */
export type CapnpMethodParams =
  | { readonly kind: "list"; readonly params: readonly CapnpMethodParam[] }
  | { readonly kind: "type"; readonly type: CapnpTypeDesc };

export type CapnpMethodDecl = {
  readonly name: string;
  readonly ordinal?: number;
  /** Method-level generic parameter names (`foo @0 [T] (x :T) -> ...`). */
  readonly typeParams?: readonly string[];
  readonly params: CapnpMethodParams;
  /** `stream` is `-> stream`: a flow-controlled call with no results. An omitted `->` is an empty list. */
  readonly results: CapnpMethodParams | { readonly kind: "stream" };
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

export type CapnpInterfaceDecl = {
  readonly kind: "interface";
  readonly name: string;
  /** The explicit `@0x...` id as written (hex text; 64-bit ids exceed `number` precision). */
  readonly id?: string;
  readonly typeParams?: readonly string[];
  /** The `extends(...)` list, as written. */
  readonly extends: readonly CapnpTypeDesc[];
  readonly methods: readonly CapnpMethodDecl[];
  readonly nestedStructs: readonly CapnpStructDecl[];
  readonly nestedEnums: readonly CapnpEnumDecl[];
  readonly nestedInterfaces: readonly CapnpInterfaceDecl[];
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

export type CapnpEnumeratorDecl = {
  readonly name: string;
  readonly ordinal: number;
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

export type CapnpEnumDecl = {
  readonly kind: "enum";
  readonly name: string;
  readonly id?: string;
  readonly members: readonly CapnpEnumeratorDecl[];
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
};

/** A `using`, `const` or `annotation` declaration: recognized but not modeled, recorded so callers can report it. */
export type CapnpSkippedDecl = {
  readonly kind: "using" | "const" | "annotation";
  /** The declared name, when it is a plain identifier (`using import "x".Foo;` has none). */
  readonly name?: string;
  /** The dotted path of the struct/interface that encloses it; absent at file level. */
  readonly scope?: string;
  readonly line?: number;
};

export type CapnpSchemaFile = {
  /** The file-level `@0x...;` id as written. */
  readonly id?: string;
  readonly structs: readonly CapnpStructDecl[];
  readonly enums: readonly CapnpEnumDecl[];
  readonly interfaces: readonly CapnpInterfaceDecl[];
  readonly skipped: readonly CapnpSkippedDecl[];
};

export type CapnpParseOptions = {
  /**
   * When given, a malformed top-level declaration or interface member is
   * reported here and skipped instead of aborting the parse. Absent, the
   * first malformed construct throws.
   */
  readonly onError?: (message: string) => void;
};

// ============================================================================
// Parser
// ============================================================================

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private pendingDescription: string[] = [];
  private readonly skipped: CapnpSkippedDecl[] = [];
  private readonly scope: string[] = [];

  constructor(
    private readonly tokens: readonly Token[],
    private readonly onError?: (message: string) => void,
  ) {}

  private skipComments(): void {
    while (this.pos < this.tokens.length && this.tokens[this.pos]!.type === "comment") {
      this.pendingDescription.push(this.tokens[this.pos]!.value);
      this.pos++;
    }
  }

  private flushDescription(): string | undefined {
    this.skipComments();
    if (this.pendingDescription.length === 0) return undefined;
    const text = this.pendingDescription.join(" ");
    this.pendingDescription = [];
    return text;
  }

  private current(): Token | undefined {
    this.skipComments();
    return this.tokens[this.pos];
  }

  private atEnd(): boolean {
    this.skipComments();
    return this.pos >= this.tokens.length;
  }

  private peekId(value: string): boolean {
    const tok = this.current();
    return tok !== undefined && tok.type === "id" && tok.value === value;
  }

  private peekPunct(value: string): boolean {
    const tok = this.current();
    return tok !== undefined && tok.type === "punct" && tok.value === value;
  }

  private expect(type: TokenType, value?: string): Token {
    const tok = this.current();
    if (tok === undefined || tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new ParseError(
        `expected ${type}${value !== undefined ? ` "${value}"` : ""}, got ${tok === undefined ? "EOF" : `${tok.type} "${tok.value}"`} (line ${tok?.line ?? "?"})`,
      );
    }
    this.pos++;
    return tok;
  }

  /** Skip a `using`/`const`/`annotation` declaration, recording it. */
  private skipDecl(kind: CapnpSkippedDecl["kind"]): void {
    const line = this.current()?.line;
    const next = this.tokens[this.pos + 1];
    const name = next?.type === "id" && next.value !== "import" ? next.value : undefined;
    this.skipped.push({
      kind,
      ...(name !== undefined ? { name } : {}),
      ...(this.scope.length > 0 ? { scope: this.scope.join(".") } : {}),
      ...(line !== undefined ? { line } : {}),
    });
    this.skipUntilSemicolon();
  }

  private skipUntilSemicolon(): void {
    while (!this.atEnd() && !this.peekPunct(";")) this.pos++;
    if (!this.atEnd()) this.pos++; // consume ';'
    this.pendingDescription = [];
  }

  private skipBalancedBraceBlock(): void {
    // Skip tokens up to and including the matching '}' of the next '{' seen
    // (error recovery past a malformed declaration).
    while (!this.atEnd() && !this.peekPunct("{")) this.pos++;
    if (this.atEnd()) return;
    this.pos++; // consume '{'
    let depth = 1;
    while (depth > 0 && !this.atEnd()) {
      if (this.peekPunct("{")) depth++;
      else if (this.peekPunct("}")) depth--;
      this.pos++;
    }
    this.pendingDescription = [];
  }

  private parseAnnotations(): CapnpAnnotation[] {
    const annotations: CapnpAnnotation[] = [];
    while (this.peekPunct("$")) {
      this.pos++;
      let name = this.expect("id").value;
      while (this.peekPunct(".")) {
        this.pos++;
        name += `.${this.expect("id").value}`;
      }
      let value: string | number | boolean | undefined;
      if (this.peekPunct("(")) {
        this.pos++;
        value = this.parseConstValue();
        this.expect("punct", ")");
      }
      annotations.push(value === undefined ? { name } : { name, value });
    }
    return annotations;
  }

  private parseConstValue(): string | number | boolean {
    const tok = this.current();
    if (tok === undefined) throw new ParseError("expected a constant value, got EOF");
    if (tok.type === "punct" && tok.value === "-") {
      this.pos++;
      const magnitude = this.expect("num");
      return -parseNumber(magnitude.value);
    }
    if (tok.type === "num") {
      this.pos++;
      return parseNumber(tok.value);
    }
    if (tok.type === "str") {
      this.pos++;
      return tok.value;
    }
    if (tok.type === "id") {
      this.pos++;
      if (tok.value === "true") return true;
      if (tok.value === "false") return false;
      return tok.value; // bare identifier — an enumerant name or similar
    }
    throw new ParseError(
      `unexpected token in constant value: ${tok.type} "${tok.value}" (line ${tok.line})`,
    );
  }

  private parseType(): CapnpTypeDesc {
    let name = this.expect("id").value;
    while (this.peekPunct(".")) {
      this.pos++;
      name += `.${this.expect("id").value}`;
    }
    let args: CapnpTypeDesc[] | undefined;
    if (this.peekPunct("(")) {
      this.pos++;
      args = [this.parseType()];
      while (this.peekPunct(",")) {
        this.pos++;
        args.push(this.parseType());
      }
      this.expect("punct", ")");
    }
    return args === undefined ? { name } : { name, args };
  }

  private parseUnionVariants(): CapnpFieldMember[] {
    const variants: CapnpFieldMember[] = [];
    while (!this.peekPunct("}")) {
      const description = this.flushDescription();
      const name = this.expect("id").value;
      let ordinal: number | undefined;
      if (this.peekPunct("@")) {
        this.pos++;
        ordinal = parseNumber(this.expect("num").value);
      }
      this.expect("punct", ":");
      const type = this.parseType();
      let defaultValue: string | number | boolean | undefined;
      if (this.peekPunct("=")) {
        this.pos++;
        defaultValue = this.parseConstValue();
      }
      const annotations = this.parseAnnotations();
      this.expect("punct", ";");
      variants.push({
        kind: "field",
        name,
        ...(ordinal !== undefined ? { ordinal } : {}),
        type,
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
        annotations,
        ...(description !== undefined ? { description } : {}),
      });
    }
    return variants;
  }

  private parseStructMember():
    | CapnpMember
    | { readonly kind: "nestedStruct"; readonly decl: CapnpStructDecl }
    | { readonly kind: "nestedEnum"; readonly decl: CapnpEnumDecl }
    | { readonly kind: "nestedInterface"; readonly decl: CapnpInterfaceDecl }
    | { readonly kind: "skip" } {
    const description = this.flushDescription();
    if (this.peekId("struct"))
      return { kind: "nestedStruct", decl: this.parseStructBody(description) };
    if (this.peekId("enum")) return { kind: "nestedEnum", decl: this.parseEnumBody(description) };
    if (this.peekId("interface") && this.tokens[this.pos + 1]?.type === "id") {
      return { kind: "nestedInterface", decl: this.parseInterfaceBody(description) };
    }
    if (this.peekId("const")) {
      this.skipDecl("const");
      return { kind: "skip" };
    }
    if (
      this.peekId("union") &&
      this.tokens[this.pos + 1]?.type === "punct" &&
      this.tokens[this.pos + 1]?.value === "{"
    ) {
      // Anonymous union block, directly inside a struct/group — no name, no
      // ordinal, no trailing ';' (it's a brace block like a nested struct).
      this.pos++; // 'union'
      this.expect("punct", "{");
      const variants = this.parseUnionVariants();
      this.expect("punct", "}");
      return {
        kind: "union",
        variants,
        annotations: [],
        ...(description !== undefined ? { description } : {}),
      };
    }

    const name = this.expect("id").value;
    let ordinal: number | undefined;
    if (this.peekPunct("@")) {
      this.pos++;
      ordinal = parseNumber(this.expect("num").value);
    }
    this.expect("punct", ":");

    if (this.peekId("union")) {
      this.pos++;
      this.expect("punct", "{");
      const variants = this.parseUnionVariants();
      this.expect("punct", "}");
      return {
        kind: "union",
        name,
        ...(ordinal !== undefined ? { ordinal } : {}),
        variants,
        annotations: [],
        ...(description !== undefined ? { description } : {}),
      };
    }
    if (this.peekId("group")) {
      this.pos++;
      this.expect("punct", "{");
      const members: CapnpMember[] = [];
      const nestedStructs: CapnpStructDecl[] = [];
      const nestedEnums: CapnpEnumDecl[] = [];
      const nestedInterfaces: CapnpInterfaceDecl[] = [];
      while (!this.peekPunct("}")) {
        const m = this.parseStructMember();
        if (m.kind === "nestedStruct") nestedStructs.push(m.decl);
        else if (m.kind === "nestedEnum") nestedEnums.push(m.decl);
        else if (m.kind === "nestedInterface") nestedInterfaces.push(m.decl);
        else if (m.kind !== "skip") members.push(m);
      }
      this.expect("punct", "}");
      return {
        kind: "group",
        name,
        ...(ordinal !== undefined ? { ordinal } : {}),
        members,
        nestedStructs,
        nestedEnums,
        nestedInterfaces,
        annotations: [],
        ...(description !== undefined ? { description } : {}),
      };
    }

    const type = this.parseType();
    let defaultValue: string | number | boolean | undefined;
    if (this.peekPunct("=")) {
      this.pos++;
      defaultValue = this.parseConstValue();
    }
    const annotations = this.parseAnnotations();
    this.expect("punct", ";");
    return {
      kind: "field",
      name,
      ...(ordinal !== undefined ? { ordinal } : {}),
      type,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      annotations,
      ...(description !== undefined ? { description } : {}),
    };
  }

  parseStructBody(description?: string): CapnpStructDecl {
    this.expect("id", "struct");
    const name = this.expect("id").value;
    this.scope.push(name);
    try {
      return this.parseStructRest(name, description);
    } finally {
      this.scope.pop();
    }
  }

  private parseStructRest(name: string, description: string | undefined): CapnpStructDecl {
    const header = this.parseDeclHeader();
    const preAnnotations = this.parseAnnotations();
    this.expect("punct", "{");
    const members: CapnpMember[] = [];
    const nestedStructs: CapnpStructDecl[] = [];
    const nestedEnums: CapnpEnumDecl[] = [];
    const nestedInterfaces: CapnpInterfaceDecl[] = [];
    while (!this.peekPunct("}")) {
      const m = this.parseStructMember();
      if (m.kind === "nestedStruct") nestedStructs.push(m.decl);
      else if (m.kind === "nestedEnum") nestedEnums.push(m.decl);
      else if (m.kind === "nestedInterface") nestedInterfaces.push(m.decl);
      else if (m.kind !== "skip") members.push(m);
    }
    this.expect("punct", "}");
    return {
      kind: "struct",
      name,
      ...(header.id !== undefined ? { id: header.id } : {}),
      ...(header.typeParams !== undefined ? { typeParams: header.typeParams } : {}),
      members,
      nestedStructs,
      nestedEnums,
      nestedInterfaces,
      annotations: preAnnotations,
      ...(description !== undefined ? { description } : {}),
    };
  }

  parseEnumBody(description?: string): CapnpEnumDecl {
    this.expect("id", "enum");
    const name = this.expect("id").value;
    const header = this.parseDeclHeader();
    const preAnnotations = this.parseAnnotations();
    this.expect("punct", "{");
    const members: CapnpEnumeratorDecl[] = [];
    let nextOrdinal = 0;
    while (!this.peekPunct("}")) {
      const memberDescription = this.flushDescription();
      const mname = this.expect("id").value;
      let ordinal = nextOrdinal;
      if (this.peekPunct("@")) {
        this.pos++;
        ordinal = parseNumber(this.expect("num").value);
      }
      const annotations = this.parseAnnotations();
      this.expect("punct", ";");
      members.push({
        name: mname,
        ordinal,
        annotations,
        ...(memberDescription !== undefined ? { description: memberDescription } : {}),
      });
      nextOrdinal = ordinal + 1;
    }
    this.expect("punct", "}");
    return {
      kind: "enum",
      name,
      ...(header.id !== undefined ? { id: header.id } : {}),
      members,
      annotations: preAnnotations,
      ...(description !== undefined ? { description } : {}),
    };
  }

  /** The parts of a declaration header that follow its name, in any order: an `@0x...` id and a `(T, U)` generic parameter list. */
  private parseDeclHeader(): { id?: string; typeParams?: string[] } {
    let id: string | undefined;
    let typeParams: string[] | undefined;
    for (;;) {
      if (this.peekPunct("@")) {
        this.pos++;
        id = this.expect("num").value;
      } else if (this.peekPunct("(")) {
        this.pos++;
        typeParams = this.parseNameList(")");
      } else break;
    }
    return {
      ...(id !== undefined ? { id } : {}),
      ...(typeParams !== undefined ? { typeParams } : {}),
    };
  }

  /** Comma-separated identifiers up to and including the closing `close` punctuation. */
  private parseNameList(close: string): string[] {
    const names: string[] = [];
    while (!this.peekPunct(close)) {
      names.push(this.expect("id").value);
      if (this.peekPunct(",")) this.pos++;
      else break;
    }
    this.expect("punct", close);
    return names;
  }

  private parseMethodParamList(): CapnpMethodParam[] {
    this.expect("punct", "(");
    const params: CapnpMethodParam[] = [];
    while (!this.peekPunct(")")) {
      const description = this.flushDescription();
      const name = this.expect("id").value;
      this.expect("punct", ":");
      const type = this.parseType();
      let defaultValue: string | number | boolean | undefined;
      if (this.peekPunct("=")) {
        this.pos++;
        defaultValue = this.parseConstValue();
      }
      const annotations = this.parseAnnotations();
      params.push({
        name,
        type,
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
        annotations,
        ...(description !== undefined ? { description } : {}),
      });
      if (this.peekPunct(",")) this.pos++;
      else break;
    }
    this.expect("punct", ")");
    return params;
  }

  private parseMethodSide(): CapnpMethodParams {
    if (this.peekPunct("(")) return { kind: "list", params: this.parseMethodParamList() };
    return { kind: "type", type: this.parseType() };
  }

  private parseMethod(description: string | undefined): CapnpMethodDecl {
    const name = this.expect("id").value;
    let ordinal: number | undefined;
    if (this.peekPunct("@")) {
      this.pos++;
      ordinal = parseNumber(this.expect("num").value);
    }
    let typeParams: string[] | undefined;
    if (this.peekPunct("[")) {
      this.pos++;
      typeParams = this.parseNameList("]");
    }
    const params = this.parseMethodSide();
    let results: CapnpMethodDecl["results"] = { kind: "list", params: [] };
    if (this.peekPunct("-")) {
      this.pos++;
      this.expect("punct", ">");
      if (this.peekId("stream")) {
        this.pos++;
        results = { kind: "stream" };
      } else {
        results = this.parseMethodSide();
      }
    }
    const annotations = this.parseAnnotations();
    this.expect("punct", ";");
    return {
      name,
      ...(ordinal !== undefined ? { ordinal } : {}),
      ...(typeParams !== undefined ? { typeParams } : {}),
      params,
      results,
      annotations,
      ...(description !== undefined ? { description } : {}),
    };
  }

  parseInterfaceBody(description?: string): CapnpInterfaceDecl {
    this.expect("id", "interface");
    const name = this.expect("id").value;
    this.scope.push(name);
    try {
      return this.parseInterfaceRest(name, description);
    } finally {
      this.scope.pop();
    }
  }

  private parseInterfaceRest(name: string, description: string | undefined): CapnpInterfaceDecl {
    const header = this.parseDeclHeader();
    const base: CapnpTypeDesc[] = [];
    if (this.peekId("extends")) {
      this.pos++;
      this.expect("punct", "(");
      while (!this.peekPunct(")")) {
        base.push(this.parseType());
        if (this.peekPunct(",")) this.pos++;
        else break;
      }
      this.expect("punct", ")");
    }
    const annotations = this.parseAnnotations();
    this.expect("punct", "{");
    const methods: CapnpMethodDecl[] = [];
    const nestedStructs: CapnpStructDecl[] = [];
    const nestedEnums: CapnpEnumDecl[] = [];
    const nestedInterfaces: CapnpInterfaceDecl[] = [];
    while (!this.atEnd() && !this.peekPunct("}")) {
      const memberDescription = this.flushDescription();
      const start = this.pos;
      try {
        if (this.peekId("struct")) nestedStructs.push(this.parseStructBody(memberDescription));
        else if (this.peekId("enum")) nestedEnums.push(this.parseEnumBody(memberDescription));
        else if (this.peekId("interface") && this.tokens[this.pos + 1]?.type === "id") {
          nestedInterfaces.push(this.parseInterfaceBody(memberDescription));
        } else if (this.peekId("const")) this.skipDecl("const");
        else if (this.peekId("annotation")) this.skipDecl("annotation");
        else if (this.peekId("using")) this.skipDecl("using");
        else methods.push(this.parseMethod(memberDescription));
      } catch (e) {
        if (!(e instanceof ParseError) || this.onError === undefined) throw e;
        this.onError(`in interface ${name}: ${e.message}`);
        this.recoverFrom(start);
      }
    }
    this.expect("punct", "}");
    return {
      kind: "interface",
      name,
      ...(header.id !== undefined ? { id: header.id } : {}),
      ...(header.typeParams !== undefined ? { typeParams: header.typeParams } : {}),
      extends: base,
      methods,
      nestedStructs,
      nestedEnums,
      nestedInterfaces,
      annotations,
      ...(description !== undefined ? { description } : {}),
    };
  }

  /** Rewind to the member/declaration starting at token `start` and skip past it: a whole brace block for a block declaration, else up to its `;`. */
  private recoverFrom(start: number): void {
    this.pos = start;
    const first = this.tokens[start];
    const isBlock =
      first?.type === "id" &&
      (first.value === "struct" || first.value === "enum" || first.value === "interface");
    if (isBlock) this.skipBalancedBraceBlock();
    else this.skipUntilSemicolon();
  }

  parseFile(): CapnpSchemaFile {
    const structs: CapnpStructDecl[] = [];
    const enums: CapnpEnumDecl[] = [];
    const interfaces: CapnpInterfaceDecl[] = [];
    let id: string | undefined;
    while (!this.atEnd()) {
      const description = this.flushDescription();
      if (this.peekPunct("@")) {
        // Top-level file ID: `@0xabc123...;`
        const next = this.tokens[this.pos + 1];
        if (id === undefined && next?.type === "num") id = next.value;
        this.skipUntilSemicolon();
        continue;
      }
      const tok = this.current();
      if (tok === undefined) break;
      if (tok.type !== "id") {
        this.pos++;
        continue;
      }
      const start = this.pos;
      try {
        switch (tok.value) {
          case "using":
          case "annotation":
          case "const":
            this.skipDecl(tok.value);
            break;
          case "struct":
            structs.push(this.parseStructBody(description));
            break;
          case "enum":
            enums.push(this.parseEnumBody(description));
            break;
          case "interface":
            interfaces.push(this.parseInterfaceBody(description));
            break;
          default:
            this.pos++;
        }
      } catch (e) {
        if (!(e instanceof ParseError) || this.onError === undefined) throw e;
        this.onError(e.message);
        this.recoverFrom(start);
      }
    }
    return {
      ...(id !== undefined ? { id } : {}),
      structs,
      enums,
      interfaces,
      skipped: this.skipped,
    };
  }
}

/** Parse `.capnp` schema text into its struct/enum/interface declaration
 * tree, without converting to `TypeRef` — exported standalone for
 * callers/tests that want to inspect the parse result directly (mirrors
 * `from-protobuf.ts`'s `parseProtoText` being independently callable from
 * `fromProtoText`). */
export function parseCapnpSchema(source: string, options: CapnpParseOptions = {}): CapnpSchemaFile {
  return new Parser(tokenize(source), options.onError).parseFile();
}

// ============================================================================
// Registry — flatten nested struct/enum/interface declarations (including
// ones declared inside `group` blocks) into dotted-path entries, mirroring
// from-protobuf.ts's registerMessages/registerEnums.
// ============================================================================

export type CapnpRegistryEntry =
  | { readonly kind: "struct"; readonly decl: CapnpStructDecl }
  | { readonly kind: "enum"; readonly decl: CapnpEnumDecl }
  | { readonly kind: "interface"; readonly decl: CapnpInterfaceDecl };

/** Every declaration in a file keyed by dotted path, in declaration order (a parent before its nested declarations). */
export type CapnpRegistry = Map<string, CapnpRegistryEntry>;
type RegistryEntry = CapnpRegistryEntry;

function registerFromMembers(
  members: readonly CapnpMember[],
  scope: string,
  registry: Map<string, RegistryEntry>,
): void {
  for (const m of members) {
    if (m.kind === "group") {
      // Same scope as the enclosing struct — a group is transparent for
      // naming purposes, matching how `registerDecls` qualifies a struct's
      // own nested decls.
      registerDecls(m.nestedStructs, m.nestedEnums, m.nestedInterfaces, scope, registry);
      registerFromMembers(m.members, scope, registry);
    }
  }
}

function registerDecls(
  structs: readonly CapnpStructDecl[],
  enums: readonly CapnpEnumDecl[],
  interfaces: readonly CapnpInterfaceDecl[],
  prefix: string,
  registry: Map<string, RegistryEntry>,
): void {
  for (const s of structs) {
    const qualified = prefix === "" ? s.name : `${prefix}.${s.name}`;
    registry.set(qualified, { kind: "struct", decl: s });
    registerDecls(s.nestedStructs, s.nestedEnums, s.nestedInterfaces, qualified, registry);
    registerFromMembers(s.members, qualified, registry);
  }
  for (const e of enums) {
    const qualified = prefix === "" ? e.name : `${prefix}.${e.name}`;
    registry.set(qualified, { kind: "enum", decl: e });
  }
  for (const i of interfaces) {
    const qualified = prefix === "" ? i.name : `${prefix}.${i.name}`;
    registry.set(qualified, { kind: "interface", decl: i });
    registerDecls(i.nestedStructs, i.nestedEnums, i.nestedInterfaces, qualified, registry);
  }
}

/** Index every declaration of a parsed file under its dotted path. */
export function buildCapnpRegistry(file: CapnpSchemaFile): CapnpRegistry {
  const registry: CapnpRegistry = new Map();
  registerDecls(file.structs, file.enums, file.interfaces, "", registry);
  return registry;
}

/** Resolve a type name (possibly dotted, e.g. `Outer.Inner`) against the flat
 * registry: exact match, then self/enclosing scope search outward (Cap'n
 * Proto's own nested-scoping rules — https://capnproto.org/language.html#nested-types),
 * then a last-resort suffix match. Falls back to the raw name unresolved
 * (a dangling `ref`) rather than throwing, matching from-protobuf.ts's
 * `resolveTypeName` convention. */
export function resolveCapnpTypeName(
  name: string,
  registry: Map<string, RegistryEntry>,
  selfPath: string,
): string {
  if (registry.has(name)) return name;

  const parts = selfPath === "" ? [] : selfPath.split(".");
  for (let i = parts.length; i >= 0; i--) {
    const candidate = [...parts.slice(0, i), name].join(".");
    if (registry.has(candidate)) return candidate;
  }

  const suffix = `.${name}`;
  for (const key of registry.keys()) {
    if (key === name || key.endsWith(suffix)) return key;
  }

  return name;
}

// ============================================================================
// Type conversion
// ============================================================================

// Built-in types: https://capnproto.org/language.html#built-in-types
const builtinHandlers: Record<string, () => TypeRef> = {
  Void: () => t(types.void),
  Bool: () => t(types.boolean),
  Int8: () => int8(),
  Int16: () => int16(),
  Int32: () => int32(),
  Int64: () => int64(),
  UInt8: () => uint8(),
  UInt16: () => uint16(),
  UInt32: () => uint32(),
  UInt64: () => uint64(),
  Float32: () => float32(),
  Float64: () => float64(),
  Text: () => t(types.string),
  Data: () => bytes(),
  // Opaque/reflective Cap'n Proto constructs with no structural TypeRef
  // equivalent — degrade to `unknown`, the reverse of capnp.ts's own
  // AnyPointer fallback for `unknown`/`instance`/`function`/etc.
  AnyPointer: () => t(types.unknown),
  AnyStruct: () => t(types.unknown),
  AnyList: () => t(types.unknown),
  Capability: () => t(types.unknown),
};

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref;
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } };
}

const NO_PARAMS: ReadonlySet<string> = new Set();

/** Convert a type reference. `params` are the generic parameter names in scope: each converts to `unknown` tagged `meta.capnpTypeParam`. */
export function fromCapnpTypeDesc(
  desc: CapnpTypeDesc,
  registry: Map<string, RegistryEntry>,
  selfPath: string,
  params: ReadonlySet<string> = NO_PARAMS,
): TypeRef {
  if (params.has(desc.name)) return t(types.unknown, { capnpTypeParam: desc.name });
  if (desc.name === "List") {
    const elementDesc = desc.args?.[0];
    const element =
      elementDesc !== undefined
        ? fromCapnpTypeDesc(elementDesc, registry, selfPath, params)
        : t(types.unknown);
    return t(types.array(element));
  }
  const builtin = builtinHandlers[desc.name];
  if (builtin !== undefined) return builtin();

  const resolved = resolveCapnpTypeName(desc.name, registry, selfPath);
  const base =
    registry.get(resolved)?.kind === "interface"
      ? t(types.unknown, { capnpInterface: resolved })
      : t(types.ref(resolved));
  if (desc.args === undefined) return base;
  return withMeta(base, {
    typeArgs: desc.args.map((a) => fromCapnpTypeDesc(a, registry, selfPath, params)),
  });
}

function memberMeta(m: {
  readonly ordinal?: number;
  readonly annotations: readonly CapnpAnnotation[];
  readonly description?: string;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (m.ordinal !== undefined) meta.ordinal = m.ordinal;
  if (m.annotations.length > 0) meta.annotations = m.annotations;
  if (m.description !== undefined) meta.description = m.description;
  return meta;
}

/** Convert a single field's declared type + default/annotations/ordinal into
 * a `TypeRef` — exported standalone so a lone field can be converted without
 * a whole struct/file around it (mirrors from-protobuf.ts's `fromProtoField`). */
export function fromCapnpField(
  field: CapnpFieldMember,
  registry: Map<string, RegistryEntry> = new Map(),
  selfPath = "",
  params: ReadonlySet<string> = NO_PARAMS,
): TypeRef {
  const base = fromCapnpTypeDesc(field.type, registry, selfPath, params);
  const meta = memberMeta(field);
  if (field.default !== undefined) meta.default = field.default;
  return withMeta(base, meta);
}

/** Convert a struct/group's member list into an `object`-field record —
 * shared by top-level struct conversion and nested `group` conversion, since
 * a group is structurally just an inline, unnamed struct
 * (https://capnproto.org/language.html#groups). */
function convertMembers(
  members: readonly CapnpMember[],
  registry: Map<string, RegistryEntry>,
  selfPath: string,
  params: ReadonlySet<string>,
): Record<string, TypeRef> {
  const fields: Record<string, TypeRef> = {};
  let anonUnionCount = 0;

  for (const m of members) {
    if (m.kind === "field") {
      fields[m.name] = fromCapnpField(m, registry, selfPath, params);
      continue;
    }
    if (m.kind === "group") {
      fields[m.name] = withMeta(
        t(types.object(convertMembers(m.members, registry, selfPath, params))),
        memberMeta(m),
      );
      continue;
    }
    // m.kind === "union": a Cap'n Proto union always has exactly one active
    // variant (no "unset" state, unlike protobuf's oneof — see
    // from-protobuf.ts's messageToTypeRef oneof handling for the contrast),
    // so no `meta.optional` is added here.
    const variants = m.variants.map((v) =>
      withMeta(fromCapnpField(v, registry, selfPath, params), { capnpFieldName: v.name }),
    );
    const key = m.name ?? `__anonymousUnion${anonUnionCount++}`;
    const meta = memberMeta(m);
    if (m.name === undefined) meta.anonymous = true;
    fields[key] = withMeta(t(types.union(variants)), meta);
  }

  return fields;
}

function structToTypeRef(
  decl: CapnpStructDecl,
  registry: Map<string, RegistryEntry>,
  selfPath: string,
): TypeRef {
  const meta: Record<string, unknown> = {};
  if (decl.description !== undefined) meta.description = decl.description;
  if (decl.annotations.length > 0) meta.annotations = decl.annotations;
  if (decl.id !== undefined) meta.capnpId = decl.id;
  if (decl.typeParams !== undefined) meta.typeParams = decl.typeParams;
  const params = decl.typeParams === undefined ? NO_PARAMS : new Set(decl.typeParams);
  return t(types.object(convertMembers(decl.members, registry, selfPath, params)), meta);
}

function enumToTypeRef(decl: CapnpEnumDecl): TypeRef {
  // Cap'n Proto enumerants are assigned sequential ordinals by declaration
  // order by default (§ "Enums") but may be declared out of order — sort by
  // ordinal so `members`' array order matches wire order, and keep the exact
  // name -> ordinal mapping in meta for callers that need it precisely
  // (`types.enum`'s `members` is a bare name array with no numbering slot).
  const sorted = [...decl.members].sort((a, b) => a.ordinal - b.ordinal);
  const meta: Record<string, unknown> = {
    ordinals: Object.fromEntries(sorted.map((m) => [m.name, m.ordinal])),
  };
  if (decl.description !== undefined) meta.description = decl.description;
  if (decl.annotations.length > 0) meta.annotations = decl.annotations;
  if (decl.id !== undefined) meta.capnpId = decl.id;
  return t(types.enum(sorted.map((m) => m.name)), meta);
}

// ============================================================================
// File-level entry point
// ============================================================================

/**
 * The struct/enum entries of `registry` as a flat map of dotted name ->
 * `TypeRef`. Interface entries have no `TypeRef` of their own and are
 * omitted.
 */
export function fromCapnpRegistry(registry: CapnpRegistry): Record<string, TypeRef> {
  const result: Record<string, TypeRef> = {};
  for (const [name, entry] of registry) {
    if (entry.kind === "struct") result[name] = structToTypeRef(entry.decl, registry, name);
    else if (entry.kind === "enum") result[name] = enumToTypeRef(entry.decl);
  }
  return result;
}

/**
 * Convert `.capnp` schema text into a flat map of struct/enum name ->
 * `TypeRef` — every struct/enum in the file, top-level and nested (keyed by
 * dotted path, e.g. `"Person"`, `"Person.Address"`), with struct/enum-typed
 * fields resolved to `{ kind: "ref", target }` pointing at another key in
 * the same map (see module doc comment for why this is a flat record rather
 * than a single-root `TypeRefDocument`).
 */
export function fromCapnp(schema: string): Record<string, TypeRef> {
  return fromCapnpRegistry(buildCapnpRegistry(parseCapnpSchema(schema)));
}
