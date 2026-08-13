// Registry of every format the playground can read from and/or write to.
//
// `sample` is the placeholder shown in the input editor when a format is
// selected as the input side with an empty/first-load buffer — every input
// format's sample is a *string* (the exact text a user would type/paste),
// even for formats whose ingestor takes a parsed JS object (JSON-ish
// formats) — convert.ts is responsible for JSON.parse-ing those.
//
// `lang` picks the CodeMirror language extension (see Editor.tsx) from a
// small set covering common cases (json/js/python/sql/rust) rather than one
// package per target language — syntax highlighting here is a nicety, not
// the point of the tool (see CLAUDE.md: don't gold-plate).

export type LangHint = "json" | "js" | "python" | "sql" | "rust" | "plain";

export interface FormatSpec {
  readonly id: string;
  readonly label: string;
  readonly lang: LangHint;
  /** Placeholder/sample text shown when this format is picked for the input pane. */
  readonly sample?: string;
}

const jsonSchemaSample = `{
  "type": "object",
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "name": { "type": "string" },
    "age": { "type": "integer" },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["id", "name"]
}`;

const jsonSample = `{
  "id": "3f9a1e0a-6b8e-4c2a-9e3a-7a2b6a6b6a6b",
  "name": "Ada Lovelace",
  "age": 36,
  "tags": ["mathematician", "writer"]
}`;

const jsonCorpusSample = `[
  { "id": "1", "name": "Ada", "age": 36 },
  { "id": "2", "name": "Alan", "age": 41, "tags": ["logician"] }
]`;

const jtdSample = `{
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" },
    "age": { "type": "int32" },
    "tags": { "elements": { "type": "string" } }
  }
}`;

const graphqlSample = `type Person {
  id: ID!
  name: String!
  age: Int
  tags: [String!]!
}`;

const sqlSample = `CREATE TABLE person (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER,
  tags TEXT[]
);`;

const cqlSample = `CREATE TABLE person (
  id uuid PRIMARY KEY,
  name text,
  age int,
  tags list<text>
);`;

const elasticsearchSample = `{
  "properties": {
    "id": { "type": "keyword" },
    "name": { "type": "text" },
    "age": { "type": "integer" },
    "tags": { "type": "keyword" }
  }
}`;

const openapi30Sample = `{
  "type": "object",
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "name": { "type": "string" },
    "age": { "type": "integer" }
  },
  "required": ["id", "name"]
}`;

const openapi20Sample = openapi30Sample;

// fromStandardSchema expects a real `~standard`-shaped object at runtime, not
// arbitrary vendor code — the playground can't safely eval an arbitrary Zod/
// Valibot schema string in-browser. Simplification: accept a small JSON
// envelope naming the vendor plus either an embedded JSON Schema export (the
// StandardJSONSchemaV1 path) or a runtime sample value (the fromJson
// fallback path) — see convert.ts's standard-schema branch.
const standardSchemaSample = `{
  "vendor": "zod",
  "jsonSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "string" },
      "name": { "type": "string" }
    },
    "required": ["id", "name"]
  }
}`;

const capnpSample = `struct Person {
  id @0 :Text;
  name @1 :Text;
  age @2 :Int32;
  tags @3 :List(Text);
}`;

const flatbuffersSample = `table Person {
  id: string;
  name: string;
  age: int;
  tags: [string];
}`;

const flowSample = `export type User = {
  id: string,
  name: string,
  age?: number,
  tags: Array<string>,
}`;

const protobufSample = `syntax = "proto3";

message User {
  string id = 1;
  string name = 2;
  int32 age = 3;
  repeated string tags = 4;
}`;

export const inputFormats: readonly FormatSpec[] = [
  { id: "json-schema", label: "JSON Schema", lang: "json", sample: jsonSchemaSample },
  { id: "json", label: "JSON (instance)", lang: "json", sample: jsonSample },
  { id: "json-corpus", label: "JSON corpus", lang: "json", sample: jsonCorpusSample },
  { id: "jtd", label: "JSON Type Definition", lang: "json", sample: jtdSample },
  { id: "graphql", label: "GraphQL SDL", lang: "js", sample: graphqlSample },
  { id: "sql", label: "SQL DDL", lang: "sql", sample: sqlSample },
  { id: "cql", label: "Cassandra CQL", lang: "sql", sample: cqlSample },
  {
    id: "elasticsearch",
    label: "Elasticsearch mapping",
    lang: "json",
    sample: elasticsearchSample,
  },
  { id: "openapi30", label: "OpenAPI 3.0 schema", lang: "json", sample: openapi30Sample },
  { id: "openapi20", label: "OpenAPI/Swagger 2.0 schema", lang: "json", sample: openapi20Sample },
  {
    id: "standard-schema",
    label: "Standard Schema (JSON envelope)",
    lang: "json",
    sample: standardSchemaSample,
  },
  { id: "capnp", label: "Cap'n Proto schema", lang: "plain", sample: capnpSample },
  { id: "flatbuffers", label: "FlatBuffers schema", lang: "plain", sample: flatbuffersSample },
  { id: "flow", label: "Flow", lang: "js", sample: flowSample },
  { id: "protobuf", label: "Protocol Buffers", lang: "plain", sample: protobufSample },
];

export const outputFormats: readonly FormatSpec[] = [
  { id: "typescript", label: "TypeScript", lang: "js" },
  { id: "zod", label: "Zod", lang: "js" },
  { id: "typebox", label: "TypeBox", lang: "js" },
  { id: "io-ts", label: "io-ts", lang: "js" },
  { id: "yup", label: "Yup", lang: "js" },
  { id: "effect-schema", label: "Effect Schema", lang: "js" },
  { id: "valibot", label: "Valibot", lang: "js" },
  { id: "runtypes", label: "Runtypes", lang: "js" },
  { id: "superstruct", label: "Superstruct", lang: "js" },
  { id: "arktype", label: "ArkType", lang: "js" },
  { id: "jsdoc", label: "JSDoc", lang: "js" },
  { id: "python-dataclass", label: "Python (dataclass)", lang: "python" },
  { id: "python-pydantic", label: "Python (Pydantic)", lang: "python" },
  { id: "python-attrs", label: "Python (attrs)", lang: "python" },
  { id: "go", label: "Go (encoding/json)", lang: "plain" },
  { id: "java-jackson", label: "Java (Jackson)", lang: "plain" },
  { id: "java-gson", label: "Java (Gson)", lang: "plain" },
  { id: "java-moshi", label: "Java (Moshi)", lang: "plain" },
  { id: "rust", label: "Rust (serde)", lang: "rust" },
  { id: "swift", label: "Swift (Codable)", lang: "plain" },
  { id: "csharp-systemtextjson", label: "C# (System.Text.Json)", lang: "plain" },
  { id: "csharp-newtonsoft", label: "C# (Newtonsoft)", lang: "plain" },
  { id: "kotlin", label: "Kotlin (kotlinx)", lang: "plain" },
  { id: "dart-json-serializable", label: "Dart (json_serializable)", lang: "plain" },
  { id: "dart-freezed", label: "Dart (freezed)", lang: "plain" },
  { id: "objc", label: "Objective-C (Foundation)", lang: "plain" },
  { id: "cpp", label: "C++ (nlohmann/json)", lang: "plain" },
  { id: "crystal", label: "Crystal (JSON::Serializable)", lang: "plain" },
  { id: "php", label: "PHP", lang: "plain" },
  { id: "ruby-sorbet", label: "Ruby (Sorbet)", lang: "plain" },
  { id: "flow", label: "Flow", lang: "js" },
  { id: "elm", label: "Elm", lang: "plain" },
  { id: "haskell", label: "Haskell (aeson)", lang: "plain" },
  { id: "graphql", label: "GraphQL SDL", lang: "js" },
  { id: "sql", label: "SQL DDL", lang: "sql" },
  { id: "sql-mssql", label: "SQL (MSSQL)", lang: "sql" },
  { id: "protobuf", label: "Protocol Buffers", lang: "plain" },
  { id: "capnp", label: "Cap'n Proto schema", lang: "plain" },
  { id: "flatbuffers", label: "FlatBuffers schema", lang: "plain" },
  { id: "jtd", label: "JSON Type Definition", lang: "json" },
  { id: "json-schema", label: "JSON Schema (2020-12)", lang: "json" },
  { id: "json-schema-07", label: "JSON Schema (draft-07)", lang: "json" },
  { id: "json-schema-04", label: "JSON Schema (draft-04)", lang: "json" },
  { id: "openapi30", label: "OpenAPI 3.0 schema", lang: "json" },
  { id: "openapi20", label: "OpenAPI/Swagger 2.0 schema", lang: "json" },

  // Alternate serializer bindings for languages already listed above, plus
  // the targets that have no entry at all up there. All entries, above and
  // below this line, resolve through the same shared registry; the split is
  // presentation ordering for the picker.
  { id: "python-msgspec", label: "Python (msgspec)", lang: "python" },
  { id: "python-cattrs", label: "Python (cattrs)", lang: "python" },
  { id: "go-easyjson", label: "Go (easyjson)", lang: "plain" },
  { id: "go-jsoniter", label: "Go (jsoniter)", lang: "plain" },
  { id: "go-sonic", label: "Go (sonic)", lang: "plain" },
  { id: "java-jsonb", label: "Java (JSON-B)", lang: "plain" },
  { id: "kotlin-jackson", label: "Kotlin (Jackson)", lang: "plain" },
  { id: "kotlin-gson", label: "Kotlin (Gson)", lang: "plain" },
  { id: "swift-swiftyjson", label: "Swift (SwiftyJSON)", lang: "plain" },
  { id: "swift-objectmapper", label: "Swift (ObjectMapper)", lang: "plain" },
  { id: "csharp-servicestack", label: "C# (ServiceStack)", lang: "plain" },
  { id: "cpp-rapidjson", label: "C++ (RapidJSON)", lang: "plain" },
  { id: "cpp-simdjson", label: "C++ (simdjson)", lang: "plain" },
  { id: "cpp-boost-json", label: "C++ (Boost.JSON)", lang: "plain" },
  { id: "cpp-glaze", label: "C++ (Glaze)", lang: "plain" },
  { id: "dart-built-value", label: "Dart (built_value)", lang: "plain" },
  { id: "elixir-jason", label: "Elixir (Jason)", lang: "plain" },
  { id: "php-symfony", label: "PHP (Symfony Serializer)", lang: "plain" },
  { id: "php-jms", label: "PHP (JMS Serializer)", lang: "plain" },
  { id: "ruby-dry-types", label: "Ruby (dry-types)", lang: "plain" },
  { id: "ruby-rbs", label: "Ruby (RBS)", lang: "plain" },
  { id: "standard-schema", label: "Standard Schema", lang: "json" },
  { id: "json-rpc", label: "JSON-RPC methods", lang: "json" },
  { id: "docusaurus-reference", label: "Docusaurus reference", lang: "plain" },
  { id: "starlight-reference", label: "Starlight reference", lang: "plain" },
  { id: "mkdocs-reference", label: "MkDocs reference", lang: "plain" },
];

export function inputFormatById(id: string): FormatSpec | undefined {
  return inputFormats.find((f) => f.id === id);
}

export function outputFormatById(id: string): FormatSpec | undefined {
  return outputFormats.find((f) => f.id === id);
}
