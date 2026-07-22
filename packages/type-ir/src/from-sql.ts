// packages/type-ir/src/from-sql.ts — @rhi-zone/fractal-type-ir/from-sql
//
// SQL DDL (`CREATE TABLE ...`) -> TypeRef, the reverse direction of sql.ts's
// TypeRef -> SQL DDL projector (toSqlDdl/toCreateTable). Covers the three
// dialects sql.ts targets: postgres, mysql, sqlite (sql-mssql.ts's MSSQL
// dialect is a separate projector with its own IDENTITY/NVARCHAR conventions
// and is out of scope here, same as sql.ts itself never emits MSSQL DDL).
//
// A lightweight hand-rolled parser, not a real SQL grammar — CREATE TABLE's
// surface is bounded enough (column list + a handful of table-level
// constraints) that a full parser-generator/grammar dependency isn't
// justified. SELECT/INSERT/views/triggers/stored procedures are explicitly
// out of scope, matching the brief.
//
// Column type mapping mirrors sql.ts's own leaf handlers where a dedicated IR
// kind exists (uuid/datetime/date/time/duration/bytes from kinds/common.ts) —
// deliberately NOT the literal `string` + `meta.format` shape a first read of
// "UUID -> string (format: uuid)" might suggest, because BLOB/BYTEA's own
// "-> bytes" mapping already establishes the dedicated-kind convention, and
// using `string`+meta.format here would silently break round-tripping through
// sql.ts (whose handlers dispatch on `shape.kind`, e.g. `"uuid"` -> `UUID`,
// not on `meta.format`). Kinds without a dedicated IR representative (e.g. no
// generic "unsigned" or "interval-less" concept) fall back to `meta` instead.
//
// Column-level SQL concepts sql.ts's forward direction doesn't model at all
// (PRIMARY KEY, UNIQUE, REFERENCES, CHECK-as-raw-text, AUTO_INCREMENT/SERIAL)
// are preserved as open `meta` conventions local to this pair of modules:
//   - meta.primaryKey: boolean — column participates in the table's primary key.
//   - meta.unique: boolean — column has a single-column UNIQUE constraint.
//   - meta.autoincrement: boolean — SERIAL/BIGSERIAL/AUTO_INCREMENT/AUTOINCREMENT.
//   - meta.references: { table: string; column?: string } — FOREIGN KEY target.
//   - meta.checks: string[] — CHECK clause text that didn't parse into one of
//     the structured constraint keys sql.ts's buildChecks already understands
//     (minimum/maximum/exclusiveMinimum/exclusiveMaximum/minLength/maxLength/
//     multipleOf) — those DO get parsed back into their structured form so a
//     round trip through sql.ts's toSqlDdl regenerates an equivalent CHECK.
// The table's own object-level TypeRef additionally carries:
//   - meta.primaryKey: string[] — full (possibly composite) primary key column
//     list, independent of the per-column boolean above.
//   - meta.uniqueConstraints: string[][] — multi-column UNIQUE constraint groups.

import { t, types, type TypeRef } from "./index.ts"
import { bytes, datetime, date, duration, time, uuid } from "./kinds/common.ts"

export type SqlDialect = "postgres" | "sqlite" | "mysql"

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

// ============================================================================
// Statement / column-list splitting — depth- and quote-aware so commas and
// semicolons inside `(...)`, `'...'`, `"..."`, or `` `...` `` don't split
// prematurely (default expressions, CHECK clauses, ENUM member lists, ...).
// ============================================================================

/** Split `text` on top-level occurrences of `sep` (a single char), tracking
 * paren depth and quote state so separators inside `(...)`/string literals/
 * quoted identifiers are not treated as splits. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote !== null) {
      if (c === quote) {
        // '' inside a '...'-quoted string is an escaped quote, not the end.
        if (quote === "'" && text[i + 1] === "'") {
          i++
          continue
        }
        quote = null
      }
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c
    } else if (c === "(") {
      depth++
    } else if (c === ")") {
      depth--
    } else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** Split a full DDL string into individual statements (top-level `;`). */
function splitStatements(ddl: string): string[] {
  return splitTopLevel(ddl, ";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ============================================================================
// CREATE TABLE statement extraction
// ============================================================================

const CREATE_TABLE_RE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w.]+))\s*\(([\s\S]*)\)[\s\S]*$/i

type ParsedCreateTable = { name: string; body: string }

/** Extract the table name and the raw column-list text between the outer
 * parens from one `CREATE TABLE ...` statement. Trailing dialect-specific
 * table options (`ENGINE=InnoDB`, `WITHOUT ROWID`, ...) after the closing
 * paren are discarded — they carry no TypeRef-relevant information. */
function parseCreateTable(stmt: string): ParsedCreateTable | undefined {
  const match = CREATE_TABLE_RE.exec(stmt.trim())
  if (match === null) return undefined
  const name = match[1] ?? match[2] ?? match[3] ?? match[4]
  if (name === undefined) return undefined
  // The regex's `([\s\S]*)` for the body is greedy across the WHOLE
  // statement, which would swallow a trailing `)` that actually closes the
  // outer CREATE TABLE paren, not a nested one. Re-derive the body by
  // scanning for the matching close paren of the FIRST `(` instead.
  const openIdx = stmt.indexOf("(", match.index)
  if (openIdx < 0) return undefined
  let depth = 0
  let closeIdx = -1
  let quote: string | null = null
  for (let i = openIdx; i < stmt.length; i++) {
    const c = stmt[i]!
    if (quote !== null) {
      if (c === quote) {
        if (quote === "'" && stmt[i + 1] === "'") {
          i++
          continue
        }
        quote = null
      }
      continue
    }
    if (c === "'" || c === '"' || c === "`") quote = c
    else if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) {
        closeIdx = i
        break
      }
    }
  }
  if (closeIdx < 0) return undefined
  return { name, body: stmt.slice(openIdx + 1, closeIdx) }
}

// ============================================================================
// Type-name -> TypeRef mapping
// ============================================================================

type TypeMapping = { ref: TypeRef; extraMeta?: Record<string, unknown> | undefined }

const MULTI_WORD_TYPES = [
  "DOUBLE PRECISION",
  "CHARACTER VARYING",
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMP WITHOUT TIME ZONE",
  "TIME WITH TIME ZONE",
  "TIME WITHOUT TIME ZONE",
  "BIT VARYING",
]

/** Parse a column's raw type text (`VARCHAR(255)`, `NUMERIC(10, 2)`,
 * `ENUM('a', 'b')`, `TEXT[]`, `DOUBLE PRECISION`, ...) into a type name,
 * optional parenthesized args, and an array-depth count. */
function parseTypeText(raw: string): { name: string; args: string[]; arrayDepth: number } {
  let text = raw.trim()
  let arrayDepth = 0
  while (/\[\s*\]\s*$/.test(text)) {
    text = text.replace(/\[\s*\]\s*$/, "").trim()
    arrayDepth++
  }
  // ARRAY suffix form: `INTEGER ARRAY` (postgres alternate array syntax).
  const arrayWordMatch = /^(.*?)\s+ARRAY$/i.exec(text)
  if (arrayWordMatch !== null) {
    text = arrayWordMatch[1]!.trim()
    arrayDepth++
  }

  const upper = text.toUpperCase()
  for (const multi of MULTI_WORD_TYPES) {
    if (upper.startsWith(multi)) {
      const rest = text.slice(multi.length).trim()
      const argsMatch = /^\(([^)]*)\)/.exec(rest)
      const args = argsMatch !== null ? splitTopLevel(argsMatch[1]!, ",").map((s) => s.trim()) : []
      return { name: multi, args, arrayDepth }
    }
  }

  const m = /^([A-Za-z_][\w]*)\s*(?:\(([^]*)\))?$/.exec(text)
  if (m === null) return { name: upper, args: [], arrayDepth }
  const name = m[1]!.toUpperCase()
  const argsText = m[2]
  const args = argsText === undefined ? [] : splitTopLevel(argsText, ",").map((s) => s.trim())
  return { name, args, arrayDepth }
}

function unquoteStringLiteral(s: string): string {
  const m = /^'((?:[^']|'')*)'$/.exec(s.trim())
  if (m === null) return s.trim()
  return m[1]!.replace(/''/g, "'")
}

/** Reverse of sql.ts's leaf handlers: SQL type name -> TypeRef. `dialect`
 * only affects unrecognized-type fallback behavior (SQLite's flexible/
 * affinity-based typing vs. postgres/mysql's stricter "unknown -> unknown,
 * preserve original name" fallback). */
function mapSqlType(name: string, args: string[], dialect: SqlDialect | undefined): TypeMapping {
  switch (name) {
    case "ENUM":
      return { ref: t(types.enum(args.map(unquoteStringLiteral))) }

    case "SERIAL":
    case "BIGSERIAL":
    case "SMALLSERIAL":
      return { ref: t(types.integer), extraMeta: { autoincrement: true } }

    case "BOOLEAN":
    case "BOOL":
      return { ref: t(types.boolean) }

    case "UUID":
    case "UNIQUEIDENTIFIER":
      return { ref: uuid() }

    case "DATE":
      return { ref: date() }

    case "TIME":
    case "TIME WITH TIME ZONE":
    case "TIME WITHOUT TIME ZONE":
      return { ref: time() }

    case "TIMESTAMP":
    case "TIMESTAMPTZ":
    case "TIMESTAMP WITH TIME ZONE":
    case "TIMESTAMP WITHOUT TIME ZONE":
    case "DATETIME":
    case "DATETIME2":
      return { ref: datetime() }

    case "INTERVAL":
      return { ref: duration() }

    case "JSON":
    case "JSONB":
      return { ref: t(types.unknown) }

    case "BLOB":
    case "BYTEA":
    case "VARBINARY":
    case "BINARY":
    case "LONGBLOB":
    case "MEDIUMBLOB":
    case "TINYBLOB":
    case "IMAGE":
      return { ref: bytes() }

    case "VARCHAR":
    case "CHARACTER VARYING":
    case "NVARCHAR":
    case "CHAR":
    case "CHARACTER":
    case "NCHAR":
    case "CLOB": {
      const len = args[0] !== undefined ? Number.parseInt(args[0], 10) : undefined
      return { ref: t(types.string, len !== undefined && !Number.isNaN(len) ? { maxLength: len } : {}) }
    }

    case "TEXT":
    case "MEDIUMTEXT":
    case "LONGTEXT":
    case "TINYTEXT":
    case "NTEXT":
      return { ref: t(types.string) }

    case "TINYINT": {
      // MySQL's conventional boolean stand-in (sql.ts's mysqlHandlers emits
      // `TINYINT(1)` for `boolean`, matching this reverse mapping).
      if (args[0] === "1") return { ref: t(types.boolean) }
      return { ref: t(types.integer) }
    }

    case "INT":
    case "INTEGER":
    case "INT2":
    case "INT4":
    case "INT8":
    case "BIGINT":
    case "SMALLINT":
    case "MEDIUMINT":
      return { ref: t(types.integer) }

    case "FLOAT":
    case "FLOAT4":
    case "FLOAT8":
    case "DOUBLE":
    case "DOUBLE PRECISION":
    case "REAL":
    case "DECIMAL":
    case "NUMERIC":
    case "MONEY": {
      const meta: Record<string, unknown> = {}
      const precision = args[0] !== undefined ? Number.parseInt(args[0], 10) : undefined
      const scale = args[1] !== undefined ? Number.parseInt(args[1], 10) : undefined
      if (precision !== undefined && !Number.isNaN(precision)) meta.precision = precision
      if (scale !== undefined && !Number.isNaN(scale)) meta.scale = scale
      return { ref: t(types.number, meta) }
    }

    default:
      return dialect === "sqlite" ? { ref: sqliteAffinity(name) } : { ref: t(types.unknown, { sqlType: name }) }
  }
}

// SQLite "type affinity" rules (https://www.sqlite.org/datatype3.html §3):
// applied when a declared type name isn't one of the concrete names above
// (SQLite accepts near-arbitrary type names/no type at all on a column).
function sqliteAffinity(name: string): TypeRef {
  const upper = name.toUpperCase()
  if (upper.includes("INT")) return t(types.integer)
  if (upper.includes("CHAR") || upper.includes("CLOB") || upper.includes("TEXT")) return t(types.string)
  if (upper.includes("BLOB") || upper === "") return t(types.unknown)
  if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB")) return t(types.number)
  // NUMERIC affinity (the SQLite default for anything else, incl. NUMERIC/
  // DECIMAL-like custom names not already matched above).
  return t(types.number)
}

function typeRefForColumn(typeText: string, dialect: SqlDialect | undefined): TypeMapping {
  const { name, args, arrayDepth } = parseTypeText(typeText)
  const base = mapSqlType(name, args, dialect)
  if (arrayDepth === 0) return base
  let ref = base.ref
  for (let i = 0; i < arrayDepth; i++) ref = t(types.array(ref))
  return { ref, extraMeta: base.extraMeta }
}

// ============================================================================
// DEFAULT / CHECK value parsing
// ============================================================================

/** Parse a `DEFAULT <value>` clause's raw text into a JS value where the
 * value is a recognizable literal (string/number/boolean), or leave it as
 * the original expression text (e.g. `CURRENT_TIMESTAMP`, `nextval('s')`) —
 * sql.ts's `sqlLiteral` re-quotes a string default, so a raw SQL expression
 * default is inherently lossy through a full round trip; it's preserved
 * verbatim here so callers that don't route back through sql.ts still see it. */
function parseDefaultValue(raw: string): unknown {
  const text = raw.trim().replace(/^\((.*)\)$/, "$1").trim()
  if (/^NULL$/i.test(text)) return undefined
  if (/^TRUE$/i.test(text)) return true
  if (/^FALSE$/i.test(text)) return false
  if (/^'(?:[^']|'')*'$/.test(text)) return unquoteStringLiteral(text)
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  return text
}

type CheckParseResult = Record<string, unknown> | undefined

/** Reverse of sql.ts's `buildChecks`: recognize the exact clause shapes it
 * generates (`{name} >= N`, `LENGTH({name}) <= N`, `{name} % N = 0`, ...) and
 * recover the structured constraint key so a round trip through
 * `toSqlDdl`/`buildChecks` regenerates an equivalent clause. Clauses that
 * don't match any known shape are left for the caller to keep as raw text. */
function parseCheckClause(clause: string, columnName?: string): CheckParseResult {
  const inner = clause.trim().replace(/^CHECK\s*\(/i, "").replace(/\)$/, "").trim()
  const name = columnName !== undefined ? columnName.replace(/[.[\]$*+?^{}()|\\]/g, "\\$&") : "[A-Za-z_][\\w.\"'`]*"

  let m = new RegExp(`^${name}\\s*>=\\s*(-?\\d+(?:\\.\\d+)?)$`, "i").exec(inner)
  if (m !== null) return { minimum: Number(m[1]) }
  m = new RegExp(`^${name}\\s*<=\\s*(-?\\d+(?:\\.\\d+)?)$`, "i").exec(inner)
  if (m !== null) return { maximum: Number(m[1]) }
  m = new RegExp(`^${name}\\s*>\\s*(-?\\d+(?:\\.\\d+)?)$`, "i").exec(inner)
  if (m !== null) return { exclusiveMinimum: Number(m[1]) }
  m = new RegExp(`^${name}\\s*<\\s*(-?\\d+(?:\\.\\d+)?)$`, "i").exec(inner)
  if (m !== null) return { exclusiveMaximum: Number(m[1]) }
  m = new RegExp(`^LENGTH\\(\\s*${name}\\s*\\)\\s*>=\\s*(\\d+)$`, "i").exec(inner)
  if (m !== null) return { minLength: Number(m[1]) }
  m = new RegExp(`^LENGTH\\(\\s*${name}\\s*\\)\\s*<=\\s*(\\d+)$`, "i").exec(inner)
  if (m !== null) return { maxLength: Number(m[1]) }
  m = new RegExp(`^${name}\\s*%\\s*(-?\\d+(?:\\.\\d+)?)\\s*=\\s*0$`, "i").exec(inner)
  if (m !== null) return { multipleOf: Number(m[1]) }
  m = new RegExp(`^${name}\\s*(?:~|REGEXP)\\s*'((?:[^']|'')*)'$`, "i").exec(inner)
  if (m !== null) return { pattern: m[1]!.replace(/''/g, "'") }

  return undefined
}

// ============================================================================
// Column / table-level constraint parsing
// ============================================================================

type ColumnInfo = {
  name: string
  ref: TypeRef
  nullable: boolean
  primaryKey: boolean
  unique: boolean
}

type TableInfo = {
  columns: ColumnInfo[]
  primaryKey: string[]
  uniqueConstraints: string[][]
  foreignKeys: Map<string, { table: string; column?: string }>
  tableChecks: string[]
}

function stripQuotes(name: string): string {
  const m = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\])$/.exec(name.trim())
  if (m === null) return name.trim()
  return m[1] ?? m[2] ?? m[3] ?? name.trim()
}

const TABLE_CONSTRAINT_RE = /^(?:CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i

function splitColumnNames(text: string): string[] {
  return splitTopLevel(text, ",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s.length > 0)
}

/** Consume constraint clauses one at a time from the front of `text` (after
 * the column's type has already been stripped off), applying each to
 * `meta`/`flags` as it's recognized. Returns once no further known clause
 * matches the remaining text. */
function parseColumnConstraints(
  text: string,
  meta: Record<string, unknown>,
  flags: { nullable: boolean; primaryKey: boolean; unique: boolean },
): void {
  let rest = text.trim()
  while (rest.length > 0) {
    let m: RegExpExecArray | null

    if ((m = /^NOT\s+NULL\b/i.exec(rest)) !== null) {
      flags.nullable = false
    } else if ((m = /^NULL\b/i.exec(rest)) !== null) {
      flags.nullable = true
    } else if ((m = /^PRIMARY\s+KEY\b/i.exec(rest)) !== null) {
      flags.primaryKey = true
      flags.nullable = false
    } else if ((m = /^UNIQUE\b/i.exec(rest)) !== null) {
      flags.unique = true
    } else if ((m = /^(?:AUTO_INCREMENT|AUTOINCREMENT)\b/i.exec(rest)) !== null) {
      meta.autoincrement = true
    } else if ((m = /^GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i.exec(rest)) !== null) {
      meta.autoincrement = true
    } else if ((m = /^UNSIGNED\b/i.exec(rest)) !== null) {
      meta.unsigned = true
    } else if ((m = /^COLLATE\s+\S+/i.exec(rest)) !== null) {
      // no IR-level representation — discarded.
    } else if ((m = /^ON\s+(?:UPDATE|DELETE)\s+(?:CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/i.exec(rest)) !== null) {
      // FK action clauses — attach to `meta.references` once parsed, if present.
    } else if ((m = /^COMMENT\s+'((?:[^']|'')*)'/i.exec(rest)) !== null) {
      meta.description = m[1]!.replace(/''/g, "'")
    } else if ((m = /^DEFAULT\s+/i.exec(rest)) !== null) {
      const afterKeyword = rest.slice(m[0].length)
      const { text: valueText, consumed } = extractDefaultExpr(afterKeyword)
      const parsed = parseDefaultValue(valueText)
      if (parsed !== undefined) meta.default = parsed
      rest = afterKeyword.slice(consumed).trim()
      continue
    } else if ((m = /^REFERENCES\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w.]+))\s*(?:\(([^)]+)\))?/i.exec(rest)) !== null) {
      const table = m[1] ?? m[2] ?? m[3] ?? m[4]!
      const column = m[5] !== undefined ? stripQuotes(splitColumnNames(m[5])[0] ?? "") : undefined
      meta.references = column !== undefined ? { table, column } : { table }
    } else if ((m = /^CHECK\s*\(/i.exec(rest)) !== null) {
      const { clause, consumed } = extractBalancedParen(rest, m[0].length - 1)
      const parsedCheck = parseCheckClause(`CHECK(${clause})`)
      if (parsedCheck !== undefined) Object.assign(meta, parsedCheck)
      else {
        const checks = (meta.checks as string[] | undefined) ?? []
        checks.push(`CHECK (${clause})`)
        meta.checks = checks
      }
      rest = rest.slice(consumed).trim()
      continue
    } else {
      // Unrecognized token — skip it (whitespace-delimited) rather than loop
      // forever or throw; matches this package's honest-degrade convention
      // for input it can't fully interpret.
      const skip = /^\S+/.exec(rest)
      if (skip === null) break
      rest = rest.slice(skip[0].length).trim()
      continue
    }
    rest = rest.slice(m[0].length).trim()
  }
}

/** Extract the parenthesized text starting at `text[openIdx]` (which must be
 * `(`), returning the inner text and how many characters (from the start of
 * `text`) were consumed through the matching close paren. */
function extractBalancedParen(text: string, openIdx: number): { clause: string; consumed: number } {
  let depth = 0
  let quote: string | null = null
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!
    if (quote !== null) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i++
          continue
        }
        quote = null
      }
      continue
    }
    if (c === "'") quote = c
    else if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return { clause: text.slice(openIdx + 1, i), consumed: i + 1 }
    }
  }
  return { clause: text.slice(openIdx + 1), consumed: text.length }
}

/** A `DEFAULT` value's text runs until the next recognized constraint
 * keyword or end of string — it may itself contain parens (`nextval('s')`,
 * `(now())`) that must not be mistaken for a following clause's boundary. */
function extractDefaultExpr(text: string): { text: string; consumed: number } {
  if (text.trim().startsWith("'")) {
    const m = /^\s*'(?:[^']|'')*'/.exec(text)
    if (m !== null) return { text: m[0], consumed: m[0].length }
  }
  if (text.trim().startsWith("(")) {
    const openIdx = text.indexOf("(")
    const { clause, consumed } = extractBalancedParen(text, openIdx)
    return { text: `(${clause})`, consumed }
  }
  const stopKeywords =
    /\s+(NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|REFERENCES|CHECK|COLLATE|AUTO_INCREMENT|AUTOINCREMENT|GENERATED|UNSIGNED|COMMENT|ON\s+(?:UPDATE|DELETE))\b/i
  const stopMatch = stopKeywords.exec(text)
  // A bare expression may itself contain one balanced paren call, e.g.
  // `now()`, `gen_random_uuid()` — consume through it before applying the
  // keyword boundary so a following clause isn't accidentally swallowed.
  const callMatch = /^\s*[\w.]+\s*\([^)]*\)/.exec(text)
  if (callMatch !== null && (stopMatch === null || callMatch[0].length <= stopMatch.index)) {
    return { text: callMatch[0], consumed: callMatch[0].length }
  }
  const end = stopMatch !== null ? stopMatch.index : text.length
  return { text: text.slice(0, end), consumed: end }
}

/** Parse one item from a CREATE TABLE column list — either a column
 * definition or a table-level constraint clause. */
function parseColumnListItem(item: string, table: TableInfo, dialect: SqlDialect | undefined): void {
  const trimmed = item.trim()
  if (trimmed.length === 0) return

  const constraintMatch = TABLE_CONSTRAINT_RE.exec(trimmed)
  if (constraintMatch !== null) {
    const kind = constraintMatch[1]!.toUpperCase().replace(/\s+/, " ")
    const afterKeyword = trimmed.slice(constraintMatch[0].length).trim()

    if (kind === "PRIMARY KEY") {
      const openIdx = afterKeyword.indexOf("(")
      if (openIdx >= 0) {
        const { clause } = extractBalancedParen(afterKeyword, openIdx)
        table.primaryKey.push(...splitColumnNames(clause))
      }
      return
    }
    if (kind === "UNIQUE") {
      const openIdx = afterKeyword.indexOf("(")
      if (openIdx >= 0) {
        const { clause } = extractBalancedParen(afterKeyword, openIdx)
        table.uniqueConstraints.push(splitColumnNames(clause))
      }
      return
    }
    if (kind === "FOREIGN KEY") {
      const openIdx = afterKeyword.indexOf("(")
      if (openIdx < 0) return
      const { clause, consumed } = extractBalancedParen(afterKeyword, openIdx)
      const cols = splitColumnNames(clause)
      const refMatch = /REFERENCES\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w.]+))\s*(?:\(([^)]+)\))?/i.exec(afterKeyword.slice(consumed))
      if (refMatch !== null) {
        const refTable = refMatch[1] ?? refMatch[2] ?? refMatch[3] ?? refMatch[4]!
        const refCol = refMatch[5] !== undefined ? splitColumnNames(refMatch[5])[0] : undefined
        for (const col of cols) table.foreignKeys.set(col, refCol !== undefined ? { table: refTable, column: refCol } : { table: refTable })
      }
      return
    }
    if (kind === "CHECK") {
      const openIdx = trimmed.toUpperCase().indexOf("CHECK") + "CHECK".length
      const parenIdx = trimmed.indexOf("(", openIdx)
      if (parenIdx >= 0) {
        const { clause } = extractBalancedParen(trimmed, parenIdx)
        table.tableChecks.push(`CHECK (${clause})`)
      }
      return
    }
    return
  }

  // Column definition: <name> <type>[(args)] [constraints...]
  const nameMatch = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\S+))\s+([\s\S]+)$/.exec(trimmed)
  if (nameMatch === null) return
  const name = nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? nameMatch[4]!
  const afterName = nameMatch[5]!.trim()

  // Split off the type text: type name + optional (args) + optional array
  // suffix + optional multi-word continuation, stopping before any
  // recognized column constraint keyword.
  const typeMatch =
    /^([A-Za-z_][\w]*(?:\s+(?:PRECISION|VARYING|ZONE|TIME|WITH|WITHOUT))*)\s*(\([^)]*\))?((?:\s*\[\s*\])*|\s+ARRAY)?/i.exec(afterName)
  const typeText = typeMatch !== null ? (typeMatch[0] ?? "").trim() : (afterName.split(/\s+/)[0] ?? "")
  const constraintsText = afterName.slice(typeText.length).trim()

  const { ref: baseRef, extraMeta } = typeRefForColumn(typeText, dialect)

  const meta: Record<string, unknown> = { ...extraMeta }
  const flags = { nullable: true, primaryKey: false, unique: false }
  parseColumnConstraints(constraintsText, meta, flags)

  const colName = stripQuotes(name)
  const finalMeta: Record<string, unknown> = { ...meta }
  if (flags.nullable) finalMeta.nullable = true
  if (flags.primaryKey) finalMeta.primaryKey = true
  if (flags.unique) finalMeta.unique = true

  table.columns.push({
    name: colName,
    ref: withMeta(baseRef, finalMeta),
    nullable: flags.nullable,
    primaryKey: flags.primaryKey,
    unique: flags.unique,
  })
  if (flags.primaryKey) table.primaryKey.push(colName)
}

function parseTableBody(body: string, dialect: SqlDialect | undefined): TableInfo {
  const table: TableInfo = {
    columns: [],
    primaryKey: [],
    uniqueConstraints: [],
    foreignKeys: new Map(),
    tableChecks: [],
  }
  for (const item of splitTopLevel(body, ",")) {
    parseColumnListItem(item, table, dialect)
  }
  return table
}

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Convert one or more `CREATE TABLE` DDL statements into a map of table name
 * -> `TypeRef` (each an `object` type with one field per column). Multiple
 * `CREATE TABLE` statements in one string produce multiple map entries;
 * non-`CREATE TABLE` statements (if any slip through — views, etc.) are
 * silently skipped, matching this package's other ingesters' honest-degrade
 * convention for input outside their scope.
 */
export function fromSql(ddl: string, opts?: { dialect?: SqlDialect }): Record<string, TypeRef> {
  const result: Record<string, TypeRef> = {}

  for (const stmt of splitStatements(ddl)) {
    const parsed = parseCreateTable(stmt)
    if (parsed === undefined) continue

    const table = parseTableBody(parsed.body, opts?.dialect)

    // Apply table-level FOREIGN KEY targets (inline REFERENCES on a column
    // definition already set meta.references directly; table-level FOREIGN
    // KEY clauses are folded in here since they name the column separately).
    for (const col of table.columns) {
      const fk = table.foreignKeys.get(col.name)
      if (fk !== undefined && col.ref.meta.references === undefined) {
        col.ref = withMeta(col.ref, { references: fk })
      }
    }

    // Table-level PRIMARY KEY(...)/UNIQUE(...) mark the named columns too,
    // even though the constraint itself was declared outside the column def.
    const pkSet = new Set(table.primaryKey)
    const uniqueSet = new Set(table.uniqueConstraints.flat())
    for (const col of table.columns) {
      if (pkSet.has(col.name) && col.ref.meta.primaryKey !== true) {
        col.ref = withMeta(col.ref, { primaryKey: true, nullable: false })
      }
      if (uniqueSet.has(col.name) && col.ref.meta.unique !== true) {
        col.ref = withMeta(col.ref, { unique: true })
      }
    }

    const fields: Record<string, TypeRef> = {}
    for (const col of table.columns) fields[col.name] = col.ref

    const tableMeta: Record<string, unknown> = {}
    if (table.primaryKey.length > 0) tableMeta.primaryKey = [...new Set(table.primaryKey)]
    if (table.uniqueConstraints.length > 0) tableMeta.uniqueConstraints = table.uniqueConstraints
    if (table.tableChecks.length > 0) tableMeta.checks = table.tableChecks

    result[parsed.name] = t(types.object(fields), tableMeta)
  }

  return result
}
