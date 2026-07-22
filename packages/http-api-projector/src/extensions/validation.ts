// packages/http-api-projector/src/extensions/validation.ts — @rhi-zone/fractal-http-api-projector
//
// Built-in `ClientExtension`: validates a successful (2xx, JSON) response
// body against its operation's OWN output schema — the schemas `SchemaMap`
// already carries (see `@rhi-zone/fractal-api-tree/tree`'s
// `extractToolSchemas`, and `codegen.ts`'s `SchemaMap` param) — instead of
// trusting the server unconditionally. Deliberately a SIMPLE structural
// check (type, required fields, enum membership, unexpected null), not a
// full JSON Schema validator (no `format`, no `pattern`, no numeric
// bounds) — enough to catch a server/client drifting apart (a renamed
// field, a field that became optional, a type that changed) without
// reimplementing a validator this package doesn't otherwise need.
//
// Two independent implementations of the same check, one per interpreter
// (see ../extension.ts's module doc):
//   - `decodeResponse` runs on the runtime client. It needs to know WHICH
//     operation a given `Response` belongs to, to look its schema up in the
//     `SchemaMap` passed to `validation({ schemas })` — that's
//     `DecodeContext.codegenName` (extension.ts), which only
//     `createClient(node, ...)` can populate (it walks the raw `Node` tree
//     once, same trick `buildHandlerNames` already uses for member names —
//     see `client.ts`'s `buildCodegenNames`). `createClientFromRoute` has no
//     `Node` to derive it from, so validation silently no-ops there (same
//     degradation already documented for co-located member names) — this
//     extension never GUESSES which schema applies from the URL alone.
//   - `codegen`'s `resultHelpers`/`wrapResult` hooks (extension.ts) emit one
//     schema constant PER OPERATION (`__SCHEMA_<codegenName>`) plus the
//     shared `__validate` helper, and wrap each operation's own
//     `__request(...)` call — codegen already knows exactly which operation
//     each call site is, no runtime name lookup needed.
//
// Configurable failure behavior (`mode`, default `"throw"`):
//   - "throw": a validation failure throws `ValidationError` (extends
//     `ClientError` — see client-error.ts / codegen.ts's generated
//     `ClientError`), with `details` listing each failed field/path.
//   - "warn": logs the same details via `console.warn` and returns the body
//     unchanged.
//   - "strip": removes fields not declared in the schema's `properties`
//     BEFORE validating (so an extra/renamed field doesn't itself count as
//     a failure), then falls through to "throw" semantics for whatever
//     validation failures remain (missing required fields, wrong types,
//     invalid enum values) — stripping fixes "the server sent MORE than
//     expected", not "the server sent something WRONG".

import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"
import type { ClientExtension, CodegenOperationInfo, DecodeContext, DecodedResponse } from "../extension.ts"
import { ClientError } from "../client-error.ts"

// ============================================================================
// Public API
// ============================================================================

export type ValidationMode = "throw" | "warn" | "strip"

export type ValidationOptions = {
  /**
   * Schema map to validate responses against (from `extractToolSchemas`, or
   * the same `SchemaMap` passed to `generateClient`/`generateClientFromNode`).
   * Required for the RUNTIME client to do anything (with no `schemas`, this
   * extension has nothing to look up and every response passes through
   * unchecked). Not required for CODEGEN — `generateClient(route, schemas,
   * { extensions: [validation()] })` already threads `schemas` through
   * `attachOperation` before this extension ever sees an operation, via
   * `resultHelpers`'s `CodegenOperationInfo[]` argument.
   */
  readonly schemas?: SchemaMap
  /** Failure behavior — see module doc. Defaults to `"throw"`. */
  readonly mode?: ValidationMode
}

/** Thrown (in `"throw"`/`"strip"` mode) when a response body fails schema validation. */
export class ValidationError extends ClientError {
  /** One human-readable message per failed field/path (e.g. `"$.title: expected string, got number"`). */
  readonly details: readonly string[]
  /** The `SchemaMap` key of the operation whose response failed, when known. */
  readonly codegenName?: string | undefined

  constructor(status: number, body: unknown, details: readonly string[], codegenName?: string) {
    super(status, body)
    this.name = "ValidationError"
    this.details = details
    this.codegenName = codegenName
  }
}

/**
 * Response-validation extension: checks a successful JSON response against
 * its operation's own output schema (see module doc).
 *
 * @example
 * // Runtime — needs schemas (only `createClient(node, ...)` can resolve
 * // per-operation schema names; see module doc).
 * const schemas = extractToolSchemas(treePath)
 * createClient(node, { extensions: [validation({ schemas })] })
 *
 * @example
 * // Codegen — schemas already known via `generateClient`'s own param.
 * generateClient(route, schemas, { extensions: [validation()] })
 */
export function validation(options: ValidationOptions = {}): ClientExtension {
  const { schemas, mode = "throw" } = options

  const decodeResponse = (res: Response, ctx: DecodeContext): DecodedResponse | undefined => {
    if (!res.ok) return undefined // non-2xx: let the default/errors() path handle it
    const ct = res.headers.get("Content-Type") ?? ""
    if (!ct.includes("application/json")) return undefined
    const codegenName = ctx.codegenName
    const schema = codegenName !== undefined ? schemas?.[codegenName]?.outputSchema : undefined
    if (schema === undefined) return undefined // no known schema for this operation — nothing to check

    const value = res.json().then((body) => runValidation(body, schema, mode, res.status, codegenName))
    return { value }
  }

  // Populated by `resultHelpers` (called once, with the full operation list,
  // BEFORE `wrapResult` runs per-operation — see codegen.ts's `render`) with
  // every operation that actually has an output schema to validate, so
  // `wrapResult` knows whether to wrap a given call at all.
  const schemaConstNames = new Map<string, string>()

  const resultHelpers = (operations: readonly CodegenOperationInfo[]): string | undefined => {
    const withSchema = operations.filter(
      (op): op is CodegenOperationInfo & { responseSchema: JsonSchema } => op.responseSchema !== undefined,
    )
    if (withSchema.length === 0) return undefined

    const consts: string[] = []
    for (const op of withSchema) {
      const constName = `__SCHEMA_${op.codegenName}`
      schemaConstNames.set(op.codegenName, constName)
      consts.push(`const ${constName}: unknown = ${JSON.stringify(op.responseSchema)}`)
    }

    return [VALIDATION_CODEGEN_HELPERS, ...consts].join("\n\n")
  }

  const wrapResult = (innerExpr: string, codegenName: string): string => {
    const constName = schemaConstNames.get(codegenName)
    if (constName === undefined) return innerExpr // no schema for this operation — pass through unchanged
    return `${innerExpr}.then((__v: unknown) => __validate(__v, ${constName}, ${JSON.stringify(mode)}, "${codegenName}"))`
  }

  return {
    name: "validation",
    decodeResponse,
    codegen: {
      resultHelpers,
      wrapResult,
    },
  }
}

// ============================================================================
// Runtime: structural check + strip + mode dispatch — shared logic, mirrored
// into VALIDATION_CODEGEN_HELPERS below as source text (same split as
// errors.ts/streaming.ts: two independent implementations of the same
// behavior, one per interpreter).
// ============================================================================

/** Collect one message per structural mismatch found in `value` against `schema`, rooted at `path`. */
function collectValidationErrors(value: unknown, schema: JsonSchema, path: string, out: string[]): void {
  if ("const" in schema) {
    if (value !== schema.const) {
      out.push(`${path}: expected constant ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`)
    }
    return
  }

  if (Array.isArray(schema.enum)) {
    if (!(schema.enum as readonly unknown[]).includes(value)) {
      out.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`)
    }
    return
  }

  const anyOf = schema.anyOf ?? schema.oneOf
  if (Array.isArray(anyOf)) {
    const matches = anyOf.some((s) => {
      const branchErrors: string[] = []
      collectValidationErrors(value, s, path, branchErrors)
      return branchErrors.length === 0
    })
    if (!matches && anyOf.length > 0) {
      out.push(`${path}: value matched none of ${anyOf.length} allowed variants`)
    }
    return
  }

  const type = schema.type
  if (type === undefined) return // no type constraint on this (sub-)schema — nothing more we can check

  if (value === null) {
    // `JsonSchema.type` has no "null" variant — a nullable field is
    // represented as `anyOf`/`oneOf` with a `{ const: null }` branch
    // (handled above, before `type` is even consulted), so reaching here
    // with `value === null` and a concrete `type` is always a mismatch.
    out.push(`${path}: unexpected null`)
    return
  }
  if (value === undefined) {
    out.push(`${path}: missing value`)
    return
  }

  switch (type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        out.push(`${path}: expected object, got ${describeType(value)}`)
        return
      }
      const obj = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (!(key in obj) || obj[key] === undefined) out.push(`${path}.${key}: missing required field`)
      }
      if (schema.properties !== undefined) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in obj && obj[key] !== undefined) collectValidationErrors(obj[key], propSchema, `${path}.${key}`, out)
        }
      }
      return
    }
    case "array": {
      if (!Array.isArray(value)) {
        out.push(`${path}: expected array, got ${describeType(value)}`)
        return
      }
      if (schema.items !== undefined && schema.items !== false) {
        value.forEach((item, i) => collectValidationErrors(item, schema.items as JsonSchema, `${path}[${i}]`, out))
      }
      return
    }
    case "string":
      if (typeof value !== "string") out.push(`${path}: expected string, got ${describeType(value)}`)
      return
    case "number":
      if (typeof value !== "number") out.push(`${path}: expected number, got ${describeType(value)}`)
      return
    case "boolean":
      if (typeof value !== "boolean") out.push(`${path}: expected boolean, got ${describeType(value)}`)
      return
    default:
      return
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** Remove fields not declared in `schema.properties` (recursively) — the `"strip"` mode's own pass. */
function stripToSchema(value: unknown, schema: JsonSchema): unknown {
  if (schema.type === "object" && schema.properties !== undefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = schema.properties[key]
      if (propSchema !== undefined) out[key] = stripToSchema(v, propSchema)
    }
    return out
  }
  if (schema.type === "array" && schema.items !== undefined && schema.items !== false) {
    if (!Array.isArray(value)) return value
    return value.map((v) => stripToSchema(v, schema.items as JsonSchema))
  }
  return value
}

function runValidation(
  body: unknown,
  schema: JsonSchema,
  mode: ValidationMode,
  status: number,
  codegenName: string | undefined,
): unknown {
  const value = mode === "strip" ? stripToSchema(body, schema) : body
  const errors: string[] = []
  collectValidationErrors(value, schema, "$", errors)

  if (errors.length === 0) return value
  if (mode === "warn") {
    console.warn(
      `[validation] response${codegenName !== undefined ? ` for "${codegenName}"` : ""} failed schema validation:\n${errors.join("\n")}`,
    )
    return value
  }
  throw new ValidationError(status, body, errors, codegenName)
}

// ============================================================================
// Codegen helper source — emitted verbatim (once) into generated client files
// that use `validation()`, ahead of any per-operation schema constants
// (`resultHelpers`, above). Mirrors the runtime logic above exactly, against
// the generated `ClientError` (codegen.ts's `RUNTIME_HELPERS`, a 3-arg
// status/statusText/body class — emitted unconditionally before any
// extension helpers, see codegen.ts's `render`), so this text can reference
// `ClientError` by name without redefining it. `status` at the point
// `__validate` runs is always a 2xx (a non-2xx already threw inside
// `__request` before its result reaches `.then(...)`), so it's hardcoded to
// `200` here — the exact 2xx code isn't recoverable from `__request`'s
// return value (already-unwrapped body, not the `Response`).
// ============================================================================

const VALIDATION_CODEGEN_HELPERS = `
export class ValidationError extends ClientError {
  readonly details: readonly string[]
  readonly codegenName?: string

  constructor(body: unknown, details: readonly string[], codegenName?: string) {
    super(200, "OK", body)
    this.name = "ValidationError"
    this.details = details
    this.codegenName = codegenName
  }
}

function __describeType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function __collectValidationErrors(value: unknown, schema: any, path: string, out: string[]): void {
  if (schema === null || schema === undefined) return
  if ("const" in schema) {
    if (value !== schema.const) out.push(\`\${path}: expected constant \${JSON.stringify(schema.const)}, got \${JSON.stringify(value)}\`)
    return
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) out.push(\`\${path}: expected one of \${JSON.stringify(schema.enum)}, got \${JSON.stringify(value)}\`)
    return
  }
  const anyOf = schema.anyOf ?? schema.oneOf
  if (Array.isArray(anyOf)) {
    const matches = anyOf.some((s: any) => {
      const branchErrors: string[] = []
      __collectValidationErrors(value, s, path, branchErrors)
      return branchErrors.length === 0
    })
    if (!matches && anyOf.length > 0) out.push(\`\${path}: value matched none of \${anyOf.length} allowed variants\`)
    return
  }
  const type = schema.type
  if (type === undefined) return
  if (value === null) {
    out.push(\`\${path}: unexpected null\`)
    return
  }
  if (value === undefined) {
    out.push(\`\${path}: missing value\`)
    return
  }
  switch (type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        out.push(\`\${path}: expected object, got \${__describeType(value)}\`)
        return
      }
      const obj = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (!(key in obj) || obj[key] === undefined) out.push(\`\${path}.\${key}: missing required field\`)
      }
      if (schema.properties !== undefined) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in obj && obj[key] !== undefined) __collectValidationErrors(obj[key], propSchema, \`\${path}.\${key}\`, out)
        }
      }
      return
    }
    case "array": {
      if (!Array.isArray(value)) {
        out.push(\`\${path}: expected array, got \${__describeType(value)}\`)
        return
      }
      if (schema.items !== undefined && schema.items !== false) {
        value.forEach((item: unknown, i: number) => __collectValidationErrors(item, schema.items, \`\${path}[\${i}]\`, out))
      }
      return
    }
    case "string":
      if (typeof value !== "string") out.push(\`\${path}: expected string, got \${__describeType(value)}\`)
      return
    case "number":
    case "integer":
      if (typeof value !== "number") out.push(\`\${path}: expected number, got \${__describeType(value)}\`)
      return
    case "boolean":
      if (typeof value !== "boolean") out.push(\`\${path}: expected boolean, got \${__describeType(value)}\`)
      return
    default:
      return
  }
}

function __stripToSchema(value: unknown, schema: any): unknown {
  if (schema?.type === "object" && schema.properties !== undefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = schema.properties[key]
      if (propSchema !== undefined) out[key] = __stripToSchema(v, propSchema)
    }
    return out
  }
  if (schema?.type === "array" && schema.items !== undefined && schema.items !== false) {
    if (!Array.isArray(value)) return value
    return value.map((v) => __stripToSchema(v, schema.items))
  }
  return value
}

function __validate(body: unknown, schema: unknown, mode: "throw" | "warn" | "strip", codegenName: string): unknown {
  const value = mode === "strip" ? __stripToSchema(body, schema) : body
  const errors: string[] = []
  __collectValidationErrors(value, schema, "$", errors)
  if (errors.length === 0) return value
  if (mode === "warn") {
    console.warn(\`[validation] response for "\${codegenName}" failed schema validation:\\n\${errors.join("\\n")}\`)
    return value
  }
  throw new ValidationError(body, errors, codegenName)
}`.trim()
