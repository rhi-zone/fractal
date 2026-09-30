import { describe, expect, test } from "bun:test";
import { buildSchema, type GraphQLFieldMap } from "graphql";
import { toSDL } from "@rhi-zone/fractal-graphql-api-projector/schema";
import { fromGraphqlSchema } from "./from-graphql.ts";
import { lower, nameKeys, typeRefMap } from "./lower.ts";

const sdl = `
"""a bookshop"""
schema {
  query: RootQuery
  mutation: Mutation
  subscription: Subscription
}

directive @auth(role: String) on FIELD_DEFINITION

type RootQuery {
  "find a book"
  book(id: ID!, lang: String = "en"): Book
  books(first: Int! = 10, filter: BookFilter): [Book!]!
  legacy: String @deprecated(reason: "use books")
  gated: Int @auth(role: "admin")
}

extend type RootQuery {
  genres: [Genre!]!
}

type Mutation {
  addBook(input: BookInput!): Book!
  book(id: ID!): Boolean
}

type Subscription {
  bookAdded(genre: Genre): Book!
}

type Book {
  id: ID!
  title: String!
  tags: [String!]
  genre: Genre
}

input BookInput {
  title: String!
  genre: Genre
}

input BookFilter {
  genre: Genre
  titleContains: String
}

enum Genre {
  FICTION
  POETRY @deprecated
}
`;

const field = (imported: ReturnType<typeof fromGraphqlSchema>, name: string) =>
  imported.api.operations.find((o) => o.meta.graphql && (o.meta.graphql as any).name === name)!;

describe("fromGraphqlSchema: import", () => {
  const imported = fromGraphqlSchema(sdl);

  test("each root field is one operation, in root-type then field order", () => {
    expect(
      imported.api.operations.map((o) => [
        o.address.map((s) => s.name).join("/"),
        (o.meta.graphql as any).operation,
      ]),
    ).toEqual([
      ["book", "query"],
      ["books", "query"],
      ["legacy", "query"],
      ["gated", "query"],
      ["genres", "query"],
      ["addBook", "mutation"],
      ["mutation/book", "mutation"],
      ["bookAdded", "subscription"],
    ]);
  });

  test("a name shared across root types is addressed under its operation type but keeps its exact name", () => {
    const op = imported.api.operations.find((o) => o.address.length === 2)!;
    expect((op.meta.graphql as any).name).toBe("book");
    expect(imported.diagnostics.some((d) => d.at === "Mutation.book")).toBe(true);
  });

  test("arguments become the named-params input; nullable ones are optional", () => {
    const book = field(imported, "book");
    const fields = (book.input.shape as any).fields;
    expect(Object.keys(fields)).toEqual(["id", "lang"]);
    expect(fields.id.meta.optional).toBeUndefined();
    expect(fields.lang.meta.optional).toBe(true);
    expect(fields.lang.meta.default).toBe("en");
    const books = (field(imported, "books").input.shape as any).fields;
    expect(books.first.meta.optional).toBeUndefined();
    expect(books.first.meta.default).toBe(10);
    expect((field(imported, "genres").input.shape as any).fields).toEqual({});
  });

  test("return type is the output; subscriptions stream it", () => {
    expect(field(imported, "book").output!.shape).toEqual({ kind: "ref", target: "Book" });
    expect(field(imported, "book").output!.meta.nullable).toBe(true);
    const sub = field(imported, "bookAdded");
    expect(sub.output!.shape.kind).toBe("stream");
    expect(sub.output!.meta.nullable).toBeUndefined();
  });

  test("tags, description, deprecation and other directives", () => {
    expect(field(imported, "book").meta).toMatchObject({
      description: "find a book",
      tags: { readOnly: true },
    });
    expect(field(imported, "addBook").meta.tags).toEqual({});
    expect(field(imported, "bookAdded").meta.tags).toEqual({ streaming: true });
    expect(field(imported, "legacy").meta).toMatchObject({
      tags: { readOnly: true, deprecated: true },
      graphql: { deprecatedReason: "use books" },
    });
    expect((field(imported, "gated").meta.graphql as any).directives).toEqual([
      { name: "auth", args: { role: "admin" } },
    ]);
  });

  test("defs hold the non-root types; the root type only if referenced", () => {
    expect(Object.keys(imported.api.defs).sort()).toEqual([
      "Book",
      "BookFilter",
      "BookInput",
      "Genre",
    ]);
    expect(Object.keys(imported.api.defs)).not.toContain("RootQuery");
  });

  test("schema-level facts sit on the root group", () => {
    expect(imported.api.groups).toEqual([
      {
        address: [],
        meta: {
          description: "a bookshop",
          graphql: {
            rootTypes: { query: "RootQuery" },
            directiveDefinitions: ["directive @auth(role: String) on FIELD_DEFINITION"],
          },
        },
      },
    ]);
  });

  test("enum value metadata is reported as lost", () => {
    expect(imported.diagnostics.map((d) => d.at)).toContain("Genre.POETRY");
  });

  test("the result is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported))).toEqual(imported);
  });
});

describe("fromGraphqlSchema: schema resolution", () => {
  test("no schema definition: types named Query/Mutation/Subscription are the roots", () => {
    const { api, diagnostics } = fromGraphqlSchema(
      "type Query { a: Int } type Mutation { b: Int } type Other { c: Int }",
    );
    expect(api.operations.map((o) => (o.meta.graphql as any).operation)).toEqual([
      "query",
      "mutation",
    ]);
    expect(Object.keys(api.defs)).toEqual(["Other"]);
    expect(diagnostics).toEqual([]);
  });

  test("extend schema adds operation types; extend type merges fields", () => {
    const { api } = fromGraphqlSchema(`
      type Query { a: Int }
      type M { b: Int }
      extend schema { mutation: M }
      extend type M { c: Int }
    `);
    expect(
      api.operations.map((o) => [o.address[0]!.name, (o.meta.graphql as any).operation]),
    ).toEqual([
      ["a", "query"],
      ["b", "mutation"],
      ["c", "mutation"],
    ]);
  });

  test("an extension with no definition is treated as the definition", () => {
    const { api, diagnostics } = fromGraphqlSchema("extend type Query { a: Int }");
    expect(api.operations).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
  });

  test("a root type that is also referenced stays in defs", () => {
    const { api } = fromGraphqlSchema("type Query { me: Query, x: Int }");
    expect(Object.keys(api.defs)).toEqual(["Query"]);
  });

  test("a missing root type, duplicate roots and executable definitions are diagnosed, not fatal", () => {
    const { api, diagnostics } = fromGraphqlSchema(`
      schema { query: Missing mutation: R subscription: R }
      type R { a: Int }
      query Q { a }
    `);
    expect(api.operations.map((o) => o.address[0]!.name)).toEqual(["a"]);
    expect(diagnostics.map((d) => d.at).sort()).toEqual(["Missing", "R", "query Q"]);
  });

  test("invalid SDL throws", () => {
    expect(() => fromGraphqlSchema("type {")).toThrow();
  });
});

describe("fromGraphqlSchema: lower and project", () => {
  const imported = fromGraphqlSchema(sdl);

  test("lower() places each operation at its address", () => {
    const { tree } = lower(imported.api);
    expect(Object.keys(tree.children!).sort()).toEqual([
      "addBook",
      "book",
      "bookAdded",
      "books",
      "gated",
      "genres",
      "legacy",
      "mutation",
    ]);
    expect(Object.keys(tree.children!.mutation!.children!)).toEqual(["book"]);
  });

  test("graphql projector re-emits the same root fields", () => {
    const lowered = lower(imported.api);
    const projected = buildSchema(
      toSDL(lowered.tree, { types: typeRefMap(lowered, nameKeys), namedTypes: lowered.defs }),
    );
    const original = buildSchema(sdl);

    // type-ir's `toGraphQL` prints an `ID` (a string with `format: "id"`) as `String`.
    const wireType = (type: unknown): string => String(type).replaceAll("ID", "String");
    const summarize = (fields: GraphQLFieldMap<unknown, unknown> | undefined) =>
      Object.fromEntries(
        Object.values(fields ?? {}).map((f) => [
          f.name,
          {
            args: f.args.map((a) => `${a.name}: ${wireType(a.type)}`),
            type: wireType(f.type),
            deprecationReason: f.deprecationReason,
            description: f.description,
          },
        ]),
      );

    expect(summarize(projected.getQueryType()?.getFields())).toEqual(
      summarize(original.getQueryType()?.getFields()),
    );
    expect(summarize(projected.getMutationType()?.getFields())).toEqual(
      summarize(original.getMutationType()?.getFields()),
    );
    expect(summarize(projected.getSubscriptionType()?.getFields())).toEqual(
      summarize(original.getSubscriptionType()?.getFields()),
    );
  });
});
