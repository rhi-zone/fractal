// packages/type-ir/src/from-cql.ts — @rhi-zone/fractal-type-ir/from-cql
//
// Cassandra CQL DDL (`CREATE TABLE ...` / `CREATE TYPE ...`) -> TypeRef.
// Sibling to from-sql.ts (SQL DDL -> TypeRef) — CQL's surface is SQL-*like*
// but its own grammar (no JOINs/CHECK/FOREIGN KEY, but partition/clustering
// keys, collection types, UDTs, `frozen<...>`, and `WITH` table options that
// SQL doesn't have), so this is an independent hand-rolled parser rather
// than a variant of from-sql.ts's — the two modules don't share code, matching
// this package's per-ingester independence convention (see from-sql.ts,
// from-protobuf.ts, from-capnp.ts, none of which import from one another).
//
// Column type mapping mirrors from-sql.ts's own leaf-kind convention (use a
// dedicated IR kind where one exists, fall back to `meta` otherwise):
//   text/varchar/ascii      -> string
//   int                     -> int32
//   bigint/counter          -> int64
//   smallint                -> int16
//   tinyint                 -> int8
//   varint                  -> integer (arbitrary precision; no dedicated
//                              "bigint-of-unbounded-width" kind exists, so it
//                              falls back to the width-less `integer` parent)
//   float                   -> float32
//   double                  -> float64
//   decimal                 -> number (meta.cqlType: "decimal", arbitrary
//                              precision; no dedicated decimal kind exists)
//   boolean                 -> boolean
//   blob                    -> bytes
//   timestamp               -> datetime
//   date                    -> date
//   time                    -> time
//   duration                -> duration
//   uuid/timeuuid           -> uuid (dedicated kind, itself a `string`
//                              subtype) + meta.cqlType so a round trip can
//                              tell timeuuid apart from uuid
//   inet                    -> string + meta.format: "inet" (CQL has exactly
//                              one network-address type — it does not
//                              distinguish IPv4 from IPv6 at the DDL level,
//                              so there is no source signal to pick either
//                              "ipv4" or "ipv6" specifically over the other)
//   list<T>                 -> array(T)
//   set<T>                  -> array(T) + meta.set: true
//   map<K, V>                -> map(K, V)
//   tuple<T1, T2, ...>       -> tuple([T1, T2, ...])
//   frozen<T>                -> T + meta.frozen: true (unwrapped — frozen is
//                              a storage/mutability modifier, not a distinct
//                              shape)
//   a bare name matching a CREATE TYPE UDT already seen (or not yet seen —
//   forward references are legal in CQL) -> ref(name)
//   counter                  -> int64 + meta.counter: true
//
// Table-level CQL concepts with no SQL analog are preserved as open `meta`
// conventions local to this module:
//   - meta.partitionKey: string[] — the partition-key column(s), in order
//     (always present; a table always has a partition key).
//   - meta.clusteringKey: string[] — the clustering-column(s), in order
//     (absent if the table has none).
//   - meta.primaryKey: string[] — partitionKey ++ clusteringKey, flattened,
//     mirroring from-sql.ts's own `meta.primaryKey` convention so a caller
//     that doesn't care about the partition/clustering distinction can still
//     find "the primary key" in the same place.
//   - meta.clusteringOrder: Record<string, "ASC" | "DESC"> — from a `WITH
//     CLUSTERING ORDER BY (...)` clause.
//   - meta.counterTable: boolean — every non-key column is a `counter`.
// A per-column `meta.partitionKey`/`meta.clusteringKey`/`meta.static`/
// `meta.counter` boolean is also set directly on that column's TypeRef,
// mirroring from-sql.ts's per-column `meta.primaryKey` boolean.

import { t, types, type TypeRef } from "./index.ts"
import { bytes, date, datetime, duration, time, uuid } from "./kinds/common.ts"

function withMeta(ref: TypeRef, extra: Record<string, unknown>): TypeRef {
  if (Object.keys(extra).length === 0) return ref
  return { shape: ref.shape, meta: { ...ref.meta, ...extra } }
}

// ============================================================================
// Depth-/quote-aware splitting — identical convention to from-sql.ts's
// splitTopLevel/extractBalancedParen (commas/semicolons inside `(...)`,
// `<...>` (CQL's collection-type angle brackets), or `'...'`/`"..."` string
// and quoted-identifier literals must not be treated as top-level splits).
// ============================================================================

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let angleDepth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
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
    if (c === "'" || c === '"') quote = c
    else if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "<") angleDepth++
    else if (c === ">") angleDepth = Math.max(0, angleDepth - 1)
    else if (c === sep && depth === 0 && angleDepth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function splitStatements(ddl: string): string[] {
  return splitTopLevel(ddl, ";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Extract the parenthesized text starting at `text[openIdx]` (must be `(`),
 * returning the inner text and how many characters (from the start of
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
    if (c === "'" || c === '"') quote = c
    else if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return { clause: text.slice(openIdx + 1, i), consumed: i + 1 }
    }
  }
  return { clause: text.slice(openIdx + 1), consumed: text.length }
}

function stripQuotes(name: string): string {
  const m = /^"([^"]+)"$/.exec(name.trim())
  return m !== null ? m[1]! : name.trim()
}

/** `[keyspace.]name` -> bare `name` (this module's map is keyed by
 * unqualified name, matching from-sql.ts's own convention for
 * `schema.table`-qualified SQL names). */
function unqualify(name: string): string {
  const parts = name.split(".")
  return stripQuotes(parts[parts.length - 1]!)
}

// ============================================================================
// CREATE TABLE / CREATE TYPE statement extraction
// ============================================================================

const CREATE_TABLE_RE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]+)"|[\w.]+)\s*\(/i
const CREATE_TYPE_RE = /^CREATE\s+TYPE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]+)"|[\w.]+)\s*\(/i

type ParsedStatement = { kind: "table" | "type"; name: string; body: string; withClause: string }

function parseCreateStatement(stmt: string): ParsedStatement | undefined {
  const trimmed = stmt.trim()
  const tableMatch = CREATE_TABLE_RE.exec(trimmed)
  const typeMatch = tableMatch === null ? CREATE_TYPE_RE.exec(trimmed) : null
  const match = tableMatch ?? typeMatch
  if (match === null) return undefined

  const name = unqualify(match[1]!)
  const openIdx = match[0].length - 1
  const { clause: body, consumed } = extractBalancedParen(trimmed, openIdx)
  const rest = trimmed.slice(consumed).trim()

  return { kind: tableMatch !== null ? "table" : "type", name, body, withClause: rest }
}

// ============================================================================
// Type-name -> TypeRef mapping
// ============================================================================

/** Parse a CQL type expression (`text`, `list<int>`, `frozen<map<text, int>>`,
 * `tuple<int, text>`, ...) into a type name and its angle-bracket type
 * arguments (top-level split on `,`, so nested `<...>` don't split early). */
function parseCqlTypeText(raw: string): { name: string; args: string[] } {
  const text = raw.trim()
  const angleIdx = text.indexOf("<")
  if (angleIdx < 0) return { name: text, args: [] }
  const name = text.slice(0, angleIdx).trim()
  const closeIdx = text.lastIndexOf(">")
  const inner = closeIdx > angleIdx ? text.slice(angleIdx + 1, closeIdx) : ""
  return { name, args: splitTopLevel(inner, ",").map((s) => s.trim()) }
}

/** CQL type expression -> TypeRef. `knownUdts` lets a bare name that matches
 * a UDT already declared elsewhere in the same DDL resolve to `ref(name)`
 * instead of falling through to the unrecognized-type fallback (CQL also
 * allows forward references to a UDT declared *later* in the same script —
 * those are unresolvable at parse time here and degrade to `ref(name)` on a
 * best-effort basis regardless, since a bare lowercase identifier that isn't
 * one of CQL's native type keywords has no other plausible reading). */
function mapCqlType(raw: string, knownUdts: Set<string>): TypeRef {
  const { name, args } = parseCqlTypeText(raw)
  const lower = name.toLowerCase()

  switch (lower) {
    case "text":
    case "varchar":
    case "ascii":
      return t(types.string)

    case "int":
      return t(types.integer, { cqlType: "int" })

    case "bigint":
      return t(types.integer, { cqlType: "bigint" })

    case "counter":
      return t(types.integer, { cqlType: "counter", counter: true })

    case "smallint":
      return t(types.integer, { cqlType: "smallint" })

    case "tinyint":
      return t(types.integer, { cqlType: "tinyint" })

    case "varint":
      return t(types.integer, { cqlType: "varint" })

    case "float":
      return t(types.number, { cqlType: "float" })

    case "double":
      return t(types.number, { cqlType: "double" })

    case "decimal":
      return t(types.number, { cqlType: "decimal" })

    case "boolean":
      return t(types.boolean)

    case "blob":
      return bytes()

    case "timestamp":
      return datetime()

    case "date":
      return date()

    case "time":
      return time()

    case "duration":
      return duration()

    case "uuid":
      return withMeta(uuid(), { cqlType: "uuid" })

    case "timeuuid":
      return withMeta(uuid(), { cqlType: "timeuuid" })

    case "inet":
      return t(types.string, { format: "inet" })

    case "list": {
      const element = args[0] !== undefined ? mapCqlType(args[0], knownUdts) : t(types.unknown)
      return t(types.array(element))
    }

    case "set": {
      const element = args[0] !== undefined ? mapCqlType(args[0], knownUdts) : t(types.unknown)
      return withMeta(t(types.array(element)), { set: true })
    }

    case "map": {
      const key = args[0] !== undefined ? mapCqlType(args[0], knownUdts) : t(types.unknown)
      const value = args[1] !== undefined ? mapCqlType(args[1], knownUdts) : t(types.unknown)
      return t(types.map(key, value))
    }

    case "tuple": {
      const elements = args.map((a) => mapCqlType(a, knownUdts))
      return t(types.tuple(elements))
    }

    case "frozen": {
      const inner = args[0] !== undefined ? mapCqlType(args[0], knownUdts) : t(types.unknown)
      return withMeta(inner, { frozen: true })
    }

    default:
      // Bare identifier not one of CQL's native keywords: a UDT reference
      // (known or forward-declared — see doc comment above).
      if (/^[A-Za-z_]\w*$/.test(name)) return t(types.ref(name))
      return t(types.unknown, { cqlType: name })
  }
}

// ============================================================================
// CREATE TABLE body parsing
// ============================================================================

type ColumnInfo = { name: string; ref: TypeRef; static: boolean }

type TableInfo = {
  columns: ColumnInfo[]
  partitionKey: string[]
  clusteringKey: string[]
}

const STATIC_RE = /\bSTATIC\b/i
const PRIMARY_KEY_INLINE_RE = /\bPRIMARY\s+KEY\b/i

/** Parse `PRIMARY KEY (...)`'s inner clause into partition-key + clustering-
 * key column lists. The first element is either a single column name (a
 * simple, single-column partition key) or a parenthesized group (a
 * composite partition key); every element after it is a clustering column,
 * in declared order. */
function parsePrimaryKeyClause(inner: string): { partitionKey: string[]; clusteringKey: string[] } {
  const parts = splitTopLevel(inner, ",").map((s) => s.trim())
  if (parts.length === 0) return { partitionKey: [], clusteringKey: [] }

  const first = parts[0]!
  if (first.startsWith("(")) {
    const { clause } = extractBalancedParen(first, 0)
    const partitionKey = splitTopLevel(clause, ",").map((s) => stripQuotes(s.trim()))
    const clusteringKey = parts.slice(1).map((s) => stripQuotes(s.trim()))
    return { partitionKey, clusteringKey }
  }

  return {
    partitionKey: [stripQuotes(first)],
    clusteringKey: parts.slice(1).map((s) => stripQuotes(s.trim())),
  }
}

function parseColumnDef(item: string, knownUdts: Set<string>): { column: ColumnInfo; inlinePrimaryKey: boolean } | undefined {
  const nameMatch = /^(?:"([^"]+)"|(\S+))\s+([\s\S]+)$/.exec(item.trim())
  if (nameMatch === null) return undefined
  const name = nameMatch[1] ?? nameMatch[2]!
  let rest = nameMatch[3]!.trim()

  const isStatic = STATIC_RE.test(rest)
  rest = rest.replace(STATIC_RE, "").trim()

  const inlinePk = PRIMARY_KEY_INLINE_RE.test(rest)
  rest = rest.replace(PRIMARY_KEY_INLINE_RE, "").trim()

  const ref = mapCqlType(rest, knownUdts)

  return {
    column: { name: stripQuotes(name), ref, static: isStatic },
    inlinePrimaryKey: inlinePk,
  }
}

function parseTableBody(body: string, knownUdts: Set<string>): TableInfo {
  const table: TableInfo = { columns: [], partitionKey: [], clusteringKey: [] }

  for (const item of splitTopLevel(body, ",")) {
    const trimmed = item.trim()
    if (trimmed.length === 0) continue

    if (/^PRIMARY\s+KEY\b/i.exec(trimmed) !== null) {
      const openIdx = trimmed.indexOf("(")
      if (openIdx >= 0) {
        const { clause } = extractBalancedParen(trimmed, openIdx)
        const { partitionKey, clusteringKey } = parsePrimaryKeyClause(clause)
        table.partitionKey.push(...partitionKey)
        table.clusteringKey.push(...clusteringKey)
      }
      continue
    }

    const parsed = parseColumnDef(trimmed, knownUdts)
    if (parsed === undefined) continue
    table.columns.push(parsed.column)
    if (parsed.inlinePrimaryKey) table.partitionKey.push(parsed.column.name)
  }

  return table
}

// ============================================================================
// CREATE TYPE (UDT) body parsing — a flat field list, no keys/collections of
// constraints beyond the column type itself.
// ============================================================================

function parseUdtBody(body: string, knownUdts: Set<string>): Record<string, TypeRef> {
  const fields: Record<string, TypeRef> = {}
  for (const item of splitTopLevel(body, ",")) {
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    const nameMatch = /^(?:"([^"]+)"|(\S+))\s+([\s\S]+)$/.exec(trimmed)
    if (nameMatch === null) continue
    const name = stripQuotes(nameMatch[1] ?? nameMatch[2]!)
    fields[name] = mapCqlType(nameMatch[3]!.trim(), knownUdts)
  }
  return fields
}

// ============================================================================
// WITH clause parsing — only CLUSTERING ORDER BY is given structured
// treatment; every other WITH option (compaction, comment, gc_grace_seconds,
// ...) carries no TypeRef-relevant information and is discarded, matching
// from-sql.ts's own convention for dialect-specific table options
// (`ENGINE=InnoDB`, `WITHOUT ROWID`) after the closing paren.
// ============================================================================

function parseClusteringOrder(withClause: string): Record<string, "ASC" | "DESC"> | undefined {
  const m = /CLUSTERING\s+ORDER\s+BY\s*\(([^)]*)\)/i.exec(withClause)
  if (m === null) return undefined
  const order: Record<string, "ASC" | "DESC"> = {}
  for (const part of splitTopLevel(m[1]!, ",")) {
    const colMatch = /^\s*(?:"([^"]+)"|(\S+))\s+(ASC|DESC)\s*$/i.exec(part)
    if (colMatch === null) continue
    const col = stripQuotes(colMatch[1] ?? colMatch[2]!)
    order[col] = colMatch[3]!.toUpperCase() as "ASC" | "DESC"
  }
  return Object.keys(order).length > 0 ? order : undefined
}

// ============================================================================
// Public entry point
// ============================================================================

/**
 * Convert one or more CQL `CREATE TABLE`/`CREATE TYPE` DDL statements into a
 * map of table/type name -> `TypeRef` (each an `object` type with one field
 * per column). Multiple statements in one string produce multiple map
 * entries; a `CREATE TABLE`'s columns may `ref()` a UDT declared by an
 * earlier *or later* `CREATE TYPE` statement in the same string (CQL allows
 * forward references). Statements this ingester doesn't recognize (`CREATE
 * KEYSPACE`, `CREATE INDEX`, `ALTER TABLE`, ...) are silently skipped,
 * matching this package's other ingesters' honest-degrade convention for
 * input outside their scope.
 */
export function fromCql(ddl: string): Record<string, TypeRef> {
  const statements = splitStatements(ddl)
    .map(parseCreateStatement)
    .filter((s): s is ParsedStatement => s !== undefined)

  const knownUdts = new Set(statements.filter((s) => s.kind === "type").map((s) => s.name))

  const result: Record<string, TypeRef> = {}

  for (const stmt of statements) {
    if (stmt.kind === "type") {
      const fields = parseUdtBody(stmt.body, knownUdts)
      result[stmt.name] = t(types.object(fields))
      continue
    }

    const table = parseTableBody(stmt.body, knownUdts)

    const partitionSet = new Set(table.partitionKey)
    const clusteringSet = new Set(table.clusteringKey)
    const isCounterTable = table.columns.some((c) => c.ref.meta.counter === true)

    const fields: Record<string, TypeRef> = {}
    for (const col of table.columns) {
      const meta: Record<string, unknown> = {}
      if (partitionSet.has(col.name)) meta.partitionKey = true
      if (clusteringSet.has(col.name)) meta.clusteringKey = true
      if (col.static) meta.static = true
      fields[col.name] = withMeta(col.ref, meta)
    }

    const tableMeta: Record<string, unknown> = {
      partitionKey: table.partitionKey,
      primaryKey: [...table.partitionKey, ...table.clusteringKey],
    }
    if (table.clusteringKey.length > 0) tableMeta.clusteringKey = table.clusteringKey
    if (isCounterTable) tableMeta.counterTable = true

    const clusteringOrder = parseClusteringOrder(stmt.withClause)
    if (clusteringOrder !== undefined) tableMeta.clusteringOrder = clusteringOrder

    result[stmt.name] = t(types.object(fields), tableMeta)
  }

  return result
}
