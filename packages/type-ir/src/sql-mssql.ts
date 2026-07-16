import { resolve, type TypeRef, type TypeShape } from "./index.ts"

type Converter = (shape: TypeShape) => string

const leaf =
  (type: string): Converter =>
  () =>
    type

const literalHandler: Converter = (shape) => {
  const s = shape as TypeShape & { kind: "literal" }
  if (typeof s.value === "number") return "NUMERIC"
  if (typeof s.value === "boolean") return "BIT"
  return "NVARCHAR(255)"
}

const mssqlHandlers: Record<string, Converter> = {
  boolean: leaf("BIT"),
  number: leaf("FLOAT"),
  integer: leaf("INT"),
  int32: leaf("INT"),
  int64: leaf("BIGINT"),
  float32: leaf("REAL"),
  float64: leaf("FLOAT"),
  string: leaf("NVARCHAR(255)"),
  uuid: leaf("UNIQUEIDENTIFIER"),
  uri: leaf("NVARCHAR(MAX)"),
  datetime: leaf("DATETIME2"),
  date: leaf("DATE"),
  time: leaf("TIME"),
  duration: leaf("NVARCHAR(255)"),
  bytes: leaf("VARBINARY(MAX)"),
  null: leaf("BIT"),
  void: leaf("NVARCHAR(255)"),
  unknown: leaf("NVARCHAR(MAX)"),
  never: leaf("NVARCHAR(255)"),
  object: leaf("NVARCHAR(MAX)"),
  array: leaf("NVARCHAR(MAX)"),
  tuple: leaf("NVARCHAR(MAX)"),
  map: leaf("NVARCHAR(MAX)"),
  union: leaf("NVARCHAR(MAX)"),
  literal: literalHandler,
  enum: leaf("NVARCHAR(255)"),
  ref: leaf("NVARCHAR(255)"),
}
// MSSQL has no intersection/mixin column type — lossy fallback: resolve the
// first member's shape against this same handler map, dropping the rest.
// Assigned after construction (not inline) so the closure captures the fully
// initialized map, not a `const` reference mid-TDZ.
mssqlHandlers.intersection = (shape) => {
  const s = shape as TypeShape & { kind: "intersection" }
  const [first] = s.members
  if (first === undefined) return "NVARCHAR(255)"
  const converter = resolve(first.shape.kind, mssqlHandlers)
  return converter === undefined ? "NVARCHAR(255)" : converter(first.shape)
}

function sqlLiteral(value: unknown): string {
  if (value === null) return "NULL"
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`
  return String(value)
}

/** Resolves a TypeRef to its MSSQL column type string (no nullability/default/constraints). */
export function toMssqlType(ref: TypeRef): string {
  const converter = resolve(ref.shape.kind, mssqlHandlers)
  return converter === undefined ? "NVARCHAR(255)" : converter(ref.shape)
}

function enumCheckConstraint(name: string, members: readonly string[]): string {
  const values = members.map((m) => sqlLiteral(m)).join(", ")
  return `CHECK (${name} IN (${values}))`
}

/**
 * Builds a full MSSQL column definition, including nullability, default, IDENTITY
 * (via `meta.identity`), and a CHECK constraint for enum-shaped columns (MSSQL has
 * no native enum type).
 */
export function mssqlColumnDef(name: string, ref: TypeRef): string {
  const type = toMssqlType(ref)
  let ddl = `${name} ${type}`

  if (ref.meta.identity === true) ddl += " IDENTITY(1,1)"

  ddl += ref.meta.nullable === true ? " NULL" : " NOT NULL"

  if (ref.meta.default !== undefined) ddl += ` DEFAULT ${sqlLiteral(ref.meta.default)}`

  if (ref.shape.kind === "enum") {
    const s = ref.shape as TypeShape & { kind: "enum" }
    ddl += ` ${enumCheckConstraint(name, s.members)}`
  }

  return ddl
}

export function toMssqlCreateTable(tableName: string, fields: Record<string, TypeRef>): string {
  const columns = Object.entries(fields).map(([name, field]) => mssqlColumnDef(name, field))
  return `CREATE TABLE ${tableName} (\n  ${columns.join(",\n  ")}\n);`
}
