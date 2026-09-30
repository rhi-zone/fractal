import { describe, expect, test } from "bun:test";
import { toOpenApi } from "@rhi-zone/fractal-http-api-projector";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { flatMapOperations, type Operation } from "./api-description.ts";
import { fromRamlDocument, pluralize, singularize } from "./from-raml.ts";
import { lower, nameKeys, routeKeys, schemaMap, UnboundOperationError } from "./lower.ts";
import type { Node } from "./node.ts";

const files: Record<string, string> = {
  "types/book.raml": `#%RAML 1.0 DataType
type: object
properties:
  id: integer
  title: string
  isbn?: string
  genre: Genre
  tags: string[]
  author: common.Person
`,
  "libraries/common.raml": `#%RAML 1.0 Library
types:
  Person:
    properties:
      name: string
      born?: date-only
resourceTypes:
  audited:
    get?:
      headers:
        X-Audit: string
traits:
  tracked:
    headers:
      X-Trace:
        type: string
        required: false
securitySchemes:
  basic:
    type: Basic Authentication
`,
  "securitySchemes/oauth.raml": `#%RAML 1.0 SecurityScheme
type: OAuth 2.0
settings:
  authorizationUri: https://example.com/auth
`,
  "schemas/error.json": JSON.stringify({
    type: "object",
    properties: { message: { type: "string" }, detail: { $ref: "#/definitions/Detail" } },
    required: ["message"],
    definitions: { Detail: { type: "object", properties: { code: { type: "integer" } } } },
  }),
};

const library = `#%RAML 1.0
title: Library API
version: v1
baseUri: https://api.example.com/{version}
mediaType: application/json
uses:
  common: libraries/common.raml
securitySchemes:
  oauth_2_0: !include securitySchemes/oauth.raml
securedBy: [ oauth_2_0 ]
(release): beta
annotationTypes:
  release: string
types:
  Book: !include types/book.raml
  NewBook:
    properties:
      title: string
      isbn?: string
      author: common.Person
  Genre:
    enum: [ fiction, poetry ]
  Error: !include schemas/error.json
resourceTypes:
  collection:
    usage: any collection
    description: The collection of <<resourcePathName>>
    get:
      is: [ paged ]
      description: List <<resourcePathName | !pluralize>>
      responses:
        200:
          body:
            type: <<resourcePathName | !singularize | !uppercamelcase>>[]
    post:
      description: Create a <<resourcePathName | !singularize>>
      body:
        type: New<<resourcePathName | !singularize | !uppercamelcase>>
      responses:
        201:
          body:
            type: <<resourcePathName | !singularize | !uppercamelcase>>
  member:
    get:
      responses:
        200:
          body:
            type: <<resourcePathName | !singularize | !uppercamelcase>>
    delete?:
      description: Remove one
    put?:
      description: never applied
traits:
  paged:
    queryParameters:
      page?:
        type: integer
        minimum: 1
      per_page?: integer
  secured:
    headers:
      X-Token:
        description: Token for <<methodName>>
        required: true
/books:
  type: collection
  is: [ secured ]
  displayName: Books
  (release): ga
  /{bookId}:
    type: member
    uriParameters:
      bookId:
        type: integer
        description: the book
    get:
      responses:
        404:
          body:
            type: Error
        410:
          description: gone
    delete:
      securedBy: [ null ]
      responses:
        204:
    /reviews:
      get:
        queryParameters:
          rating:
            type: integer
            minimum: 1
            maximum: 5
            required: false
        responses:
          200:
            body:
              application/json:
                type: string[]
/authors:
  get:
    description: All authors
    responses:
      200:
        body: common.Person[]
`;

const resolve = (path: string): string | undefined => files[path];

describe("fromRamlDocument (RAML 1.0)", () => {
  const imported = fromRamlDocument(library, { resolve });
  const byAddress = (address: string): Operation =>
    imported.api.operations.find(
      (o) =>
        o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/") === address,
    )!;

  test("addresses mirror the URL with the method as the key", () => {
    expect(
      imported.api.operations.map((o) =>
        o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/"),
      ),
    ).toEqual([
      "books/get",
      "books/post",
      "books/{bookId}/get",
      "books/{bookId}/delete",
      "books/{bookId}/reviews/get",
      "authors/get",
    ]);
  });

  test("the api description is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported.api))).toEqual(imported.api);
  });

  test("nothing in the fixture is unrepresented except what is meant to be", () => {
    const messages = imported.diagnostics.map((d) => `${d.at}: ${d.message}`);
    expect(messages.filter((m) => !m.includes("non-2xx"))).toEqual([]);
  });

  test("trait and resource type parameters are substituted, with functions", () => {
    const list = byAddress("books/get");
    expect(list.meta.description).toBe("List books");
    expect(list.output!.shape).toEqual({
      kind: "array",
      element: { shape: { kind: "ref", target: "Book" }, meta: {} },
    });
    const create = byAddress("books/post");
    expect(create.meta.description).toBe("Create a book");
    const fields = (create.input.shape as { fields: Record<string, unknown> }).fields;
    expect(Object.keys(fields)).toEqual(["X-Token", "title", "isbn", "author"]);
    expect(create.output!.shape).toEqual({ kind: "ref", target: "Book" });
  });

  test("methodName is a reserved trait parameter", () => {
    const fields = (
      byAddress("books/post").input.shape as {
        fields: Record<string, { meta: Record<string, unknown> }>;
      }
    ).fields;
    expect(fields["X-Token"]!.meta.description).toBe("Token for post");
  });

  test("trait queryParameters map to query with optionality", () => {
    const list = byAddress("books/get");
    const fields = (
      list.input.shape as {
        fields: Record<string, { shape: { kind: string }; meta: Record<string, unknown> }>;
      }
    ).fields;
    expect(Object.keys(fields)).toEqual(["page", "per_page", "X-Token"]);
    expect(fields.page!.meta).toMatchObject({ optional: true, minimum: 1 });
    expect((list.meta.http as { sourceMap: unknown }).sourceMap).toEqual({
      page: { store: "query" },
      per_page: { store: "query" },
      "X-Token": { store: "header" },
    });
  });

  test("uri parameters are path fields typed from uriParameters; the body is the object's properties", () => {
    const show = byAddress("books/{bookId}/get");
    const fields = (
      show.input.shape as {
        fields: Record<string, { shape: { kind: string }; meta: Record<string, unknown> }>;
      }
    ).fields;
    expect(fields.bookId!.shape.kind).toBe("integer");
    expect(fields.bookId!.meta.description).toBe("the book");
    expect((show.meta.http as { sourceMap: unknown }).sourceMap).toEqual({
      bookId: { store: "path" },
    });
  });

  test("optional methods apply only when the resource has them", () => {
    expect(byAddress("books/{bookId}/get")).toBeDefined();
    expect(byAddress("books/{bookId}/delete")).toBeDefined();
    expect(byAddress("books/{bookId}/put")).toBeUndefined();
    expect(byAddress("books/{bookId}/delete").meta.description).toBe("Remove one");
  });

  test("method semantics become tags", () => {
    expect(byAddress("books/get").meta.tags).toEqual({ readOnly: true, idempotent: true });
    expect(byAddress("books/post").meta.tags).toEqual({});
    expect(byAddress("books/{bookId}/delete").meta.tags).toEqual({ idempotent: true });
  });

  test("http bindings", () => {
    expect(byAddress("books/get").meta.http).toMatchObject({ method: "GET", moveTo: ".." });
  });

  test("types: !include of a fragment, library types, enums, JSON schemas with hoisted definitions", () => {
    const defs = imported.api.defs;
    expect(Object.keys(defs).sort()).toEqual(
      ["Book", "Detail", "Error", "Genre", "NewBook", "common.Person"].sort(),
    );
    const book = defs.Book!.shape as {
      fields: Record<string, { shape: unknown; meta: Record<string, unknown> }>;
    };
    expect(book.fields.genre!.shape).toEqual({ kind: "ref", target: "Genre" });
    expect(book.fields.author!.shape).toEqual({ kind: "ref", target: "common.Person" });
    expect(book.fields.isbn!.meta.optional).toBe(true);
    expect(defs.Genre!.shape).toEqual({ kind: "enum", members: ["fiction", "poetry"] });
    const error = defs.Error!.shape as { fields: Record<string, { shape: unknown }> };
    expect(error.fields.detail!.shape).toEqual({ kind: "ref", target: "Detail" });
  });

  test("error responses are kept verbatim with a diagnostic", () => {
    const show = byAddress("books/{bookId}/get");
    const raml = show.meta.raml as { errorResponses: Record<string, unknown> };
    expect(Object.keys(raml.errorResponses)).toEqual(["404", "410"]);
    expect(raml.errorResponses["410"]).toEqual({ description: "gone" });
    expect(
      imported.diagnostics.some(
        (d) => d.at === "/books/{bookId} get" && d.message.includes("non-2xx"),
      ),
    ).toBe(true);
  });

  test("is, securedBy and annotations that do not map are kept in meta.raml", () => {
    const list = byAddress("books/get");
    expect((list.meta.raml as Record<string, unknown>).securedBy).toEqual(["oauth_2_0"]);
    expect(
      (byAddress("books/{bookId}/delete").meta.raml as Record<string, unknown>).securedBy,
    ).toEqual([null]);
    const groups = imported.api.groups;
    const books = groups.find(
      (g) =>
        g.address.length === 1 && g.address[0]!.kind === "static" && g.address[0]!.name === "books",
    )!;
    expect(books.meta).toEqual({
      description: "The collection of books",
      raml: {
        displayName: "Books",
        annotations: { release: "ga" },
        type: "collection",
        is: ["secured"],
      },
    });
  });

  test("root info, security schemes and libraries are group meta at the root", () => {
    const root = imported.api.groups.find((g) => g.address.length === 0)!;
    const raml = root.meta.raml as Record<string, unknown>;
    expect(raml.title).toBe("Library API");
    expect(raml.baseUri).toBe("https://api.example.com/{version}");
    expect(raml.securitySchemes).toEqual({
      oauth_2_0: { type: "OAuth 2.0", settings: { authorizationUri: "https://example.com/auth" } },
    });
    expect(raml.annotations).toEqual({ release: "beta" });
    expect(raml.libraries).toEqual({
      common: { securitySchemes: { basic: { type: "Basic Authentication" } } },
    });
    expect(imported.info).toEqual({ title: "Library API", version: "v1" });
    expect(imported.ramlVersion).toBe("1.0");
  });

  test("body media types: an explicit JSON entry and a default-media body", () => {
    expect(byAddress("books/{bookId}/reviews/get").output!.shape.kind).toBe("array");
    expect(byAddress("authors/get").output!.shape).toEqual({
      kind: "array",
      element: { shape: { kind: "ref", target: "common.Person" }, meta: {} },
    });
  });

  test("a response without a body is void", () => {
    expect(byAddress("books/{bookId}/delete").output!.shape.kind).toBe("void");
  });
});

describe("includes", () => {
  const doc = `#%RAML 1.0
title: t
types:
  A: !include a.raml
  B: !include missing.raml
`;

  test("without a resolver every include is a diagnostic", () => {
    const { diagnostics } = fromRamlDocument(doc);
    expect(diagnostics.filter((d) => d.message.includes("no resolver"))).toHaveLength(2);
  });

  test("a missing file is a diagnostic and the value is null (a string-typed def)", () => {
    const { api, diagnostics } = fromRamlDocument(doc, {
      resolve: (p) => (p === "a.raml" ? "type: number" : undefined),
    });
    expect(
      diagnostics.some(
        (d) => d.at === "!include missing.raml" && d.message.includes("no such file"),
      ),
    ).toBe(true);
    expect(api.defs.A!.shape.kind).toBe("number");
    expect(api.defs.B!.shape.kind).toBe("string");
  });

  test("a throwing resolver does not lose the document", () => {
    const { api, diagnostics } = fromRamlDocument(doc, {
      resolve: () => {
        throw new Error("boom");
      },
    });
    expect(Object.keys(api.defs)).toEqual(["A", "B"]);
    expect(diagnostics.some((d) => d.message.includes("boom"))).toBe(true);
  });

  test("relative includes resolve against the including file, absolute ones against the root", () => {
    const seen: string[] = [];
    fromRamlDocument(
      `#%RAML 1.0
title: t
types: !include lib/types.raml
`,
      {
        path: "api/main.raml",
        resolve: (p) => {
          seen.push(p);
          if (p === "api/lib/types.raml")
            return "X: !include ../shared/x.raml\nY: !include /common/y.raml";
          return "type: string";
        },
      },
    );
    expect(seen).toEqual(["api/lib/types.raml", "api/shared/x.raml", "api/common/y.raml"]);
  });

  test("an include cycle is reported", () => {
    const { diagnostics } = fromRamlDocument(
      `#%RAML 1.0
title: t
types:
  A: !include a.raml
`,
      { resolve: () => "type: object\nproperties:\n  next: !include a.raml" },
    );
    expect(diagnostics.some((d) => d.message === "include cycle")).toBe(true);
  });
});

describe("inflection", () => {
  test("singularize", () => {
    const cases: [string, string][] = [
      ["users", "user"],
      ["categories", "category"],
      ["addresses", "address"],
      ["boxes", "box"],
      ["people", "person"],
      ["children", "child"],
      ["statuses", "status"],
      ["status", "status"],
      ["news", "news"],
      ["data", "data"],
      ["potatoes", "potato"],
      ["leaves", "leaf"],
      ["movies", "movie"],
      ["userProfiles", "userProfile"],
      ["API_KEYS", "API_KEY"],
    ];
    for (const [plural, singular] of cases) expect(singularize(plural)).toBe(singular);
  });

  test("pluralize", () => {
    const cases: [string, string][] = [
      ["user", "users"],
      ["category", "categories"],
      ["address", "addresses"],
      ["box", "boxes"],
      ["person", "people"],
      ["child", "children"],
      ["status", "statuses"],
      ["hero", "heroes"],
      ["key", "keys"],
      ["day", "days"],
      ["Book", "Books"],
    ];
    for (const [singular, plural] of cases) expect(pluralize(singular)).toBe(plural);
  });

  test("all the case functions", () => {
    const { api } = fromRamlDocument(`#%RAML 1.0
title: t
resourceTypes:
  r:
    get:
      description: <<resourcePathName | !uppercase>> <<resourcePathName | !lowercase>> <<v | !lowercamelcase>> <<v | !uppercamelcase>> <<v | !lowerunderscorecase>> <<v | !upperunderscorecase>> <<v | !lowerhyphencase>> <<v | !upperhyphencase>>
/userIds:
  type: { r: { v: userId } }
  get:
`);
    expect(api.operations[0]!.meta.description).toBe(
      "USERIDS userids userId UserId user_id USER_ID user-id USER-ID",
    );
  });
});

describe("templates", () => {
  test("resourcePath drops the extension parameter; resourcePathName skips parameter fragments", () => {
    const { api, diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
resourceTypes:
  r:
    get:
      description: <<resourcePath>> | <<resourcePathName>>
/bom/{itemId}{ext}:
  type: r
`);
    expect(api.operations[0]!.meta.description).toBe("/bom/{itemId} | bom");
    expect(diagnostics.some((d) => d.message.includes("media type extension"))).toBe(true);
  });

  test("merge order: the method beats resource types beats traits; lists merge by value", () => {
    const { api } = fromRamlDocument(`#%RAML 1.0
title: t
traits:
  t1:
    description: from trait
    queryParameters:
      platform:
        enum: [ win, mac ]
        description: trait wins nothing here
resourceTypes:
  r:
    get:
      description: from resource type
      is: [ t1 ]
/x:
  type: r
  get:
    queryParameters:
      platform:
        enum: [ mac, unix ]
        description: method
`);
    const op = api.operations[0]!;
    expect(op.meta.description).toBe("from resource type");
    const platform = (
      op.input.shape as {
        fields: Record<string, { shape: { members?: string[] }; meta: Record<string, unknown> }>;
      }
    ).fields.platform!;
    expect(platform.shape.members).toEqual(["mac", "unix", "win"]);
    expect(platform.meta.description).toBe("method");
  });

  test("traits with parameters, in the inline map form", () => {
    const { api, diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
traits:
  secured:
    queryParameters:
      <<tokenName>>:
        description: A valid <<tokenName>> is required
  paged:
    queryParameters:
      numPages:
        description: at most <<maxPages>>
resourceTypes:
  searchable:
    get:
      queryParameters:
        <<queryParamName>>:
          description: matches <<queryParamName>> or <<fallbackParamName>>
/books:
  type: { searchable: { queryParamName: title, fallbackParamName: digest } }
  get:
    is: [ secured: { tokenName: access_token }, paged: { maxPages: 10 } ]
`);
    const fields = (
      api.operations[0]!.input.shape as {
        fields: Record<string, { meta: Record<string, unknown> }>;
      }
    ).fields;
    expect(Object.keys(fields).sort()).toEqual(["access_token", "numPages", "title"]);
    expect(fields.access_token!.meta.description).toBe("A valid access_token is required");
    expect(fields.numPages!.meta.description).toBe("at most 10");
    expect(fields.title!.meta.description).toBe("matches title or digest");
    expect(diagnostics).toEqual([]);
  });

  test("a resource type inherits another and a trait uses another", () => {
    const { api, diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
traits:
  base:
    headers:
      X-A: string
  derived:
    is: [ base ]
    headers:
      X-B: string
resourceTypes:
  parent:
    get:
      description: parent get
  child:
    type: parent
    post:
      description: child post
/r:
  type: child
  is: [ derived ]
`);
    expect(
      api.operations.map((o) => o.address.map((s) => (s as { name: string }).name).join("/")),
    ).toEqual(["r/post", "r/get"]);
    const fields = (api.operations[0]!.input.shape as { fields: object }).fields;
    expect(Object.keys(fields).sort()).toEqual(["X-A", "X-B"]);
    expect(diagnostics).toEqual([]);
  });

  test("unknown resource types, traits, parameters and functions are reported", () => {
    const { diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
traits:
  needs:
    description: <<who>> <<resourcePathName | !shout>>
/a:
  type: nope
  get:
    is: [ missing, needs ]
`);
    const messages = diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes('resource type "nope" is not declared'))).toBe(true);
    expect(messages.some((m) => m.includes('trait "missing" is not declared'))).toBe(true);
    expect(messages.some((m) => m.includes('no value for parameter "who"'))).toBe(true);
    expect(messages.some((m) => m.includes('unknown function "!shout"'))).toBe(true);
  });

  test("a template cycle terminates", () => {
    const { diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
traits:
  a:
    is: [ b ]
  b:
    is: [ a ]
resourceTypes:
  x:
    type: x
/r:
  type: x
  get:
    is: [ a ]
`);
    expect(diagnostics.filter((d) => d.message.includes("itself")).length).toBeGreaterThan(0);
  });
});

describe("libraries", () => {
  const libFiles: Record<string, string> = {
    "libs/a.raml": `#%RAML 1.0 Library
uses:
  b: b.raml
types:
  A:
    properties:
      t: b.T
traits:
  drm:
    headers:
      drm-key: string
resourceTypes:
  file:
    get:
      is: [ drm ]
`,
    "libs/b.raml": `#%RAML 1.0 Library
types:
  T: string
`,
  };
  const doc = `#%RAML 1.0
title: t
uses:
  a: libs/a.raml
  bb: libs/b.raml
types:
  R:
    properties:
      a: a.A
      t: bb.T
/f:
  type: a.file
`;
  const { api, diagnostics } = fromRamlDocument(doc, { resolve: (p) => libFiles[p] });

  test("library types are keyed alias.Name; a library used twice is one scope", () => {
    expect(Object.keys(api.defs).sort()).toEqual(["R", "a.A", "b.T"]);
    const fields = (api.defs.R!.shape as { fields: Record<string, { shape: unknown }> }).fields;
    expect(fields.a!.shape).toEqual({ kind: "ref", target: "a.A" });
    expect(fields.t!.shape).toEqual({ kind: "ref", target: "b.T" });
    const inner = (api.defs["a.A"]!.shape as { fields: Record<string, { shape: unknown }> }).fields;
    expect(inner.t!.shape).toEqual({ kind: "ref", target: "b.T" });
  });

  test("a library resource type's own trait names resolve in the library", () => {
    const fields = (api.operations[0]!.input.shape as { fields: object }).fields;
    expect(Object.keys(fields)).toEqual(["drm-key"]);
    expect(diagnostics).toEqual([]);
  });

  test("a library that cannot be loaded is reported", () => {
    const r = fromRamlDocument(doc, { resolve: () => undefined });
    expect(r.diagnostics.some((d) => d.message === "library could not be loaded")).toBe(true);
  });
});

describe("parameters that are only needed by an applied part", () => {
  const doc = (extra: string) => `#%RAML 1.0
title: t
resourceTypes:
  corp:
    post?:
      description: about <<Text>>
    get:
      description: get <<Other>>
/servers:
  type: { corp: { Other: x, Text: post } }
  post:
/queues:
  type: { corp: { Other: x } }
${extra}`;

  test("an optional method that is not applied does not demand its parameters", () => {
    const { diagnostics, api } = fromRamlDocument(doc(""));
    expect(diagnostics).toEqual([]);
    expect(
      api.operations.map((o) => o.address.map((s) => (s as { name: string }).name).join("/")),
    ).toEqual(["servers/post", "servers/get", "queues/get"]);
  });

  test("an applied part with a missing parameter is reported", () => {
    const { diagnostics } = fromRamlDocument(doc("  post:\n"));
    expect(diagnostics.map((d) => d.message)).toEqual([
      'resource type "corp" has no value for parameter "Text"',
    ]);
  });
});

describe("addressing", () => {
  const doc = `#%RAML 1.0
title: t
/users:
  get:
  /{userId}:
    get:
    /posts:
      /{postId}:
        get:
/users/{id}/friends:
  get:
/folder_{folderId}-file_{fileId}:
  get:
/x:
  get:
/x/get:
  get:
`;
  const { api, diagnostics } = fromRamlDocument(doc);
  const addrs = api.operations.map((o) =>
    o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/"),
  );

  test("nested and multi-segment resources, a shared param position bound to the first name", () => {
    expect(addrs).toEqual([
      "users/get",
      "users/{userId}/get",
      "users/{userId}/posts/{postId}/get",
      "users/{userId}/friends/get",
      "x/http-get",
      "x/get/get",
    ]);
    const friends = api.operations[3]!;
    expect((friends.meta.http as { sourceMap: unknown }).sourceMap).toEqual({
      id: { store: "path", key: "userId" },
    });
    expect(diagnostics.some((d) => d.message.includes('shares its position with "userId"'))).toBe(
      true,
    );
  });

  test("a segment mixing text and a template is skipped with a diagnostic", () => {
    expect(diagnostics.some((d) => d.at.includes("folder_") && d.message.includes("skipped"))).toBe(
      true,
    );
  });

  test("a resource literally named like a method keeps the operation reachable", () => {
    expect(addrs).toContain("x/http-get");
  });
});

describe("bodies and parameters", () => {
  test("non-object request bodies become one input field, non-JSON media types are reported", () => {
    const { api, diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
types:
  Ids: integer[]
/a:
  post:
    body:
      application/json:
        type: Ids
/b:
  post:
    body:
      text/plain:
        type: string
`);
    for (const op of api.operations) {
      expect(Object.keys((op.input.shape as { fields: object }).fields)).toEqual(["body"]);
    }
    expect(diagnostics.filter((d) => d.message.includes("not an object type"))).toHaveLength(2);
    expect(diagnostics.some((d) => d.message.includes('"text/plain" is not JSON'))).toBe(true);
  });

  test("queryString of an object type becomes query fields", () => {
    const { api } = fromRamlDocument(`#%RAML 1.0
title: t
types:
  paging:
    properties:
      start?: number
      page-size?: number
  lat-long:
    properties:
      lat: number
      long: number
/l:
  get:
    queryString:
      type: [ paging, lat-long ]
`);
    const op = api.operations[0]!;
    expect(Object.keys((op.input.shape as { fields: object }).fields)).toEqual([
      "start",
      "page-size",
      "lat",
      "long",
    ]);
    expect((op.meta.http as { sourceMap: Record<string, unknown> }).sourceMap.lat).toEqual({
      store: "query",
    });
  });

  test("a scalar queryString is kept verbatim and reported", () => {
    const { api, diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
/l:
  get:
    queryString:
      type: string
`);
    expect((api.operations[0]!.meta.raml as Record<string, unknown>).queryString).toEqual({
      type: "string",
    });
    expect(diagnostics.some((d) => d.message.includes("queryString is not an object type"))).toBe(
      true,
    );
  });

  test("a name declared in two stores keeps the first and is reported", () => {
    const { diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
types:
  T:
    properties:
      id: string
/a/{id}:
  post:
    body:
      type: T
`);
    expect(
      diagnostics.some((d) => d.message.includes('"id" is declared in both path and body')),
    ).toBe(true);
  });

  test("further 2xx responses are kept verbatim", () => {
    const { api } = fromRamlDocument(`#%RAML 1.0
title: t
/a:
  get:
    responses:
      200:
        body:
          type: string
      202:
        description: accepted
`);
    expect(
      (api.operations[0]!.meta.raml as { extraSuccessResponses: unknown }).extraSuccessResponses,
    ).toEqual({
      "202": { description: "accepted" },
    });
  });

  test("an undeclared type reference is reported and replaced", () => {
    const { api, diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
/a:
  get:
    responses:
      200:
        body:
          type: Ghost
`);
    expect(api.operations[0]!.output!.meta.raml).toEqual({ unresolvedType: "Ghost" });
    expect(diagnostics.some((d) => d.message.includes('"Ghost"'))).toBe(true);
  });

  test("a type that inherits itself is replaced", () => {
    const { api, diagnostics } = fromRamlDocument(`#%RAML 1.0
title: t
types:
  A:
    type: B
  B:
    type: A
`);
    expect(diagnostics.some((d) => d.message === "type inherits itself")).toBe(true);
    expect(api.defs.A!.shape.kind === "ref" && api.defs.B!.shape.kind === "ref").toBe(false);
  });
});

describe("RAML 0.8", () => {
  const doc = `#%RAML 0.8
title: Legacy
version: 1
baseUri: https://example.com
schemas:
  - Widget: |
      { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
resourceTypes:
  - collection:
      get:
        description: list <<resourcePathName>>
        queryParameters:
          page:
            type: integer
            default: 1
      post?:
        body:
          application/json:
            schema: Widget
traits:
  - dated:
      queryParameters:
        since:
          type: date
/widgets:
  type: collection
  is: [ dated ]
  post:
    body:
      application/json:
        schema: Widget
    responses:
      201:
        body:
          application/json:
            schema: Widget
  /{id}:
    uriParameters:
      id:
        type: integer
    get:
      queryParameters:
        tags:
          type: string
          repeat: true
        limit:
          - type: integer
            required: true
          - type: string
    put:
      body:
        application/x-www-form-urlencoded:
          formParameters:
            name:
              type: string
              required: true
            avatar:
              type: file
`;
  const { api, diagnostics, ramlVersion, info } = fromRamlDocument(doc);
  const op = (address: string) =>
    api.operations.find(
      (o) =>
        o.address.map((s) => (s.kind === "param" ? `{${s.name}}` : s.name)).join("/") === address,
    )!;
  const fieldsOf = (o: Operation) =>
    (
      o.input.shape as {
        fields: Record<string, { shape: { kind: string }; meta: Record<string, unknown> }>;
      }
    ).fields;

  test("version and info", () => {
    expect(ramlVersion).toBe("0.8");
    expect(info).toEqual({ title: "Legacy", version: "1" });
  });

  test("schemas are types; a body's schema names one", () => {
    expect(Object.keys(api.defs)).toEqual(["Widget"]);
    expect(op("widgets/post").output!.shape).toEqual({ kind: "ref", target: "Widget" });
    expect(Object.keys(fieldsOf(op("widgets/post")))).toEqual(["since", "name"]);
  });

  test("parameters default to optional, except URI parameters; date is rfc2616 datetime", () => {
    const list = fieldsOf(op("widgets/get"));
    expect(list.page!.meta.optional).toBe(true);
    expect(list.page!.shape.kind).toBe("integer");
    expect(list.since!.shape.kind).toBe("datetime");
    expect(list.since!.meta.raml).toEqual({ format: "rfc2616" });
    expect(fieldsOf(op("widgets/{id}/get")).id!.meta.optional).toBeUndefined();
  });

  test("repeat is an array; a list of alternatives is a union", () => {
    const show = fieldsOf(op("widgets/{id}/get"));
    expect(show.tags!.shape.kind).toBe("array");
    expect(show.limit!.shape.kind).toBe("union");
    expect(show.limit!.meta.optional).toBeUndefined();
  });

  test("list-form resource types and traits, optional methods", () => {
    expect(op("widgets/get").meta.description).toBe("list widgets");
    expect(op("widgets/{id}/get")).toBeDefined();
  });

  test("formParameters are body fields and the media type is reported", () => {
    const put = op("widgets/{id}/put");
    expect(Object.keys(fieldsOf(put))).toEqual(["id", "name", "avatar"]);
    expect(fieldsOf(put).avatar!.meta.optional).toBe(true);
    expect(fieldsOf(put).name!.meta.optional).toBeUndefined();
    expect(diagnostics.some((d) => d.message.includes("application/x-www-form-urlencoded"))).toBe(
      true,
    );
  });
});

describe("documents that are not API definitions", () => {
  test("no header, fragments, extensions and bad YAML throw or report", () => {
    expect(() => fromRamlDocument("title: x")).toThrow("no #%RAML header");
    expect(() => fromRamlDocument("#%RAML 1.0 Library\ntypes: {}")).toThrow("Library fragment");
    expect(() => fromRamlDocument("#%RAML 1.1\ntitle: x")).toThrow("unsupported");
    expect(() => fromRamlDocument("#%RAML 1.0 Extension\nextends: a.raml")).toThrow(
      "not an API definition",
    );
    expect(() => fromRamlDocument("#%RAML 1.0\nextends: a.raml\ntitle: x")).toThrow(
      "overlay or extension",
    );
    const { diagnostics } = fromRamlDocument("#%RAML 1.0\ntitle: x\ntypes:\n  A: [unterminated\n");
    expect(diagnostics.some((d) => d.message.startsWith("YAML:"))).toBe(true);
  });
});

describe("lower + projectors", () => {
  const imported = fromRamlDocument(library, { resolve });
  const lowered = lower(imported.api);

  function leafAt(tree: Node, path: readonly string[]): Node {
    let cur: Node = tree;
    for (const seg of path) {
      const next = seg.startsWith(":") ? cur.fallback?.subtree : cur.children?.[seg];
      if (next === undefined) throw new Error(`no node at ${path.join("/")}`);
      cur = next;
    }
    return cur;
  }

  test("unbound operations throw a typed error", () => {
    expect(() => leafAt(lowered.tree, ["books", "get"]).handler!({})).toThrow(
      UnboundOperationError,
    );
  });

  test("openapi out reproduces paths and methods", async () => {
    const doc = await toOpenApi(lowered.tree, {
      schemas: schemaMap(lowered, routeKeys),
      title: imported.info.title!,
      version: imported.info.version!,
    });
    const ops = Object.entries(doc.paths).flatMap(([p, ms]) =>
      Object.entries(ms).map(([m]) => `${m.toUpperCase()} ${p}`),
    );
    expect(ops.sort()).toEqual(
      [
        "GET /books",
        "POST /books",
        "GET /books/{bookId}",
        "DELETE /books/{bookId}",
        "GET /books/{bookId}/reviews",
        "GET /authors",
      ].sort(),
    );
  });

  test("mcp tools carry the imported schemas and method hints", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual([
      "authors_get",
      "books_bookId_delete",
      "books_bookId_get",
      "books_bookId_reviews_get",
      "books_get",
      "books_post",
    ]);
    expect((byName.books_get!.inputSchema as { properties: object }).properties).toHaveProperty(
      "page",
    );
    expect(byName.books_get!.annotations?.readOnlyHint).toBe(true);
    expect((byName.books_post!.inputSchema as { required?: string[] }).required).toContain("title");
  });

  test("a transform over the description keeps it lowerable", () => {
    const hidden = flatMapOperations(imported.api, (op) =>
      (op.meta.tags as { readOnly?: boolean }).readOnly ? op : [],
    );
    expect(hidden.operations.length).toBeLessThan(imported.api.operations.length);
    expect(() => lower(hidden)).not.toThrow();
  });
});
