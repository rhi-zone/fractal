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
  array: leaf("JSONB"),
  tuple: leaf("JSONB"),
  map: leaf("JSONB"),
  union: leaf("JSONB"),
  literal: literalHandler,
  enum: leaf("TEXT"),
  ref: leaf("TEXT"),
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
  array: leaf("TEXT"),
  tuple: leaf("TEXT"),
  map: leaf("TEXT"),
  union: leaf("TEXT"),
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
  array: leaf("JSON"),
  tuple: leaf("JSON"),
  map: leaf("JSON"),
  union: leaf("JSON"),
  literal: mysqlLiteralHandler,
  enum: mysqlEnumHandler,
  ref: leaf("TEXT"),
}
mysqlHandlers.intersection = intersectionFallback(mysqlHandlers, "JSON")

function handlersFor(dialect: SqlDialect | undefined): Record<string, Converter> {
  if (dialect === "sqlite") return sqliteHandlers
  if (dialect === "mysql") return mysqlHandlers
  return postgresHandlers
}

export function toSqlDdl(ref: TypeRef, opts?: { dialect?: SqlDialect }): SqlColumn {
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

export function toCreateTable(tableName: string, ref: TypeRef, opts?: { dialect?: SqlDialect }): string {
  if (!isA(ref.shape.kind, "object")) throw new Error(`toCreateTable requires an object type, got "${ref.shape.kind}"`)
  const s = ref.shape as TypeShape & { kind: "object" }
  const columns = Object.entries(s.fields).map(([name, field]) => columnDef(name, toSqlDdl(field, opts)))
  return `CREATE TABLE ${tableName} (\n  ${columns.join(",\n  ")}\n);`
}
