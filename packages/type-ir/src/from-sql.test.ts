import { describe, expect, test } from "bun:test"
import { fromSql } from "./from-sql.ts"
import { toCreateTable } from "./sql.ts"
import { bytes, date, datetime, uuid } from "./kinds/common.ts"

describe("basic column types", () => {
  test("varchar/text -> string", () => {
    const result = fromSql("CREATE TABLE t (a VARCHAR(50), b TEXT);")
    expect(result.t?.shape.kind).toBe("object")
    const fields = (result.t?.shape as { fields: Record<string, unknown> }).fields
    expect((fields.a as { shape: { kind: string } }).shape.kind).toBe("string")
    expect((fields.a as { meta: Record<string, unknown> }).meta.maxLength).toBe(50)
    expect((fields.b as { shape: { kind: string } }).shape.kind).toBe("string")
  })

  test("integer/int/bigint -> integer", () => {
    const result = fromSql("CREATE TABLE t (a INTEGER, b INT, c BIGINT);")
    const fields = (result.t?.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.a?.shape.kind).toBe("integer")
    expect(fields.b?.shape.kind).toBe("integer")
    expect(fields.c?.shape.kind).toBe("integer")
  })

  test("float/double/real/decimal -> number", () => {
    const result = fromSql("CREATE TABLE t (a FLOAT, b DOUBLE PRECISION, c REAL, d DECIMAL(10,2));")
    const fields = (result.t?.shape as { fields: Record<string, { shape: { kind: string }; meta: Record<string, unknown> }> }).fields
    expect(fields.a?.shape.kind).toBe("number")
    expect(fields.b?.shape.kind).toBe("number")
    expect(fields.c?.shape.kind).toBe("number")
    expect(fields.d?.shape.kind).toBe("number")
    expect(fields.d?.meta.precision).toBe(10)
    expect(fields.d?.meta.scale).toBe(2)
  })

  test("boolean/bool -> boolean", () => {
    const result = fromSql("CREATE TABLE t (a BOOLEAN, b BOOL);")
    const fields = (result.t?.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.a?.shape.kind).toBe("boolean")
    expect(fields.b?.shape.kind).toBe("boolean")
  })

  test("date -> date kind", () => {
    const result = fromSql("CREATE TABLE t (a DATE);")
    const fields = (result.t?.shape as { fields: Record<string, unknown> }).fields
    expect(fields.a).toEqual(date({ nullable: true }))
  })

  test("timestamp/datetime -> datetime kind", () => {
    const result = fromSql("CREATE TABLE t (a TIMESTAMP, b DATETIME);")
    const fields = (result.t?.shape as { fields: Record<string, unknown> }).fields
    expect(fields.a).toEqual(datetime({ nullable: true }))
    expect(fields.b).toEqual(datetime({ nullable: true }))
  })

  test("json/jsonb -> unknown", () => {
    const result = fromSql("CREATE TABLE t (a JSON, b JSONB);")
    const fields = (result.t?.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.a?.shape.kind).toBe("unknown")
    expect(fields.b?.shape.kind).toBe("unknown")
  })

  test("uuid -> uuid kind", () => {
    const result = fromSql("CREATE TABLE t (a UUID);")
    const fields = (result.t?.shape as { fields: Record<string, unknown> }).fields
    expect(fields.a).toEqual(uuid({ nullable: true }))
  })

  test("blob/bytea -> bytes kind", () => {
    const result = fromSql("CREATE TABLE t (a BLOB, b BYTEA);")
    const fields = (result.t?.shape as { fields: unknown }).fields as Record<string, unknown>
    expect(fields.a).toEqual(bytes({ nullable: true }))
    expect(fields.b).toEqual(bytes({ nullable: true }))
  })

  test("serial/bigserial -> integer with autoincrement meta", () => {
    const result = fromSql("CREATE TABLE t (a SERIAL, b BIGSERIAL);")
    const fields = (result.t?.shape as { fields: Record<string, { shape: { kind: string }; meta: Record<string, unknown> }> }).fields
    expect(fields.a?.shape.kind).toBe("integer")
    expect(fields.a?.meta.autoincrement).toBe(true)
    expect(fields.b?.shape.kind).toBe("integer")
    expect(fields.b?.meta.autoincrement).toBe(true)
  })

  test("enum -> enum kind", () => {
    const result = fromSql("CREATE TABLE t (status ENUM('active', 'inactive'));")
    const fields = (result.t?.shape as { fields: Record<string, { shape: { kind: string; members?: readonly string[] } }> }).fields
    expect(fields.status?.shape.kind).toBe("enum")
    expect(fields.status?.shape.members).toEqual(["active", "inactive"])
  })
})

describe("nullability", () => {
  test("column without NOT NULL is nullable", () => {
    const result = fromSql("CREATE TABLE t (a TEXT);")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.a?.meta.nullable).toBe(true)
  })

  test("NOT NULL column is not nullable", () => {
    const result = fromSql("CREATE TABLE t (a TEXT NOT NULL);")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.a?.meta.nullable).toBeUndefined()
  })
})

describe("primary key", () => {
  test("inline PRIMARY KEY", () => {
    const result = fromSql("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.id?.meta.primaryKey).toBe(true)
    expect(fields.id?.meta.nullable).toBeUndefined()
    expect(result.t?.meta.primaryKey).toEqual(["id"])
  })

  test("table-level PRIMARY KEY", () => {
    const result = fromSql("CREATE TABLE t (id INTEGER, name TEXT, PRIMARY KEY (id));")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.id?.meta.primaryKey).toBe(true)
    expect(result.t?.meta.primaryKey).toEqual(["id"])
  })

  test("composite table-level PRIMARY KEY", () => {
    const result = fromSql("CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b));")
    expect(result.t?.meta.primaryKey).toEqual(["a", "b"])
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.a?.meta.primaryKey).toBe(true)
    expect(fields.b?.meta.primaryKey).toBe(true)
  })
})

describe("default values", () => {
  test("string default", () => {
    const result = fromSql("CREATE TABLE t (status TEXT DEFAULT 'pending');")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.status?.meta.default).toBe("pending")
  })

  test("numeric default", () => {
    const result = fromSql("CREATE TABLE t (count INTEGER DEFAULT 0);")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.count?.meta.default).toBe(0)
  })

  test("boolean default", () => {
    const result = fromSql("CREATE TABLE t (active BOOLEAN DEFAULT TRUE);")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.active?.meta.default).toBe(true)
  })

  test("expression default preserved verbatim", () => {
    const result = fromSql("CREATE TABLE t (created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, id UUID DEFAULT gen_random_uuid());")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.created_at?.meta.default).toBe("CURRENT_TIMESTAMP")
    expect(fields.id?.meta.default).toBe("gen_random_uuid()")
  })

  test("default followed by another constraint is bounded correctly", () => {
    const result = fromSql("CREATE TABLE t (count INTEGER DEFAULT 0 NOT NULL, name TEXT DEFAULT 'x' UNIQUE);")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.count?.meta.default).toBe(0)
    expect(fields.count?.meta.nullable).toBeUndefined()
    expect(fields.name?.meta.default).toBe("x")
    expect(fields.name?.meta.unique).toBe(true)
  })
})

describe("foreign keys", () => {
  test("inline REFERENCES", () => {
    const result = fromSql("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));")
    const fields = (result.orders?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.user_id?.meta.references).toEqual({ table: "users", column: "id" })
  })

  test("table-level FOREIGN KEY", () => {
    const result = fromSql(
      "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, FOREIGN KEY (user_id) REFERENCES users (id));",
    )
    const fields = (result.orders?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.user_id?.meta.references).toEqual({ table: "users", column: "id" })
  })
})

describe("check constraints", () => {
  test("numeric range check parses into structured meta", () => {
    const result = fromSql("CREATE TABLE t (age INTEGER CHECK (age >= 0));")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.age?.meta.minimum).toBe(0)
  })

  test("length check parses into structured meta", () => {
    const result = fromSql("CREATE TABLE t (name TEXT CHECK (LENGTH(name) <= 50));")
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.name?.meta.maxLength).toBe(50)
  })

  test("unrecognized check clause preserved as raw text", () => {
    const result = fromSql("CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a + b < 100));")
    expect(result.t?.meta.checks).toEqual(["CHECK (a + b < 100)"])
  })
})

describe("postgres-specific types", () => {
  test("serial primary key + jsonb + uuid + text array", () => {
    const result = fromSql(
      `CREATE TABLE events (
        id SERIAL PRIMARY KEY,
        payload JSONB,
        correlation_id UUID,
        tags TEXT[]
      );`,
      { dialect: "postgres" },
    )
    const fields = (result.events?.shape as { fields: Record<string, { shape: { kind: string; element?: { shape: { kind: string } } } }> })
      .fields
    expect(fields.id?.shape.kind).toBe("integer")
    expect(fields.payload?.shape.kind).toBe("unknown")
    expect(fields.correlation_id?.shape.kind).toBe("uuid")
    expect(fields.tags?.shape.kind).toBe("array")
    expect(fields.tags?.shape.element?.shape.kind).toBe("string")
  })
})

describe("mysql-specific types", () => {
  test("tinyint, mediumtext, auto_increment", () => {
    const result = fromSql(
      `CREATE TABLE items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        flag TINYINT(1),
        small_num TINYINT,
        description MEDIUMTEXT
      );`,
      { dialect: "mysql" },
    )
    const fields = (result.items?.shape as { fields: Record<string, { shape: { kind: string }; meta: Record<string, unknown> }> }).fields
    expect(fields.id?.meta.autoincrement).toBe(true)
    expect(fields.flag?.shape.kind).toBe("boolean")
    expect(fields.small_num?.shape.kind).toBe("integer")
    expect(fields.description?.shape.kind).toBe("string")
  })
})

describe("sqlite flexible typing", () => {
  test("unknown/custom type names use affinity rules", () => {
    const result = fromSql(
      `CREATE TABLE t (
        a MYINTTYPE,
        b MYCHARTYPE,
        c MYBLOBBY,
        d MYFLOATY,
        e SOMETHINGELSE
      );`,
      { dialect: "sqlite" },
    )
    const fields = (result.t?.shape as { fields: Record<string, { shape: { kind: string } }> }).fields
    expect(fields.a?.shape.kind).toBe("integer")
    expect(fields.b?.shape.kind).toBe("string")
    expect(fields.c?.shape.kind).toBe("unknown")
    expect(fields.d?.shape.kind).toBe("number")
    expect(fields.e?.shape.kind).toBe("number")
  })

  test("INTEGER PRIMARY KEY AUTOINCREMENT", () => {
    const result = fromSql("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);", { dialect: "sqlite" })
    const fields = (result.t?.shape as { fields: Record<string, { meta: Record<string, unknown> }> }).fields
    expect(fields.id?.meta.autoincrement).toBe(true)
    expect(fields.id?.meta.primaryKey).toBe(true)
  })
})

describe("multiple tables", () => {
  test("multiple CREATE TABLE statements produce multiple entries", () => {
    const result = fromSql(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), title TEXT);
    `)
    expect(Object.keys(result).sort()).toEqual(["posts", "users"])
    const userFields = (result.users?.shape as { fields: Record<string, unknown> }).fields
    expect(Object.keys(userFields)).toEqual(["id", "name"])
    const postFields = (result.posts?.shape as { fields: Record<string, unknown> }).fields
    expect(Object.keys(postFields)).toEqual(["id", "user_id", "title"])
  })
})

describe("round-trip against sql.ts", () => {
  test("basic table round-trips through toCreateTable", () => {
    const result = fromSql("CREATE TABLE t (name TEXT NOT NULL, age INTEGER NOT NULL, active BOOLEAN NOT NULL);")
    const ref = result.t!
    const ddl = toCreateTable("t", ref, { dialect: "postgres" })
    expect(ddl).toContain("name TEXT NOT NULL")
    expect(ddl).toContain("age INTEGER NOT NULL")
    expect(ddl).toContain("active BOOLEAN NOT NULL")
  })

  test("uuid/datetime/date round-trip to their dedicated SQL types", () => {
    const result = fromSql("CREATE TABLE t (id UUID NOT NULL, created_at TIMESTAMP NOT NULL, day DATE NOT NULL);")
    const ddl = toCreateTable("t", result.t!, { dialect: "postgres" })
    expect(ddl).toContain("id UUID NOT NULL")
    expect(ddl).toContain("created_at TIMESTAMPTZ NOT NULL")
    expect(ddl).toContain("day DATE NOT NULL")
  })

  test("check constraint round-trips to an equivalent CHECK clause", () => {
    const result = fromSql("CREATE TABLE t (age INTEGER NOT NULL CHECK (age >= 0));")
    const ddl = toCreateTable("t", result.t!, { dialect: "postgres" })
    expect(ddl).toContain("CHECK (age >= 0)")
  })

  test("nullable column round-trips without NOT NULL", () => {
    const result = fromSql("CREATE TABLE t (nickname TEXT);")
    const ddl = toCreateTable("t", result.t!, { dialect: "postgres" })
    expect(ddl).toContain("nickname TEXT")
    expect(ddl).not.toContain("nickname TEXT NOT NULL")
  })
})
