// packages/type-ir/src/codegen-helpers.ts — @rhi-zone/fractal-type-ir
//
// Small structural helpers shared across projector files (java-gson.ts,
// rust-serde.ts, python-pydantic.ts, …). Every function here was previously
// reimplemented byte-for-byte (module-local, unexported) in each projector
// that needed it — this module is the single canonical copy. Domain-specific
// mapping logic (TypeShape -> target-language syntax) stays in each
// projector; only scaffolding this generic is consolidated here.
//
// Where an ecosystem family needs a *different* implementation (e.g. Java's
// always-multiline `/** */` doc comment vs Kotlin's collapse-to-one-line
// variant), both variants are exported under distinct names rather than
// force-unified — see each group's doc comment below for which projectors
// share which variant.

import { ancestors } from "./index.ts";

// ============================================================================
// Identifier casing
// ============================================================================

/** Uppercases the first character; empty string passes through unchanged.
 * The single most duplicated helper in this package — every projector that
 * needs a PascalCase getter/setter/method name from a camelCase field name
 * (`name` -> `Name` for `getName`/`setName`) had its own copy. */
export function capitalize(name: string): string {
  return name.length === 0 ? name : name[0]!.toUpperCase() + name.slice(1);
}

/** Splits `name` on runs of non-alphanumeric characters, capitalizes each
 * part, and joins — turning an arbitrary field/JSON name into a Go-style
 * exported identifier. Never returns empty (falls back to `"Field"`) and
 * prefixes a leading underscore when the result would start with a digit
 * (an invalid Go identifier start). Shared by the `go-*` projector family
 * (go-jsoniter, go-sonic, go-easyjson, go-encoding-json). */
export function goFieldIdent(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0);
  const joined = parts.map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
  if (joined.length === 0) return "Field";
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

/** Splits `name` into words on camelCase boundaries and `_`/`-`/whitespace
 * runs. Shared by elm-json.ts and rescript-native.ts as the basis for both
 * projectors' `toPascalCase`/`toCamelCase`. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** PascalCase via `splitWords` — capitalize each word, lowercase the rest,
 * join with no separator. Shared by elm-json.ts and rescript-native.ts. */
export function toPascalCaseFromWords(name: string): string {
  return splitWords(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

/** camelCase via `toPascalCaseFromWords`, lowercasing the leading character.
 * Shared by elm-json.ts. */
export function toCamelCaseFromWords(name: string): string {
  const pascal = toPascalCaseFromWords(name);
  return pascal.length === 0 ? pascal : pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** PascalCase by stripping non-alphanumeric runs and uppercasing the
 * character that follows each one (plus the leading character). Shared by
 * gleam-native.ts, rust-serde.ts, and wasm-bindgen.ts — distinct from
 * `toPascalCaseFromWords` above (that variant also lowercases the remainder
 * of each word; this one leaves internal casing alone, matching Rust/Gleam
 * convention for already-mixed-case identifiers). */
export function toPascalCaseStripSeparators(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string | undefined) =>
    c ? c.toUpperCase() : "",
  );
  return cleaned.length === 0 ? cleaned : cleaned[0]!.toUpperCase() + cleaned.slice(1);
}

/** camelCase by stripping `-`/`_`/whitespace runs and uppercasing the
 * character that follows each one, then lowercasing the leading character.
 * Shared by the `swift-*` projector family (swift-codable, swift-objectmapper,
 * swift-swiftyjson). */
export function toCamelCaseStripSeparators(name: string): string {
  const camel = name.replace(/[-_\s]+(.)?/g, (_, c: string | undefined) =>
    c ? c.toUpperCase() : "",
  );
  return camel.length === 0 ? camel : camel[0]!.toLowerCase() + camel.slice(1);
}

/** snake_case by inserting `_` at camelCase boundaries, replacing any other
 * non-alphanumeric run with `_`, trimming leading/trailing `_`, and
 * lowercasing. Shared by gleam-native.ts, rust-serde.ts, and wasm-bindgen.ts. */
export function toSnakeCaseStripSeparators(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** snake_case by inserting `_` at camelCase boundaries and between a
 * trailing-acronym run and the capitalized word after it (`HTTPHeader` ->
 * `HTTP_Header` before lowercasing), then lowercasing. No separator
 * stripping/trimming — inputs are assumed to already be valid identifier
 * characters. Shared by crystal-json-serializable.ts, dart-built-value.ts,
 * and dart-freezed.ts. */
export function toSnakeCaseAcronymAware(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

// ============================================================================
// Subtype check
// ============================================================================

/** `kind` is `target` or has `target` among its registered ancestors (see
 * `ancestors` in ./index.ts) — the standard "is this shape usable where a
 * `target` is expected" check every projector with kind-specific branches
 * (e.g. "is this an int32/int64 refinement of `integer`?") needs. */
export function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target);
}

// ============================================================================
// Quoting
// ============================================================================

/** JSON-quotes `value` (`JSON.stringify`) — the default string-literal
 * quoting for every target whose string-literal syntax is JSON-compatible
 * (C-family, Java/Kotlin, Python, Ruby, Rust, Go, PHP, C#, Haskell, …).
 * Typed to accept `unknown` so it also covers call sites (e.g.
 * mkdocs-reference.ts) that quote non-string values. */
export function quote(value: unknown): string {
  return JSON.stringify(value);
}

/** JSON-quotes `name` only when it isn't already a valid bare TS/JS
 * identifier (object-key position) — otherwise returns it unquoted. Shared
 * by the TypeScript-schema-library projector family (typescript-zod,
 * typescript-io-ts, typescript-yup, typescript-typebox, typescript-runtypes,
 * typescript-superstruct, typescript-effect-schema, typescript-arktype). */
export function quoteKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Single-quotes `value` for Dart string-literal syntax, backslash-escaping
 * `\`, `'`, and `$` (Dart string interpolation's sigil — an unescaped `$`
 * in a single-quoted Dart string is still an interpolation trigger).
 * Shared by dart-built-value.ts, dart-freezed.ts, and
 * dart-json-serializable.ts. */
export function quoteDart(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$");
  return `'${escaped}'`;
}

// ============================================================================
// Options resolution
// ============================================================================

/** Merges caller-supplied `options` over `defaults`, producing a fully
 * resolved `Required<T>`. Every projector with a `*Options` type (JavaOptions,
 * KotlinGsonOptions, …) reimplemented this as a one-line spread; generic here
 * since the merge itself doesn't depend on what `T` is. */
export function resolveOptions<T extends object>(defaults: Required<T>, options?: T): Required<T> {
  return { ...defaults, ...options };
}

// ============================================================================
// Indentation
// ============================================================================

/** Prepends 4 spaces to every non-empty line of `text`. Shared by the
 * `csharp-*` projector family (csharp-newtonsoft, csharp-servicestack,
 * csharp-systemtextjson). */
export function indent4(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `    ${line}`))
    .join("\n");
}

/** Splits `text` into lines and prepends `spaces` spaces to each non-empty
 * one, returning the line array (not rejoined — callers interleave it with
 * other already-split lines). Shared by swift-codable.ts and
 * swift-objectmapper.ts. */
export function indentLines(text: string, spaces: number): string[] {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((line) => (line.length === 0 ? line : `${pad}${line}`));
}

// ============================================================================
// Doc comments
// ============================================================================

type Meta = Readonly<Record<string, unknown>>;

/** Java-style `/** … *&#47;` doc comment: always multiline (opening `/**`
 * and closing ` *&#47;` on their own lines) even for a lone description or a
 * lone `@deprecated`. `indent` is prepended to every interior line and to
 * the trailing return (so callers can splice the result directly before a
 * declaration at that indent depth). Returns `""` when there's neither a
 * description nor a deprecation flag. Shared by java-gson.ts,
 * java-jackson.ts, java-moshi.ts, and java-jsonb.ts. */
export function javaDocComment(meta: Meta, indent: string): string {
  const description = typeof meta.description === "string" ? meta.description : undefined;
  const deprecated = meta.deprecated === true;
  if (description === undefined && !deprecated) return "";
  const lines = ["/**"];
  if (description !== undefined) lines.push(`${indent} * ${description}`);
  if (deprecated) lines.push(`${indent} * @deprecated`);
  lines.push(`${indent} */`);
  return `${lines.join("\n")}\n${indent}`;
}

/** Kotlin-style `/** … *&#47;` doc comment: collapses to a single line
 * (`/** description *&#47;`) when only a description or only `@deprecated` is
 * present, multiline only when both are. `indent` is prepended to every
 * line. Returns `""` when there's neither a description nor a deprecation
 * flag. Shared by kotlin-gson.ts, kotlin-jackson.ts, and kotlin-kotlinx.ts. */
export function kotlinDocComment(meta: Meta, indent: string): string {
  const description = typeof meta.description === "string" ? meta.description : undefined;
  const deprecated = meta.deprecated === true;
  if (description === undefined && !deprecated) return "";
  if (description !== undefined && deprecated) {
    return [
      `${indent}/**`,
      `${indent} * ${description}`,
      `${indent} * @deprecated`,
      `${indent} */`,
      "",
    ].join("\n");
  }
  if (description !== undefined) return `${indent}/** ${description} */\n`;
  return `${indent}/** @deprecated */\n`;
}

/** Swift-style `///` doc comment lines plus an `@available(*, deprecated,
 * …)` attribute line when deprecated — returned as a line array (not
 * joined) since callers splice it in among other declaration lines.
 * `deprecatedMessage` (a string `meta.deprecated`) renders as the
 * `message:` argument; a bare `meta.deprecated === true` renders the
 * attribute with no message. Shared by swift-codable.ts,
 * swift-objectmapper.ts, and swift-swiftyjson.ts. */
export function swiftDocComment(ref: { meta: Meta }): string[] {
  const description = typeof ref.meta.description === "string" ? ref.meta.description : undefined;
  const deprecatedMessage =
    typeof ref.meta.deprecated === "string" ? ref.meta.deprecated : undefined;
  const isDeprecated = ref.meta.deprecated === true || deprecatedMessage !== undefined;
  const lines: string[] = [];
  if (description !== undefined) lines.push(`/// ${description}`);
  if (isDeprecated) {
    lines.push(
      deprecatedMessage !== undefined
        ? `@available(*, deprecated, message: ${quote(deprecatedMessage)})`
        : "@available(*, deprecated)",
    );
  }
  return lines;
}

/** PHP-style `/** … *&#47;` doc comment: `@deprecated` (or `@deprecated
 * <message>` when `meta.deprecated` is a string) rendered as a PHPDoc tag
 * alongside `description`. Returns `""` when there's neither. Shared by
 * php-symfony.ts, php-jms.ts, and php-native.ts. */
export function phpDocComment(meta: Meta): string {
  const description = typeof meta.description === "string" ? meta.description : undefined;
  const deprecated = meta.deprecated;
  const deprecatedTag =
    deprecated === true
      ? "@deprecated"
      : typeof deprecated === "string"
        ? `@deprecated ${deprecated}`
        : undefined;
  if (description === undefined && deprecatedTag === undefined) return "";
  const lines = [description, deprecatedTag].filter((line): line is string => line !== undefined);
  return ["/**", ...lines.map((line) => ` * ${line}`), " */\n"].join("\n");
}

/** Go-style `//` doc comment following Go convention (comment begins with
 * the identifier it documents, `name`): `// Name description`, with a
 * `// Deprecated: …` line (blank `//` separator first, when a description
 * line already exists) per https://go.dev/wiki/Deprecated. Returns `""`
 * when there's neither a description nor a deprecation flag/message. Shared
 * by go-jsoniter.ts, go-sonic.ts, go-easyjson.ts, and go-encoding-json.ts. */
export function goDocComment(name: string, meta: Meta): string {
  const description = typeof meta.description === "string" ? meta.description : undefined;
  const deprecatedMessage = typeof meta.deprecated === "string" ? meta.deprecated : undefined;
  const isDeprecated = meta.deprecated === true || deprecatedMessage !== undefined;
  const lines: string[] = [];
  if (description !== undefined) lines.push(`// ${name} ${description}`);
  if (isDeprecated) {
    if (lines.length > 0) lines.push("//");
    lines.push(`// Deprecated: ${deprecatedMessage ?? `${name} is deprecated.`}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Dart-style `///` doc comment — description only (Dart's `@Deprecated`
 * annotation, not the doc comment itself, carries deprecation; see
 * `dartDeprecatedAnnotation`). `indent` (default `""`) is prepended.
 * Returns `""` when there's no description. Shared by dart-built-value.ts,
 * dart-freezed.ts, and dart-json-serializable.ts. */
export function dartDocComment(meta: Meta, indent = ""): string {
  const description = typeof meta.description === "string" ? meta.description : undefined;
  if (description === undefined) return "";
  return `${indent}/// ${description}\n`;
}

/** Dart's native `@Deprecated('reason')` annotation
 * (https://api.dart.dev/stable/dart-core/Deprecated-class.html). Dart's
 * `Deprecated` constructor requires a message argument, so a bare
 * `meta.deprecated === true` (no reason given) falls back to a generic one.
 * `indent` (default `""`) is prepended. Returns `""` when not deprecated.
 * Shared by dart-built-value.ts, dart-freezed.ts, and
 * dart-json-serializable.ts. */
export function dartDeprecatedAnnotation(meta: Meta, indent = ""): string {
  const deprecated = meta.deprecated;
  if (deprecated === true) return `${indent}@Deprecated('deprecated')\n`;
  if (typeof deprecated === "string") return `${indent}@Deprecated(${quoteDart(deprecated)})\n`;
  return "";
}

/** Flow/TypeScript-style `/** … *&#47;` doc comment: same collapse-to-
 * single-line-when-only-one-of-{description,deprecated} shape as
 * `kotlinDocComment`, but unindented (Flow/TS `.d.ts`-adjacent output in
 * these two projectors is always emitted at column 0). Returns `""` when
 * there's neither a description nor a deprecation flag. Shared by
 * flow-native.ts and typescript-native.ts. */
export function flowTsDocComment(meta: Meta): string {
  const description = typeof meta.description === "string" ? meta.description : undefined;
  const deprecated = meta.deprecated === true;
  if (description === undefined && !deprecated) return "";
  if (description !== undefined && deprecated) {
    return ["/**", ` * ${description}`, " * @deprecated", " */", ""].join("\n");
  }
  if (description !== undefined) return `/** ${description} */\n`;
  return "/** @deprecated */\n";
}
