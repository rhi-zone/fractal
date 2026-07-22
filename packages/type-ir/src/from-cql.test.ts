import { describe, expect, test } from "bun:test"
import { fromCql } from "./from-cql.ts"

type Obj = { shape: { kind: string; fields: Record<string, { shape: { kind: string; [k: string]: unknown }; meta: Record<string, unknown> }> }; meta: Record<string, unknown> }

function fieldsOf(ref: unknown): Record<string, { shape: { kind: string; [k: string]: unknown }; meta: Record<string, unknown> }> {
  return (ref as Obj).shape.fields
}

describe("basic column types", () => {
  test("text/varchar/ascii -> string", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a text, b varchar, c ascii);")
    const fields = fieldsOf(result.t)
    expect(fields.a?.shape.kind).toBe("string")
    expect(fields.b?.shape.kind).toBe("string")
    expect(fields.c?.shape.kind).toBe("string")
  })

  test("int -> integer (int32)", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a int);")
    const fields = fieldsOf(result.t)
    expect(fields.a?.shape.kind).toBe("integer")
    expect(fields.a?.meta.cqlType).toBe("int")
  })

  test("bigint -> integer (int64)", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a bigint);")
    const fields = fieldsOf(result.t)
    expect(fields.a?.shape.kind).toBe("integer")
    expect(fields.a?.meta.cqlType).toBe("bigint")
  })

  test("smallint/tinyint -> integer with width meta", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a smallint, b tinyint);")
    const fields = fieldsOf(result.t)
    expect(fields.a?.shape.kind).toBe("integer")
    expect(fields.a?.meta.cqlType).toBe("smallint")
    expect(fields.b?.shape.kind).toBe("integer")
    expect(fields.b?.meta.cqlType).toBe("tinyint")
  })

  test("varint -> integer", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a varint);")
    expect(fieldsOf(result.t).a?.shape.kind).toBe("integer")
  })

  test("float -> number (float32)", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a float);")
    const fields = fieldsOf(result.t)
    expect(fields.a?.shape.kind).toBe("number")
    expect(fields.a?.meta.cqlType).toBe("float")
  })

  test("double -> number (float64)", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a double);")
    const fields = fieldsOf(result.t)
    expect(fields.a?.shape.kind).toBe("number")
    expect(fields.a?.meta.cqlType).toBe("double")
  })

  test("decimal -> number", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a decimal);")
    expect(fieldsOf(result.t).a?.shape.kind).toBe("number")
  })

  test("boolean -> boolean", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a boolean);")
    expect(fieldsOf(result.t).a?.shape.kind).toBe("boolean")
  })

  test("blob -> bytes", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a blob);")
    expect(fieldsOf(result.t).a?.shape.kind).toBe("bytes")
  })

  test("timestamp -> datetime", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a timestamp);")
    expect(fieldsOf(result.t).a?.shape.kind).toBe("datetime")
  })

  test("date -> date", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a date);")
    expect(fieldsOf(result.t).a?.shape.kind).toBe("date")
  })

  test("time -> time", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a time);")
    expect(fieldsOf(result.t).a?.shape.kind).toBe("time")
  })

  test("duration -> duration", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a duration);")
    expect(fieldsOf(result.t).a?.shape.kind).toBe("duration")
  })

  test("uuid/timeuuid -> uuid kind", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a uuid, b timeuuid);")
    const fields = fieldsOf(result.t)
    expect(fields.a?.shape.kind).toBe("uuid")
    expect(fields.a?.meta.cqlType).toBe("uuid")
    expect(fields.b?.shape.kind).toBe("uuid")
    expect(fields.b?.meta.cqlType).toBe("timeuuid")
  })

  test("inet -> string with format meta", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, a inet);")
    const fields = fieldsOf(result.t)
    expect(fields.a?.shape.kind).toBe("string")
    expect(fields.a?.meta.format).toBe("inet")
  })
})

describe("counter tables", () => {
  test("counter -> integer with counter meta, table flagged", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, hits counter);")
    const fields = fieldsOf(result.t)
    expect(fields.hits?.shape.kind).toBe("integer")
    expect(fields.hits?.meta.counter).toBe(true)
    expect((result.t as unknown as { meta: Record<string, unknown> }).meta.counterTable).toBe(true)
  })
})

describe("collections", () => {
  test("list<T> -> array", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, tags list<text>);")
    const fields = fieldsOf(result.t)
    expect(fields.tags?.shape.kind).toBe("array")
    expect((fields.tags?.shape as unknown as { element: { shape: { kind: string } } }).element.shape.kind).toBe("string")
  })

  test("set<T> -> array with set meta", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, tags set<text>);")
    const fields = fieldsOf(result.t)
    expect(fields.tags?.shape.kind).toBe("array")
    expect(fields.tags?.meta.set).toBe(true)
  })

  test("map<K, V> -> map", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, attrs map<text, int>);")
    const fields = fieldsOf(result.t)
    expect(fields.attrs?.shape.kind).toBe("map")
    const shape = fields.attrs?.shape as unknown as { key: { shape: { kind: string } }; value: { shape: { kind: string } } }
    expect(shape.key.shape.kind).toBe("string")
    expect(shape.value.shape.kind).toBe("integer")
  })

  test("frozen<list<T>> -> array with frozen meta", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, tags frozen<list<text>>);")
    const fields = fieldsOf(result.t)
    expect(fields.tags?.shape.kind).toBe("array")
    expect(fields.tags?.meta.frozen).toBe(true)
  })

  test("frozen<map<K,V>> -> map with frozen meta", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, attrs frozen<map<text, int>>);")
    const fields = fieldsOf(result.t)
    expect(fields.attrs?.shape.kind).toBe("map")
    expect(fields.attrs?.meta.frozen).toBe(true)
  })
})

describe("tuples", () => {
  test("tuple<T1, T2, ...> -> tuple", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, coord tuple<int, int, text>);")
    const fields = fieldsOf(result.t)
    expect(fields.coord?.shape.kind).toBe("tuple")
    const elements = (fields.coord?.shape as unknown as { elements: { shape: { kind: string } }[] }).elements
    expect(elements.map((e) => e.shape.kind)).toEqual(["integer", "integer", "string"])
  })
})

describe("user-defined types", () => {
  test("CREATE TYPE -> object TypeRef", () => {
    const result = fromCql("CREATE TYPE address (street text, city text, zip text);")
    expect(result.address?.shape.kind).toBe("object")
    const fields = fieldsOf(result.address)
    expect(fields.street?.shape.kind).toBe("string")
    expect(fields.city?.shape.kind).toBe("string")
  })

  test("table column referencing a UDT -> ref()", () => {
    const result = fromCql(`
      CREATE TYPE address (street text, city text);
      CREATE TABLE users (id uuid PRIMARY KEY, home frozen<address>);
    `)
    const fields = fieldsOf(result.users)
    expect(fields.home?.shape.kind).toBe("ref")
    expect((fields.home?.shape as unknown as { target: string }).target).toBe("address")
    expect(fields.home?.meta.frozen).toBe(true)
  })

  test("forward reference to a UDT declared later still resolves to ref()", () => {
    const result = fromCql(`
      CREATE TABLE users (id uuid PRIMARY KEY, home frozen<address>);
      CREATE TYPE address (street text, city text);
    `)
    const fields = fieldsOf(result.users)
    expect(fields.home?.shape.kind).toBe("ref")
    expect((fields.home?.shape as unknown as { target: string }).target).toBe("address")
  })
})

describe("primary keys", () => {
  test("inline single-column primary key", () => {
    const result = fromCql("CREATE TABLE t (id uuid PRIMARY KEY, name text);")
    const meta = (result.t as unknown as { meta: Record<string, unknown> }).meta
    expect(meta.partitionKey).toEqual(["id"])
    expect(meta.primaryKey).toEqual(["id"])
    expect(meta.clusteringKey).toBeUndefined()
    expect(fieldsOf(result.t).id?.meta.partitionKey).toBe(true)
  })

  test("composite primary key: single partition + clustering columns", () => {
    const result = fromCql(
      "CREATE TABLE events (user_id uuid, event_time timestamp, payload text, PRIMARY KEY (user_id, event_time));",
    )
    const meta = (result.events as unknown as { meta: Record<string, unknown> }).meta
    expect(meta.partitionKey).toEqual(["user_id"])
    expect(meta.clusteringKey).toEqual(["event_time"])
    expect(meta.primaryKey).toEqual(["user_id", "event_time"])
    const fields = fieldsOf(result.events)
    expect(fields.user_id?.meta.partitionKey).toBe(true)
    expect(fields.event_time?.meta.clusteringKey).toBe(true)
    expect(fields.payload?.meta.partitionKey).toBeUndefined()
  })

  test("composite partition key group + clustering columns", () => {
    const result = fromCql(
      "CREATE TABLE events (tenant_id uuid, user_id uuid, event_time timestamp, seq int, PRIMARY KEY ((tenant_id, user_id), event_time, seq));",
    )
    const meta = (result.events as unknown as { meta: Record<string, unknown> }).meta
    expect(meta.partitionKey).toEqual(["tenant_id", "user_id"])
    expect(meta.clusteringKey).toEqual(["event_time", "seq"])
    expect(meta.primaryKey).toEqual(["tenant_id", "user_id", "event_time", "seq"])
  })
})

describe("WITH CLUSTERING ORDER", () => {
  test("parses clustering order into meta", () => {
    const result = fromCql(
      "CREATE TABLE events (user_id uuid, event_time timestamp, PRIMARY KEY (user_id, event_time)) WITH CLUSTERING ORDER BY (event_time DESC);",
    )
    const meta = (result.events as unknown as { meta: Record<string, unknown> }).meta
    expect(meta.clusteringOrder).toEqual({ event_time: "DESC" })
  })

  test("multiple clustering columns with mixed order, plus other WITH options ignored", () => {
    const result = fromCql(
      "CREATE TABLE events (a uuid, b int, c int, PRIMARY KEY (a, b, c)) WITH CLUSTERING ORDER BY (b ASC, c DESC) AND comment = 'x';",
    )
    const meta = (result.events as unknown as { meta: Record<string, unknown> }).meta
    expect(meta.clusteringOrder).toEqual({ b: "ASC", c: "DESC" })
  })
})

describe("keyspace-qualified names", () => {
  test("keyspace.table -> unqualified name key", () => {
    const result = fromCql("CREATE TABLE myks.users (id uuid PRIMARY KEY, name text);")
    expect(result.users).toBeDefined()
    expect(fieldsOf(result.users).name?.shape.kind).toBe("string")
  })

  test("keyspace.type -> unqualified name key", () => {
    const result = fromCql("CREATE TYPE myks.address (street text);")
    expect(result.address).toBeDefined()
  })
})

describe("IF NOT EXISTS", () => {
  test("CREATE TABLE IF NOT EXISTS", () => {
    const result = fromCql("CREATE TABLE IF NOT EXISTS t (id uuid PRIMARY KEY, name text);")
    expect(result.t).toBeDefined()
  })

  test("CREATE TYPE IF NOT EXISTS", () => {
    const result = fromCql("CREATE TYPE IF NOT EXISTS address (street text);")
    expect(result.address).toBeDefined()
  })
})

describe("multiple statements", () => {
  test("multiple CREATE TABLE / CREATE TYPE statements in one DDL string", () => {
    const result = fromCql(`
      CREATE TYPE address (street text, city text);
      CREATE TABLE users (id uuid PRIMARY KEY, name text, home frozen<address>);
      CREATE TABLE posts (id uuid PRIMARY KEY, author_id uuid, body text);
    `)
    expect(Object.keys(result).sort()).toEqual(["address", "posts", "users"])
    expect(fieldsOf(result.posts).author_id?.shape.kind).toBe("uuid")
  })
})

describe("static columns", () => {
  test("STATIC column is flagged in meta", () => {
    const result = fromCql(
      "CREATE TABLE t (user_id uuid, seq int, note text STATIC, PRIMARY KEY (user_id, seq));",
    )
    const fields = fieldsOf(result.t)
    expect(fields.note?.meta.static).toBe(true)
    expect(fields.seq?.meta.static).toBeUndefined()
  })
})
