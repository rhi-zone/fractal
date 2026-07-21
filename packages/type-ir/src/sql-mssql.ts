import { ancestors, resolve, type TypeRef, type TypeShape } from "./index.ts"

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
  email: leaf("NVARCHAR(255)"),
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
  // A column stores a materialized value, not an ongoing async sequence —
  // same opaque-fallback treatment as `array` above.
  stream: leaf("NVARCHAR(MAX)"),
  tuple: leaf("NVARCHAR(MAX)"),
  map: leaf("NVARCHAR(MAX)"),
  union: leaf("NVARCHAR(MAX)"),
  literal: literalHandler,
  enum: leaf("NVARCHAR(255)"),
  ref: leaf("NVARCHAR(255)"),
  // Functions aren't persistable column data — same opaque fallback as the
  // other structural kinds above.
  function: leaf("NVARCHAR(MAX)"),
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

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

// Builds CHECK constraint clauses from the same open-metadata constraint vocabulary
// as sql.ts / zod.ts / json-schema.ts (minimum/maximum/exclusiveMinimum/
// exclusiveMaximum/minLength/maxLength/multipleOf). Unlike sql.ts's columnDef/toSqlDdl
// split, `mssqlColumnDef` already has the column name in hand, so clauses are rendered
// directly (no placeholder token needed).
function buildMssqlChecks(name: string, kind: string, meta: Readonly<Record<string, unknown>>): string[] {
  const numberLike = isA(kind, "number")
  const stringLike = isA(kind, "string")
  const checks: string[] = []

  if (typeof meta.minimum === "number" && numberLike) checks.push(`CHECK (${name} >= ${meta.minimum})`)
  if (typeof meta.maximum === "number" && numberLike) checks.push(`CHECK (${name} <= ${meta.maximum})`)
  if (typeof meta.exclusiveMinimum === "number" && numberLike) checks.push(`CHECK (${name} > ${meta.exclusiveMinimum})`)
  if (typeof meta.exclusiveMaximum === "number" && numberLike) checks.push(`CHECK (${name} < ${meta.exclusiveMaximum})`)
  // MSSQL's length function is `LEN`, not `LENGTH` (T-SQL, unlike ANSI SQL/Postgres/MySQL/SQLite).
  if (typeof meta.minLength === "number" && stringLike) checks.push(`CHECK (LEN(${name}) >= ${meta.minLength})`)
  if (typeof meta.maxLength === "number" && stringLike) checks.push(`CHECK (LEN(${name}) <= ${meta.maxLength})`)
  // `pattern` (regex) is intentionally skipped: T-SQL has no regex operator, and
  // `LIKE` only supports a limited wildcard/character-class syntax, not real regex —
  // emitting a `LIKE`-based CHECK from a regex pattern would be silently lossy
  // (accepting/rejecting different values than the regex would). Skip rather than
  // emit a constraint that lies about what it enforces.
  if (typeof meta.multipleOf === "number" && numberLike) checks.push(`CHECK (${name} % ${meta.multipleOf} = 0)`)

  return checks
}

// Renders `meta.description` as a block comment. MSSQL's real column-comment
// mechanism is `sp_addextendedproperty`, a separate statement too complex to emit
// inline here; `--` is avoided because it would swallow the trailing comma
// `toMssqlCreateTable` appends after each column in a multi-column CREATE TABLE.
function buildMssqlComment(meta: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof meta.description !== "string") return undefined
  return `/* ${meta.description} */`
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

  for (const check of buildMssqlChecks(name, ref.shape.kind, ref.meta)) ddl += ` ${check}`

  if (ref.shape.kind === "enum") {
    const s = ref.shape as TypeShape & { kind: "enum" }
    ddl += ` ${enumCheckConstraint(name, s.members)}`
  }

  const comment = buildMssqlComment(ref.meta)
  if (comment !== undefined) ddl += ` ${comment}`

  return ddl
}

export function toMssqlCreateTable(tableName: string, fields: Record<string, TypeRef>): string {
  const columns = Object.entries(fields).map(([name, field]) => mssqlColumnDef(name, field))
  return `CREATE TABLE ${tableName} (\n  ${columns.join(",\n  ")}\n);`
}
