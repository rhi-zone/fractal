# Wire formats

Each of these has its own distinct output shape — proto/capnp/flatbuffers
schema text, SQL DDL text, GraphQL SDL text, or a JSON-RPC method descriptor
object — shown as-is below. All examples render the same shape:

```ts
import { t, types } from "@rhi-zone/fractal-type-ir"

const user = t(types.object({
  id: t(types.integer),
  name: t(types.string),
  email: t(types.string),
  age: { shape: types.integer, meta: { optional: true } },
}))
```

## Protobuf

```ts
import { toProtoMessage, renderProto } from "@rhi-zone/fractal-type-ir/protobuf"

const msg = toProtoMessage("User", user)
renderProto([msg])
```

```proto
syntax = "proto3";

message User {
  int64 id = 1;
  string name = 2;
  string email = 3;
  optional int64 age = 4;
}
```

`toProtoField`/`toProtoService` are the field-level and service-level
siblings (an `interface` TypeRef → a proto3 `service` with RPC methods).
`toProtoUnionMessage` handles a `union`-rooted TypeRef specially: proto3 has
no first-class union type, so it synthesizes a wrapper message holding one
`oneof` field per variant instead of throwing (unlike most struct-shaped
projectors — capnp, flatbuffers, SQL — which require an `object` root).

## Cap'n Proto

```ts
import { toCapnpStruct, renderCapnp } from "@rhi-zone/fractal-type-ir/capnp"

const cs = toCapnpStruct("User", user)
renderCapnp([cs])
```

```
# @0x... (assign a unique ID)

struct User {
  id @0 :Int64;
  name @1 :Text;
  email @2 :Text;
  age @3 :Int64;
}
```

`toCapnpType` renders a bare field-position type string; `toCapnpInterface`
handles `interface` TypeRefs (Cap'n Proto's own `interface` construct, method
surfaces). A purely-nominal `instance` (or `function`/`method`) has no
structural Cap'n Proto equivalent — it degrades to `AnyPointer` rather than
fabricating a struct.

## FlatBuffers

```ts
import { toFlatBuffersTable } from "@rhi-zone/fractal-type-ir/flatbuffers"

toFlatBuffersTable("User", user)
```

```
table User {
  id:int;
  name:string (required);
  email:string (required);
  age:int;
}
```

`toFlatBuffers`/`toFlatBuffersService` are the bare-type and service-level
siblings; `toFlatBuffersDeclarations`/`renderFlatBuffers` assemble a full
`.fbs` file (tables + enums + unions + root type) from a name→`TypeRef`
registry.

## SQL DDL

```ts
import { toCreateTable } from "@rhi-zone/fractal-type-ir/sql"

toCreateTable("users", user)
```

```sql
CREATE TABLE users (
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  age INTEGER NOT NULL
);
```

Dialect defaults to Postgres (`toSqlDdl`/`toCreateTable` take `opts?.dialect:
"postgres" | "sqlite" | "mysql"`); type mapping, `CHECK` constraints (from
`meta.minimum`/`maximum`/`minLength`/`pattern`/`multipleOf`, …), and comment
syntax (native `COMMENT` for MySQL, block comment otherwise) all vary by
dialect. A `union`-rooted TypeRef needs a layout strategy to become tables:
`singleTableInheritanceSqlLayout()` (one table, nullable columns per variant
+ a discriminator column) or `tablePerVariantSqlLayout()` (one table per
variant) — passed as `opts.unionLayout`.

## SQL DDL (MSSQL)

```ts
import { toMssqlCreateTableFromRef } from "@rhi-zone/fractal-type-ir/sql-mssql"

toMssqlCreateTableFromRef("users", user)
```

```sql
CREATE TABLE users (
  id INT NOT NULL,
  name NVARCHAR(255) NOT NULL,
  email NVARCHAR(255) NOT NULL,
  age INT NOT NULL
);
```

The T-SQL dialect variant of `sql.ts` — its own type table (`toMssqlType`),
not one of `sql.ts`'s three `SqlDialect` options. Differs in the expected
T-SQL ways: `NVARCHAR(255)`/`NVARCHAR(MAX)` instead of `TEXT`/`VARCHAR`,
`UNIQUEIDENTIFIER` for uuid, `DATETIME2` for datetime, `BIT` for boolean.
Same union-layout split as `sql.ts`: `singleTableInheritanceMssqlLayout()` /
`tablePerVariantMssqlLayout()`.

## GraphQL SDL

```ts
import { toGraphQLType } from "@rhi-zone/fractal-type-ir/graphql"

toGraphQLType("User", user)
```

```graphql
type User {
  id: Int!
  name: String!
  email: String!
  age: Int
}
```

Type-level only — SDL type definitions (scalar mappings, object/enum/union/
interface declarations), not a full API projector with resolvers or
Query/Mutation/Subscription wiring. `toGraphQLTypes(registry)` renders a whole
name→`TypeRef` registry, one declaration per entry, joined with blank lines.
A leaf/scalar kind asked for a named declaration (no native GraphQL named-type
construct of its own) degrades to a `scalar Name` placeholder rather than a
fabricated shape.

## JSON-RPC

```ts
import { toJsonRpcMethod } from "@rhi-zone/fractal-type-ir/json-rpc"

const getUser = t(types.method(
  [{ name: "id", type: t(types.integer) }],
  user,
))
toJsonRpcMethod("getUser", getUser)
```

```json
{
  "name": "getUser",
  "paramsSchema": {
    "type": "object",
    "properties": { "id": { "type": "integer" } },
    "required": ["id"]
  },
  "resultSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "integer" },
      "name": { "type": "string" },
      "email": { "type": "string" },
      "age": { "type": "integer" }
    },
    "required": ["id", "name", "email"]
  },
  "errorSchema": {
    "type": "object",
    "properties": {
      "code": { "type": "integer" },
      "message": { "type": "string" },
      "data": {}
    },
    "required": ["code", "message"]
  }
}
```

A method descriptor object, not code — params always render as a by-name
object schema (JSON-RPC 2.0 §4 also permits positional arrays, but an object
schema documents each param individually). `errorSchema` is the standard
`code`/`message`/`data` envelope (§5.1); a method's `meta.errorType` TypeRef,
if present, becomes `data`'s schema. `toJsonRpcMethods(ref)` lowers a whole
`interface` TypeRef to one descriptor per method. The module also exports the
JSON-RPC 2.0 reserved error codes as constants — `JSON_RPC_PARSE_ERROR`,
`JSON_RPC_INVALID_REQUEST`, `JSON_RPC_METHOD_NOT_FOUND`,
`JSON_RPC_INVALID_PARAMS`, `JSON_RPC_INTERNAL_ERROR`,
`JSON_RPC_SERVER_ERROR_MIN`/`MAX` — plus `jsonRpcErrorSchema(dataSchema?)` to
build the envelope directly.
