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

// Uses the `{name}` placeholder convention (see `buildMssqlChecks` above) rather than
// taking the column name directly, so it can be built name-agnostically inside
// `toMssqlColumn` and have the name substituted in later by `renderMssqlColumnDef`.
function enumCheckConstraint(members: readonly string[]): string {
  const values = members.map((m) => sqlLiteral(m)).join(", ")
  return `CHECK ({name} IN (${values}))`
}

function isA(kind: string, target: string): boolean {
  return kind === target || ancestors(kind).includes(target)
}

// Builds CHECK constraint clause templates from the same open-metadata constraint
// vocabulary as sql.ts / zod.ts / json-schema.ts (minimum/maximum/exclusiveMinimum/
// exclusiveMaximum/minLength/maxLength/multipleOf). Each returned clause contains the
// literal placeholder token `{name}` in place of the column name — same convention as
// sql.ts's `buildChecks`, so a column's checks can be built once (name-agnostic, e.g.
// for reuse by a union layout's `toColumn` callback) and have the name substituted in
// wherever the final column name is known (`renderMssqlColumnDef`).
function buildMssqlChecks(kind: string, meta: Readonly<Record<string, unknown>>): string[] {
  const numberLike = isA(kind, "number")
  const stringLike = isA(kind, "string")
  const checks: string[] = []

  if (typeof meta.minimum === "number" && numberLike) checks.push(`CHECK ({name} >= ${meta.minimum})`)
  if (typeof meta.maximum === "number" && numberLike) checks.push(`CHECK ({name} <= ${meta.maximum})`)
  if (typeof meta.exclusiveMinimum === "number" && numberLike) checks.push(`CHECK ({name} > ${meta.exclusiveMinimum})`)
  if (typeof meta.exclusiveMaximum === "number" && numberLike) checks.push(`CHECK ({name} < ${meta.exclusiveMaximum})`)
  // MSSQL's length function is `LEN`, not `LENGTH` (T-SQL, unlike ANSI SQL/Postgres/MySQL/SQLite).
  if (typeof meta.minLength === "number" && stringLike) checks.push(`CHECK (LEN({name}) >= ${meta.minLength})`)
  if (typeof meta.maxLength === "number" && stringLike) checks.push(`CHECK (LEN({name}) <= ${meta.maxLength})`)
  // `pattern` (regex) is intentionally skipped: T-SQL has no regex operator, and
  // `LIKE` only supports a limited wildcard/character-class syntax, not real regex —
  // emitting a `LIKE`-based CHECK from a regex pattern would be silently lossy
  // (accepting/rejecting different values than the regex would). Skip rather than
  // emit a constraint that lies about what it enforces.
  if (typeof meta.multipleOf === "number" && numberLike) checks.push(`CHECK ({name} % ${meta.multipleOf} = 0)`)

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

// Name-agnostic column parts — the MSSQL analogue of sql.ts's `SqlColumn`. Split out
// from `mssqlColumnDef` (which fuses type+name+nullability+... into one DDL string)
// so a union layout's `toColumn` callback can resolve a field's column shape without
// knowing its final column name (needed for e.g. single-table-inheritance, which
// widens `nullable` after the fact).
export type MssqlColumn = {
  type: string
  nullable: boolean
  identity?: boolean
  default?: string
  // CHECK constraint clauses, each containing the `{name}` placeholder — see
  // `buildMssqlChecks` above.
  checks?: string[]
  comment?: string
}

function toMssqlColumn(ref: TypeRef): MssqlColumn {
  const col: MssqlColumn = { type: toMssqlType(ref), nullable: ref.meta.nullable === true }

  if (ref.meta.identity === true) col.identity = true
  if (ref.meta.default !== undefined) col.default = sqlLiteral(ref.meta.default)

  const checks = buildMssqlChecks(ref.shape.kind, ref.meta)
  if (ref.shape.kind === "enum") {
    const s = ref.shape as TypeShape & { kind: "enum" }
    checks.push(enumCheckConstraint(s.members))
  }
  if (checks.length > 0) col.checks = checks

  const comment = buildMssqlComment(ref.meta)
  if (comment !== undefined) col.comment = comment

  return col
}

function renderMssqlColumnDef(name: string, col: MssqlColumn): string {
  let ddl = `${name} ${col.type}`

  if (col.identity) ddl += " IDENTITY(1,1)"

  ddl += col.nullable ? " NULL" : " NOT NULL"

  if (col.default !== undefined) ddl += ` DEFAULT ${col.default}`

  if (col.checks) for (const check of col.checks) ddl += ` ${check.replaceAll("{name}", name)}`

  if (col.comment !== undefined) ddl += ` ${col.comment}`

  return ddl
}

/**
 * Builds a full MSSQL column definition, including nullability, default, IDENTITY
 * (via `meta.identity`), and a CHECK constraint for enum-shaped columns (MSSQL has
 * no native enum type).
 */
export function mssqlColumnDef(name: string, ref: TypeRef): string {
  return renderMssqlColumnDef(name, toMssqlColumn(ref))
}

export function toMssqlCreateTable(tableName: string, fields: Record<string, TypeRef>): string {
  const columns = Object.entries(fields).map(([name, field]) => mssqlColumnDef(name, field))
  return `CREATE TABLE ${tableName} (\n  ${columns.join(",\n  ")}\n);`
}

// ============================================================================
// Union-root layouts
//
// Mirrors sql.ts's `SqlUnionLayout` / `singleTableInheritanceSqlLayout` /
// `tablePerVariantSqlLayout` — see that file's doc comments for the full
// rationale (a union-lowering strategy is a plain function, not a closed
// enum of named strategies; the two built-ins below are constructor
// functions so their one configuration point each has somewhere to live).
// Re-implemented here rather than imported: MSSQL's column representation
// (`MssqlColumn`, `renderMssqlColumnDef`) is its own type, distinct from
// sql.ts's `SqlColumn`/`columnDef`.
// ============================================================================

export type MssqlUnionLayoutInput = {
  name: string
  discriminator: string | undefined
  variants: { name: string; ref: TypeRef }[]
  toColumn: (ref: TypeRef) => MssqlColumn
}

export type MssqlUnionLayout = (input: MssqlUnionLayoutInput) => string

function mssqlStringColumn(toColumn: (ref: TypeRef) => MssqlColumn): MssqlColumn {
  const ref: TypeRef = { shape: { kind: "string" } as TypeShape, meta: {} }
  return { ...toColumn(ref), nullable: false }
}

/** Single-table-inheritance layout — see `singleTableInheritanceSqlLayout` in sql.ts. */
export function singleTableInheritanceMssqlLayout(opts?: { discriminatorColumn?: string }): MssqlUnionLayout {
  const fallbackDiscriminatorColumn = opts?.discriminatorColumn ?? "kind"
  return ({ name, discriminator, variants, toColumn }) => {
    const discriminatorName = discriminator ?? fallbackDiscriminatorColumn
    const columns: string[] = [renderMssqlColumnDef(discriminatorName, mssqlStringColumn(toColumn))]

    const seen = new Set<string>()
    for (const { ref } of variants) {
      if (!isA(ref.shape.kind, "object")) continue
      const s = ref.shape as TypeShape & { kind: "object" }
      for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
        if (fieldName === discriminatorName) continue
        if (seen.has(fieldName)) continue
        seen.add(fieldName)
        columns.push(renderMssqlColumnDef(fieldName, { ...toColumn(fieldRef), nullable: true }))
      }
    }

    return `CREATE TABLE ${name} (\n  ${columns.join(",\n  ")}\n);`
  }
}

/** Table-per-variant layout — see `tablePerVariantSqlLayout` in sql.ts. */
export function tablePerVariantMssqlLayout(opts?: { tableName?: (unionName: string, variantName: string) => string }): MssqlUnionLayout {
  const tableName = opts?.tableName ?? ((unionName: string, variantName: string) => `${unionName}_${variantName}`)
  return ({ name, variants, toColumn }) => {
    const tables = variants.map(({ name: variantName, ref }) => {
      const table = tableName(name, variantName)
      if (isA(ref.shape.kind, "object")) {
        const s = ref.shape as TypeShape & { kind: "object" }
        const columns = Object.entries(s.fields).map(([fieldName, fieldRef]) => renderMssqlColumnDef(fieldName, toColumn(fieldRef)))
        return `CREATE TABLE ${table} (\n  ${columns.join(",\n  ")}\n);`
      }
      return `CREATE TABLE ${table} (\n  ${renderMssqlColumnDef("value", toColumn(ref))}\n);`
    })
    return tables.join("\n\n")
  }
}

/**
 * Base-table-per-variant layout — see `baseTablePerVariantSqlLayout` in
 * sql.ts for the full rationale. The primary/foreign key types default to
 * MSSQL's own `INT IDENTITY(1,1) PRIMARY KEY` / `INT` (rather than
 * Postgres's `SERIAL`/`INTEGER`) since `MssqlUnionLayout` has no other
 * dialect-appropriate default to reach for.
 */
export function baseTablePerVariantMssqlLayout(opts?: {
  baseTableName?: (unionName: string) => string
  tableName?: (unionName: string, variantName: string) => string
  foreignKeyColumn?: (unionName: string) => string
  foreignKeyType?: string
  primaryKeyColumn?: string
  primaryKeyType?: string
  discriminatorColumn?: string
}): MssqlUnionLayout {
  const baseTableName = opts?.baseTableName ?? ((unionName: string) => unionName)
  const tableName = opts?.tableName ?? ((unionName: string, variantName: string) => `${unionName}_${variantName}`)
  const foreignKeyColumn = opts?.foreignKeyColumn ?? ((unionName: string) => `${unionName}_id`)
  const foreignKeyType = opts?.foreignKeyType ?? "INT"
  const primaryKeyColumn = opts?.primaryKeyColumn ?? "id"
  const primaryKeyType = opts?.primaryKeyType ?? "INT IDENTITY(1,1) PRIMARY KEY"
  const fallbackDiscriminatorColumn = opts?.discriminatorColumn ?? "kind"

  return ({ name, discriminator, variants, toColumn }) => {
    const discriminatorName = discriminator ?? fallbackDiscriminatorColumn
    const base = baseTableName(name)
    const fk = foreignKeyColumn(name)

    const objectVariants = variants.filter(({ ref }) => isA(ref.shape.kind, "object"))

    let commonFieldNames: string[] | undefined
    for (const { ref } of objectVariants) {
      const s = ref.shape as TypeShape & { kind: "object" }
      const fieldNames = Object.keys(s.fields).filter((f) => f !== discriminatorName)
      commonFieldNames = commonFieldNames === undefined ? fieldNames : commonFieldNames.filter((f) => fieldNames.includes(f))
    }
    const common = new Set(commonFieldNames ?? [])

    const baseColumns: string[] = [
      `${primaryKeyColumn} ${primaryKeyType}`,
      renderMssqlColumnDef(discriminatorName, mssqlStringColumn(toColumn)),
    ]
    const seen = new Set<string>()
    for (const { ref } of objectVariants) {
      const s = ref.shape as TypeShape & { kind: "object" }
      for (const [fieldName, fieldRef] of Object.entries(s.fields)) {
        if (!common.has(fieldName) || seen.has(fieldName)) continue
        seen.add(fieldName)
        baseColumns.push(renderMssqlColumnDef(fieldName, toColumn(fieldRef)))
      }
    }
    const baseTable = `CREATE TABLE ${base} (\n  ${baseColumns.join(",\n  ")}\n);`

    const childTables = variants.map(({ name: variantLabel, ref }) => {
      const table = tableName(name, variantLabel)
      const fkColumn = `${fk} ${foreignKeyType} NOT NULL REFERENCES ${base}(${primaryKeyColumn})`
      if (isA(ref.shape.kind, "object")) {
        const s = ref.shape as TypeShape & { kind: "object" }
        const columns = Object.entries(s.fields)
          .filter(([fieldName]) => fieldName !== discriminatorName && !common.has(fieldName))
          .map(([fieldName, fieldRef]) => renderMssqlColumnDef(fieldName, toColumn(fieldRef)))
        return `CREATE TABLE ${table} (\n  ${[fkColumn, ...columns].join(",\n  ")}\n);`
      }
      return `CREATE TABLE ${table} (\n  ${[fkColumn, renderMssqlColumnDef("value", toColumn(ref))].join(",\n  ")}\n);`
    })

    return [baseTable, ...childTables].join("\n\n")
  }
}

// Resolves a union variant's name — see `variantName` in sql.ts for the full
// rationale (mirrors toProtoUnionMessage/toCapnpUnionStruct's tagged-union
// naming convention).
function mssqlVariantName(discriminator: string | undefined, ref: TypeRef, index: number): string {
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

export interface MssqlTableOptions {
  unionLayout?: MssqlUnionLayout
}

/**
 * Entry point for a TypeRef whose root may be `object` OR `union` (unlike
 * `toMssqlCreateTable` above, which only ever took an already-extracted
 * `fields` record and so had no way to see a union root at all). Object
 * roots delegate straight to `toMssqlCreateTable`; union roots extract each
 * variant's name/ref and dispatch to `opts.unionLayout` (default:
 * `singleTableInheritanceMssqlLayout()`).
 */
export function toMssqlCreateTableFromRef(tableName: string, ref: TypeRef, opts?: MssqlTableOptions): string {
  if (isA(ref.shape.kind, "union")) {
    const s = ref.shape as TypeShape & { kind: "union" }
    const discriminator = typeof ref.meta.discriminator === "string" ? ref.meta.discriminator : undefined
    const variants = s.variants.map((variant, i) => ({ name: mssqlVariantName(discriminator, variant, i + 1), ref: variant }))
    const layout = opts?.unionLayout ?? singleTableInheritanceMssqlLayout()
    return layout({ name: tableName, discriminator, variants, toColumn: toMssqlColumn })
  }
  if (!isA(ref.shape.kind, "object")) throw new Error(`toMssqlCreateTableFromRef requires an object or union type, got "${ref.shape.kind}"`)
  const s = ref.shape as TypeShape & { kind: "object" }
  return toMssqlCreateTable(tableName, s.fields)
}
