import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

export type SqlColumn = {
  type: string
  nullable: boolean
  default?: string
  // CHECK constraint clauses derived from open metadata (minimum/maximum/minLength/
  // pattern/multipleOf, ...). Each clause contains the literal placeholder token
  // `{name}` in place of the column name — `columnDef` is the one place that knows
  // the final column name, so it substitutes it in. Keeps `SqlColumn` itself plain,
  // name-agnostic, serializable data (no closures), consistent with the "DU is the
  // contract" pattern used across the other projectors in this package.
  checks?: string[]
  // Dialect-appropriate rendering of `meta.description` — MySQL's native inline
  // `COMMENT '...'` clause, or a `/* ... */` block comment for the others. Already
  // fully rendered (no `{name}` needed — comments don't reference the column name).
  comment?: string
}

export type SqlDialect = "postgres" | "sqlite" | "mysql"

type Converter = (shape: TypeShape) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

const literalHandler: Converter = (shape) => {
  const s = shape as TypeShape & { kind: "literal" }
  if (typeof s.value === "number") return "NUMERIC"
  if (typeof s.value === "boolean") return "BOOLEAN"
  return "TEXT"
}

const postgresHandlers: Record<string, Converter> = {
  boolean: leaf("BOOLEAN"),
  number: leaf("DOUBLE PRECISION"),
  integer: leaf("INTEGER"),
  int32: leaf("INTEGER"),
  int64: leaf("BIGINT"),
  float32: leaf("REAL"),
  float64: leaf("DOUBLE PRECISION"),
  string: leaf("TEXT"),
  uuid: leaf("UUID"),
  uri: leaf("TEXT"),
  email: leaf("TEXT"),
  datetime: leaf("TIMESTAMPTZ"),
  date: leaf("DATE"),
  time: leaf("TIME"),
  duration: leaf("INTERVAL"),
  bytes: leaf("BYTEA"),
  null: leaf("TEXT"),
  void: leaf("TEXT"),
  unknown: leaf("JSONB"),
  never: leaf("TEXT"),
  object: leaf("JSONB"),
  // A class instance carries only nominal identity (className/source), never fields
  // (see type-ir's TypeKinds.instance doc comment) — there is no structure to persist,
  // so this is treated the same as `unknown` (opaque data) rather than `object`.
  instance: leaf("JSONB"),
  array: leaf("JSONB"),
  // A column stores a materialized value, not an ongoing async sequence —
  // same opaque-fallback treatment as `array` above (the stream would need
  // to be fully drained before it could be persisted anyway).
  stream: leaf("JSONB"),
  tuple: leaf("JSONB"),
  map: leaf("JSONB"),
  union: leaf("JSONB"),
  literal: literalHandler,
  enum: leaf("TEXT"),
  ref: leaf("TEXT"),
  // Functions aren't persistable column data — same opaque-fallback treatment
  // as `instance`/`unknown` above.
  function: leaf("JSONB"),
}
// Assigned after construction (not inline) so the closure captures the fully
// initialized `postgresHandlers` map, not a `const` reference mid-TDZ.
postgresHandlers.intersection = intersectionFallback(postgresHandlers, "JSONB")

const sqliteHandlers: Record<string, Converter> = {
  ...postgresHandlers,
  uuid: leaf("TEXT"),
  datetime: leaf("TEXT"),
  date: leaf("TEXT"),
  time: leaf("TEXT"),
  duration: leaf("TEXT"),
  bytes: leaf("BLOB"),
  int64: leaf("INTEGER"),
  float32: leaf("REAL"),
  float64: leaf("REAL"),
  unknown: leaf("TEXT"),
  object: leaf("TEXT"),
  instance: leaf("TEXT"),
  array: leaf("TEXT"),
  stream: leaf("TEXT"),
  tuple: leaf("TEXT"),
  map: leaf("TEXT"),
  union: leaf("TEXT"),
  function: leaf("TEXT"),
}
// Overridden (not inherited from the postgres spread) so the fallback
// resolves against sqlite's own type names, not postgres's.
sqliteHandlers.intersection = intersectionFallback(sqliteHandlers, "TEXT")

// SQL has no intersection/mixin column type — lossy fallback: resolve the
// first member's shape against the SAME dialect handler map, dropping the
// rest. Declared as a `function` (hoisted) so it can be referenced by name
// inside a handlers object literal without a TDZ violation — each dialect
// map's `intersection` entry closes over that dialect's own `handlers`
// parameter, so sqlite/mysql don't fall back through postgres's types.
function intersectionFallback(handlers: Record<string, Converter>, fallback: string): Converter {
  return (shape) => {
    const s = shape as TypeShape & { kind: "intersection" }
    const [first] = s.members
    if (first === undefined) return fallback
    const converter = resolve(first.shape.kind, handlers)
    return converter === undefined ? fallback : converter(first.shape)
  }
}

function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL"
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`
  return String(value)
}

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

// Builds CHECK constraint clause templates from the same open-metadata constraint
// vocabulary as the other projectors in this package (zod.ts, json-schema.ts,
// effect-schema.ts, ...): minimum/maximum/exclusiveMinimum/exclusiveMaximum (numeric),
// minLength/maxLength/pattern (string), multipleOf (numeric). Each returned clause
// contains the `{name}` placeholder in place of the column name.
function buildChecks(kind: string, meta: Readonly<Record<string, unknown>>, dialect: SqlDialect | undefined): string[] {
  const numberLike = isA(kind, "number")
  const stringLike = isA(kind, "string")
  const checks: string[] = []

  if (typeof meta.minimum === "number" && numberLike) checks.push(`CHECK ({name} >= ${meta.minimum})`)
  if (typeof meta.maximum === "number" && numberLike) checks.push(`CHECK ({name} <= ${meta.maximum})`)
  if (typeof meta.exclusiveMinimum === "number" && numberLike) checks.push(`CHECK ({name} > ${meta.exclusiveMinimum})`)
  if (typeof meta.exclusiveMaximum === "number" && numberLike) checks.push(`CHECK ({name} < ${meta.exclusiveMaximum})`)
  if (typeof meta.minLength === "number" && stringLike) checks.push(`CHECK (LENGTH({name}) >= ${meta.minLength})`)
  if (typeof meta.maxLength === "number" && stringLike) checks.push(`CHECK (LENGTH({name}) <= ${meta.maxLength})`)
  if (typeof meta.pattern === "string" && stringLike) {
    if (dialect === "mysql") {
      checks.push(`CHECK ({name} REGEXP ${sqlLiteral(meta.pattern)})`)
    } else if (dialect !== "sqlite") {
      // Postgres: `~` is the native POSIX regex match operator. SQLite has no native
      // regex operator — `REGEXP` only works if the host application registers a
      // user-defined function for it, so emitting a REGEXP/~ clause here would
      // produce DDL that fails on a stock sqlite3 connection. Skip for sqlite.
      checks.push(`CHECK ({name} ~ ${sqlLiteral(meta.pattern)})`)
    }
  }
  if (typeof meta.multipleOf === "number" && numberLike) checks.push(`CHECK ({name} % ${meta.multipleOf} = 0)`)

  return checks
}

// Renders `meta.description` as dialect-appropriate SQL. MySQL has a native inline
// `COMMENT '...'` column clause. The others don't — a trailing `-- ...` line comment
// would swallow the trailing comma `toCreateTable` appends after each column in a
// multi-column CREATE TABLE, so a `/* ... */` block comment is used instead.
function buildComment(meta: Readonly<Record<string, unknown>>, dialect: SqlDialect | undefined): string | undefined {
  if (typeof meta.description !== "string") return undefined
  if (dialect === "mysql") return `COMMENT ${sqlLiteral(meta.description)}`
  return `/* ${meta.description} */`
}

const mysqlLiteralHandler: Converter = (shape) => {
  const s = shape as TypeShape & { kind: "literal" }
  if (typeof s.value === "number") return "NUMERIC"
  if (typeof s.value === "boolean") return "TINYINT(1)"
  return "TEXT"
}

const mysqlEnumHandler: Converter = (shape) => {
  const s = shape as TypeShape & { kind: "enum" }
  return `ENUM(${s.members.map((m) => sqlLiteral(m)).join(", ")})`
}

// MySQL has no native BOOLEAN (TINYINT(1) is the conventional stand-in), no native
// UUID/interval/array/union types, and requires an explicit length on VARCHAR.
const mysqlHandlers: Record<string, Converter> = {
  boolean: leaf("TINYINT(1)"),
  number: leaf("DOUBLE"),
  integer: leaf("INT"),
  int32: leaf("INT"),
  int64: leaf("BIGINT"),
  float32: leaf("FLOAT"),
  float64: leaf("DOUBLE"),
  string: leaf("VARCHAR(255)"),
  uuid: leaf("CHAR(36)"),
  uri: leaf("TEXT"),
  email: leaf("VARCHAR(255)"),
  datetime: leaf("DATETIME"),
  date: leaf("DATE"),
  time: leaf("TIME"),
  duration: leaf("VARCHAR(255)"),
  bytes: leaf("BLOB"),
  null: leaf("TINYINT(1)"),
  void: leaf("TEXT"),
  unknown: leaf("JSON"),
  never: leaf("TEXT"),
  object: leaf("JSON"),
  instance: leaf("JSON"),
  array: leaf("JSON"),
  stream: leaf("JSON"),
  tuple: leaf("JSON"),
  map: leaf("JSON"),
  union: leaf("JSON"),
  literal: mysqlLiteralHandler,
  enum: mysqlEnumHandler,
  ref: leaf("TEXT"),
  function: leaf("JSON"),
}
mysqlHandlers.intersection = intersectionFallback(mysqlHandlers, "JSON")

function handlersFor(dialect: SqlDialect | undefined): Record<string, Converter> {
  if (dialect === "sqlite") return sqliteHandlers
  if (dialect === "mysql") return mysqlHandlers
  return postgresHandlers
}

export interface SqlOptions {
  dialect?: SqlDialect
  // Strategy for lowering a union-rooted TypeRef to DDL — a function, not an
  // enum, so a caller can hand in either of the two built-in factories below
  // (`singleTableInheritanceSqlLayout()` / `tablePerVariantSqlLayout()`) or
  // their own `SqlUnionLayout`, with no closed set of "kinds" for this
  // package to gatekeep. Defaults to `singleTableInheritanceSqlLayout()`.
  unionLayout?: SqlUnionLayout
}

// Everything a union layout needs to render DDL for a union-rooted TypeRef,
// bundled as one options object (not a positional parameter list) — several
// of these are same-shaped (two are `string`), so named fields read far
// better than position at both the declaration and the call site.
export type SqlUnionLayoutInput = {
  // The union's own table/type name (`toCreateTable`'s `tableName`).
  name: string
  // `meta.discriminator`, when the union is a tagged/discriminated union —
  // undefined for a plain (untagged) union.
  discriminator: string | undefined
  // Each variant paired with its resolved name: the literal value of its
  // discriminator field when one is present (e.g. `"success"`), otherwise a
  // positional `variant1`, `variant2`, ... fallback.
  variants: { name: string; ref: TypeRef }[]
  // Reuses the projector's own dialect-aware type mapping (`toSqlDdl` bound
  // to the caller's `opts`) so a layout never needs to duplicate — or drift
  // from — the kind → column-type table above.
  toColumn: (ref: TypeRef) => SqlColumn
}

// A union-lowering strategy: given a union's name/discriminator/variants and
// a way to resolve a member TypeRef to a column, render whatever DDL that
// strategy produces (one CREATE TABLE, several, ...). Kept as a plain
// function type — see `SqlOptions.unionLayout` above — rather than a fixed
// enum of named strategies.
export type SqlUnionLayout = (input: SqlUnionLayoutInput) => string

// Resolves the dialect-appropriate string column type via `toColumn` itself
// (rather than hardcoding "TEXT"), so the discriminator column tracks each
// dialect's own string type the same way every other column does.
function stringColumn(toColumn: (ref: TypeRef) => SqlColumn): SqlColumn {
  const ref: TypeRef = { shape: { kind: "string" } as TypeShape, meta: {} }
  return { ...toColumn(ref), nullable: false }
}

/**
 * Single-table-inheritance layout: one CREATE TABLE for the whole union — a
 * discriminator column (defaults to `"kind"` when the union carries no
 * `meta.discriminator`, overridable via `discriminatorColumn`) plus the union
 * of every variant's fields, each nullable (no variant guarantees a field
 * outside its own row). A field name shared by multiple variants is emitted
 * once, using the first variant's column definition for it — this package's
 * open-metadata convention doesn't guarantee same-named fields agree on type
 * across variants, so "first wins" is a documented, deterministic tie-break,
 * not a correctness guarantee.
 *
 * A constructor (not a bare layout value) so its one configuration point —
 * the discriminator column's fallback name — has somewhere to live without
 * widening `SqlUnionLayout`'s own signature.
 */
export function singleTableInheritanceSqlLayout(opts?: { discriminatorColumn?: string }): SqlUnionLayout {
  const fallbackDiscriminatorColumn = opts?.discriminatorColumn ?? "kind"
  return ({ name, discriminator, variants, toColumn }) => {
    const discriminatorName = discriminator ?? fallbackDiscriminatorColumn
    const columns: string[] = [columnDef(discriminatorName, stringColumn(toColumn))]

    const seen = new Set<string>()
    for (const { ref } of variants) {
      if (!isA(ref.shape.kind, "object")) continue
      const s = ref.shape as TypeShape & { kind: "object" }
      for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
        if (fieldName === discriminatorName) continue
        if (seen.has(fieldName)) continue
        seen.add(fieldName)
        columns.push(columnDef(fieldName, { ...toColumn(fieldRef), nullable: true }))
      }
    }

    return `CREATE TABLE ${name} (\n  ${columns.join(",\n  ")}\n);`
  }
}

/**
 * Table-per-variant layout: one CREATE TABLE per variant, each with its own
 * proper (non-widened) NOT NULL constraints — no shared base table. Table
 * naming defaults to `{unionName}_{variantName}`, overridable via
 * `tableName` (e.g. to use a different separator, or route variants into a
 * naming scheme shared with a migration tool).
 *
 * A constructor (not a bare layout value) so the table-naming callback has
 * somewhere to live without widening `SqlUnionLayout`'s own signature.
 */
export function tablePerVariantSqlLayout(opts?: { tableName?: (unionName: string, variantName: string) => string }): SqlUnionLayout {
  const tableName = opts?.tableName ?? ((unionName: string, variantName: string) => `${unionName}_${variantName}`)
  return ({ name, variants, toColumn }) => {
    const tables = variants.map(({ name: variantName, ref }) => {
      const table = tableName(name, variantName)
      if (isA(ref.shape.kind, "object")) {
        const s = ref.shape as TypeShape & { kind: "object" }
        const columns = Object.entries(s.fields).map(([fieldName, fieldRef]) => columnDef(fieldName, toColumn(fieldRef)))
        return `CREATE TABLE ${table} (\n  ${columns.join(",\n  ")}\n);`
      }
      // A non-object variant (e.g. a plain `union([string(), integer()])`
      // member) has no fields to spread into columns — it lowers to a
      // single `value` column instead.
      return `CREATE TABLE ${table} (\n  ${columnDef("value", toColumn(ref))}\n);`
    })
    return tables.join("\n\n")
  }
}

// Resolves a union variant's name for both the discriminator-column merge
// (STI) and per-variant table naming (TPV): the literal string value of its
// discriminator field when present (the tagged-union convention, e.g.
// `{ type: "success", ... }` -> "success" — same convention toProtoUnionMessage
// in protobuf.ts and toCapnpUnionStruct in capnp.ts use), otherwise a
// positional `variant1`, `variant2`, ... fallback.
function variantName(discriminator: string | undefined, ref: TypeRef, index: number): string {
  if (discriminator !== undefined && isA(ref.shape.kind, "object")) {
    const s = ref.shape as TypeShape & { kind: "object" }
    const tagShape = s.fields[discriminator]?.shape
    if (tagShape !== undefined && tagShape.kind === "literal") {
      const value = (tagShape as TypeShape & { kind: "literal" }).value
      if (typeof value === "string") return value
    }
  }
  return `variant${index}`
}

export function toSqlDdl(ref: TypeRef, opts?: SqlOptions): SqlColumn {
  const handlers = handlersFor(opts?.dialect)
  const converter = resolve(ref.shape.kind, handlers)
  const type = converter === undefined ? "TEXT" : converter(ref.shape)

  const column: SqlColumn = { type, nullable: ref.meta.nullable === true }
  if (ref.meta.default !== undefined) column.default = sqlLiteral(ref.meta.default)

  const checks = buildChecks(ref.shape.kind, ref.meta, opts?.dialect)
  if (checks.length > 0) column.checks = checks

  const comment = buildComment(ref.meta, opts?.dialect)
  if (comment !== undefined) column.comment = comment

  return column
}

export function columnDef(name: string, col: SqlColumn): string {
  let ddl = `${name} ${col.type}`
  if (!col.nullable) ddl += " NOT NULL"
  if (col.default !== undefined) ddl += ` DEFAULT ${col.default}`
  if (col.checks) for (const check of col.checks) ddl += ` ${check.replaceAll("{name}", name)}`
  if (col.comment !== undefined) ddl += ` ${col.comment}`
  return ddl
}

export function toCreateTable(tableName: string, ref: TypeRef, opts?: SqlOptions): string {
  if (isA(ref.shape.kind, "union")) {
    const s = ref.shape as TypeShape & { kind: "union" }
    const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
    const variants = s.variants.map((variant, i) => ({ name: variantName(discriminator, variant, i + 1), ref: variant }))
    const layout = opts?.unionLayout ?? singleTableInheritanceSqlLayout()
    return layout({ name: tableName, discriminator, variants, toColumn: (fieldRef) => toSqlDdl(fieldRef, opts) })
  }
  if (!isA(ref.shape.kind, "object")) throw new Error(`toCreateTable requires an object or union type, got "${ref.shape.kind}"`)
  const s = ref.shape as TypeShape & { kind: "object" }
  const columns = Object.entries(s.fields).map(([name, field]) => columnDef(name, toSqlDdl(field, opts)))
  return `CREATE TABLE ${tableName} (\n  ${columns.join(",\n  ")}\n);`
}
