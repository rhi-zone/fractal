import { resolve, type TypeRef, type TypeShape } from "./index.ts"

export type SqlColumn = {
  type: string
  nullable: boolean
  default?: string
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
  return column
}

export function columnDef(name: string, col: SqlColumn): string {
  let ddl = `${name} ${col.type}`
  if (!col.nullable) ddl += " NOT NULL"
  if (col.default !== undefined) ddl += ` DEFAULT ${col.default}`
  return ddl
}

export function toCreateTable(tableName: string, ref: TypeRef, opts?: { dialect?: SqlDialect }): string {
  if (ref.shape.kind !== "object") throw new Error(`toCreateTable requires an object type, got "${ref.shape.kind}"`)
  const s = ref.shape as TypeShape & { kind: "object" }
  const columns = Object.entries(s.fields).map(([name, field]) => columnDef(name, toSqlDdl(field, opts)))
  return `CREATE TABLE ${tableName} (\n  ${columns.join(",\n  ")}\n);`
}
