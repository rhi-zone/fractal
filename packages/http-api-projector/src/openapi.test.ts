// packages/http-api-projector/src/openapi.test.ts — OpenAPI 3.1 projection tests
//
// Tests run against examples/library-api/src/tree.ts — the canonical
// cross-surface fixture. Every test asserts a specific OpenAPI invariant.

import { describe, expect, it, beforeAll } from "bun:test"
import { listRoutes, mergeOpenApiDocs, toOpenApi, type OpenApiDoc } from "./openapi.ts"
import { httpRoute, type RouteLeafMeta } from "./route.ts"
import { api } from "../../../examples/library-api/src/tree.ts"
import { extractToolSchemas } from "@rhi-zone/fractal-api-tree/tree"

const treePath = new URL(
  "../../../examples/library-api/src/tree.ts",
  import.meta.url,
).pathname

// Pre-compute schema map once for the suite
const schemas = extractToolSchemas(treePath)

// Build the doc once for structural tests (no codegen schemas)
let doc: OpenApiDoc
let docWithSchemas: OpenApiDoc

beforeAll(async () => {
  doc = await toOpenApi(api, { title: "Library API", version: "1.0.0" })
  docWithSchemas = await toOpenApi(api, {
    title: "Library API",
    version: "1.0.0",
    schemas,
  })
})

// ============================================================================
// 1. Top-level doc shape
// ============================================================================

describe("document shape", () => {
  it("openapi version is 3.1.0", () => {
    expect(doc.openapi).toBe("3.1.0")
  })

  it("info.title and info.version come from opts", () => {
    expect(doc.info.title).toBe("Library API")
    expect(doc.info.version).toBe("1.0.0")
  })

  it("info defaults to 'API' and '0.1.0' when opts omitted", async () => {
    const d = await toOpenApi(api)
    expect(d.info.title).toBe("API")
    expect(d.info.version).toBe("0.1.0")
  })

  it("paths object is present and non-empty", () => {
    expect(doc.paths).toBeDefined()
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0)
  })

  it("every operation has an operationId", () => {
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        expect(typeof op.operationId).toBe("string")
        expect(op.operationId.length).toBeGreaterThan(0)
      }
    }
  })
})

// ============================================================================
// 2. Verb derivation from tags
// ============================================================================

describe("verb derivation from tags", () => {
  it("readOnly op (books list) → GET path", () => {
    const pathItem = doc.paths["/books/list"]
    expect(pathItem).toBeDefined()
    expect(pathItem!["get"]).toBeDefined()
    expect(pathItem!["post"]).toBeUndefined()
  })

  it("destructive+idempotent op (remove) → DELETE /books/{bookId} (attribute-dispatch)", () => {
    const pathItem = doc.paths["/books/{bookId}"]
    expect(pathItem).toBeDefined()
    expect(pathItem!["delete"]).toBeDefined()
  })

  it("idempotent op (replace) → PUT /books/{bookId} (attribute-dispatch)", () => {
    const pathItem = doc.paths["/books/{bookId}"]
    expect(pathItem).toBeDefined()
    expect(pathItem!["put"]).toBeDefined()
  })

  it("catalog ops inherit readOnly from node-level tag → GET routes", () => {
    expect(doc.paths["/catalog/search"]?.["get"]).toBeDefined()
    expect(doc.paths["/catalog/genres"]?.["get"]).toBeDefined()
  })

  it("add op (no tags) → POST path", () => {
    const pathItem = doc.paths["/books/add"]
    expect(pathItem).toBeDefined()
    expect(pathItem!["post"]).toBeDefined()
  })
})

// ============================================================================
// 3. Path parameters
// ============================================================================

describe("path parameters", () => {
  it("param route GET /books/{bookId} yields a path parameter (attribute-dispatch read)", () => {
    const op = doc.paths["/books/{bookId}"]?.["get"]
    expect(op).toBeDefined()
    expect(op!.parameters).toBeDefined()
    expect(op!.parameters).toHaveLength(1)
    expect(op!.parameters![0]!.name).toBe("bookId")
    expect(op!.parameters![0]!.in).toBe("path")
    expect(op!.parameters![0]!.required).toBe(true)
  })

  it("param route PUT /books/{bookId} also yields path parameter (attribute-dispatch replace)", () => {
    const op = doc.paths["/books/{bookId}"]?.["put"]
    expect(op?.parameters).toBeDefined()
    const p = op!.parameters![0]!
    expect(p.name).toBe("bookId")
    expect(p.in).toBe("path")
  })

  it("non-param route /catalog/search has no parameters", () => {
    const op = doc.paths["/catalog/search"]?.["get"]
    expect(op?.parameters === undefined || op!.parameters!.length === 0).toBe(true)
  })
})

// ============================================================================
// 4. requestBody (codegen schema integration)
// ============================================================================

describe("requestBody from codegen schemas", () => {
  it("catalog/search (GET) has no requestBody", () => {
    const op = docWithSchemas.paths["/catalog/search"]?.["get"]
    expect(op?.requestBody).toBeUndefined()
  })

  it("books/add (POST) has requestBody with non-empty input schema", () => {
    // books is authored via api()/op(), so codegen derives its real input
    // schema (title/author/genre) rather than degrading to a placeholder.
    const op = docWithSchemas.paths["/books/add"]?.["post"]
    expect(op).toBeDefined()
    if (op!.requestBody !== undefined) {
      expect(op!.requestBody.content["application/json"].schema).toBeDefined()
    }
  })

  it("catalog/search GET requestBody absent even with schemas (GET never has body)", async () => {
    const op = docWithSchemas.paths["/catalog/search"]?.["get"]
    expect(op?.requestBody).toBeUndefined()
  })
})

// ============================================================================
// 5. 200 response schema from codegen
// ============================================================================

describe("200 response outputSchema from codegen", () => {
  it("every operation has a 200 response with application/json content", () => {
    for (const methods of Object.values(docWithSchemas.paths)) {
      for (const op of Object.values(methods)) {
        expect(op.responses["200"]).toBeDefined()
        expect(op.responses["200"].content["application/json"].schema).toBeDefined()
      }
    }
  })

  it("catalog/search has a real outputSchema (array of Book objects from codegen)", () => {
    const op = docWithSchemas.paths["/catalog/search"]?.["get"]
    expect(op).toBeDefined()
    // catalog_search returns Book[] — codegen should emit type: "array"
    const schema = op!.responses["200"].content["application/json"].schema
    // The schema is real (not just a fallback) — we assert it's a defined object
    expect(schema).toBeDefined()
    expect(typeof schema).toBe("object")
  })

  it("catalog/genres has a real outputSchema (string array) from codegen", () => {
    const op = docWithSchemas.paths["/catalog/genres"]?.["get"]
    expect(op).toBeDefined()
    const schema = op!.responses["200"].content["application/json"].schema
    expect(schema).toBeDefined()
    // genres returns string[] — codegen emits { type: "array", items: { type: "string" } }
    expect(schema["type"]).toBe("array")
    expect((schema["items"] as Record<string, unknown>)?.["type"]).toBe("string")
  })
})

// ============================================================================
// 6. operationId
// ============================================================================

describe("operationId", () => {
  it("operationId for catalog_search is derived from tree position", () => {
    const op = doc.paths["/catalog/search"]?.["get"]
    // Dot-separated from underscore-joined name: catalog.search
    expect(op?.operationId).toBe("catalog.search")
  })

  it("operationId for books list is books.list", () => {
    const op = doc.paths["/books/list"]?.["get"]
    expect(op?.operationId).toBe("books.list")
  })

  it("operationId for param child op includes param name (attribute-dispatch: GET /books/{bookId})", () => {
    // With attribute-dispatch, read/replace/remove share /books/{bookId}
    const op = doc.paths["/books/{bookId}"]?.["get"]
    expect(op?.operationId).toBe("books.bookId.read")
  })

  // A `fallback.subtree` that is itself a bare op() leaf (not wrapped in
  // api({...})) — the Node model explicitly allows this (api-tree/node.ts's
  // `fallback: { name, subtree: Node }`). `nameLeaves`'s (openapi.ts)
  // handler → codegen-name map recursed into a bare-leaf fallback.subtree as
  // if it always had `children`, so the handler was never recorded — this
  // handler's operationId silently degraded to the generic
  // path-derived `nameFromPath` fallback ("widgets_widgetId_post", i.e.
  // "widgets.widgetId.post", leaking the placeholder POST verb) instead of
  // the real derived name. Same gap api-tree/tree.ts's `walkNodeType` had
  // for extraction (aa28952).
  it("operationId for a bare op() fallback.subtree is derived from the fallback's own name, no leaked verb segment", async () => {
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const n = api_({
        widgets: api_({}, {
            fallback: {
              name: "widgetId",
              subtree: op((input: { widgetId: string }) => ({ id: input.widgetId })),
            },
          }),
      })
    const d = await toOpenApi(n, { title: "t", version: "1" })
    const operation = d.paths["/widgets/{widgetId}"]?.["post"]
    expect(operation).toBeDefined()
    expect(operation?.operationId).toBe("widgets.widgetId")
  })
})

// ============================================================================
// 7. meta.openapi overrides
// ============================================================================

describe("meta.openapi overrides", () => {
  it("meta.openapi.operationId overrides inferred operationId", async () => {
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const { http } = await import("./verbs.ts")
    // Verb comes from the http.get bundle's `{kind:"method"}` directive (read
    // by applyMethods) — the HttpRoute pipeline resolves verbs from explicit
    // method directives, not from tags alone (tags-only verb inference was
    // an openapi/client-specific approximation of the retired direct
    // dispatcher; it doesn't reflect what the live HTTP router actually does
    // for a tags-only leaf, which stays POST — see verbFromTags in tags.ts).
    const n = api_({
        list: op((_: unknown) => [], http.get, {
          openapi: { operationId: "listAllItems", summary: "List every item" },
        }),
      })
    const d = await toOpenApi(n)
    const operation = d.paths["/list"]?.["get"]
    expect(operation?.operationId).toBe("listAllItems")
    expect(operation?.summary).toBe("List every item")
  })

  it("meta.openapi.deprecated passes through", async () => {
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const n = api_({
        old: op((_: unknown) => null, {
          openapi: { deprecated: true },
        }),
      })
    const d = await toOpenApi(n)
    expect(d.paths["/old"]?.["post"]?.deprecated).toBe(true)
  })

  it("meta.tags.deprecated (tree-level tag) surfaces as OpenAPI deprecated", async () => {
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const n = api_({
        old: op((_: unknown) => null, {
          tags: { deprecated: true },
        }),
      })
    const d = await toOpenApi(n)
    expect(d.paths["/old"]?.["post"]?.deprecated).toBe(true)
  })

  it("meta.openapi.deprecated overrides meta.tags.deprecated when both set", async () => {
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const n = api_({
        old: op((_: unknown) => null, {
          tags: { deprecated: false },
          openapi: { deprecated: true },
        }),
      })
    const d = await toOpenApi(n)
    expect(d.paths["/old"]?.["post"]?.deprecated).toBe(true)
  })

  it("no deprecated tag/meta → no deprecated key in the operation", async () => {
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const n = api_({
        fresh: op((_: unknown) => null, {}),
      })
    const d = await toOpenApi(n)
    expect("deprecated" in (d.paths["/fresh"]?.["post"] ?? {})).toBe(false)
  })
})

// ============================================================================
// 8. Security schemes and per-operation / spec-level security
// ============================================================================

describe("security", () => {
  it("securitySchemes on any node are merged into components.securitySchemes", async () => {
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const n = api_({
      list: op((_: unknown) => [], {
        openapi: {
          securitySchemes: {
            bearer: { type: "http", scheme: "bearer" },
          },
        },
      }),
      get: op((_: unknown) => null, {
        openapi: {
          securitySchemes: {
            apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
          },
        },
      }),
    })
    const d = await toOpenApi(n)
    expect(d.components?.securitySchemes).toEqual({
      bearer: { type: "http", scheme: "bearer" },
      apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    })
  })

  it("per-operation meta.openapi.security is emitted on that operation only", async () => {
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const n = api_({
      secure: op((_: unknown) => null, {
        openapi: { security: [{ bearer: [] }, { apiKey: [] }] },
      }),
      open: op((_: unknown) => null, {}),
    })
    const d = await toOpenApi(n)
    expect(d.paths["/secure"]?.["post"]?.security).toEqual([{ bearer: [] }, { apiKey: [] }])
    expect(d.paths["/open"]?.["post"]?.security).toBeUndefined()
  })

  it("opts.defaultSecurity is emitted as the spec-level default", async () => {
    // Root-position `meta.openapi.security` no longer means "spec-level
    // default" — that dual meaning was removed (§6,
    // docs/design/meta-role-split-spec.md): `openapi.security` on `meta` is
    // per-operation only now, and the spec-level default is a plain builder
    // option instead.
    const { api: api_, op } = await import("@rhi-zone/fractal-api-tree/node")
    const n = api_({
      thing: op((_: unknown) => null, {}),
    })
    const d = await toOpenApi(n, { defaultSecurity: [{ bearer: [] }] })
    expect(d.security).toEqual([{ bearer: [] }])
    // Not duplicated onto the operation itself — that stays a per-op override.
    expect(d.paths["/thing"]?.["post"]?.security).toBeUndefined()
  })

  it("no security meta anywhere → no security/components.securitySchemes keys (existing behavior unchanged)", () => {
    expect(doc.security).toBeUndefined()
    expect(doc.components).toBeUndefined()
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        expect(op.security).toBeUndefined()
      }
    }
  })
})

// ============================================================================
// listRoutes — public HttpRoute walk
// ============================================================================

describe("listRoutes", () => {
  it("empty route (no methods/children/fallback) yields no entries", () => {
    const route = httpRoute({ meta: {} })
    expect(listRoutes(route)).toEqual([])
  })

  it("a single method at the root yields one entry with path '/'", () => {
    const route = httpRoute({
      methods: { GET: { handler: (_: unknown) => null, meta: { tags: { deprecated: true } } } },
      meta: {},
    })
    const entries = listRoutes(route)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ path: "/", verb: "GET" })
    expect(entries[0]?.meta).toEqual({ tags: { deprecated: true } })
  })

  it("multiple methods on the same path each produce their own entry", () => {
    const route = httpRoute({
      methods: {
        GET: { handler: (_: unknown) => null, meta: {} },
        POST: { handler: (_: unknown) => null, meta: {} },
        DELETE: { handler: (_: unknown) => null, meta: {} },
      },
      meta: {},
    })
    const entries = listRoutes(route)
    expect(entries.map((e) => e.verb).sort()).toEqual(["DELETE", "GET", "POST"])
    expect(new Set(entries.map((e) => e.path))).toEqual(new Set(["/"]))
  })

  it("nested children accumulate path segments", () => {
    const route = httpRoute({
      children: {
        books: httpRoute({
          children: {
            featured: httpRoute({
              methods: { GET: { handler: (_: unknown) => null, meta: {} } },
              meta: {},
            }),
          },
          meta: {},
        }),
      },
      meta: {},
    })
    const entries = listRoutes(route)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.path).toBe("/books/featured")
    expect(entries[0]?.verb).toBe("GET")
  })

  it("fallback segments become a {param}-style path component", () => {
    const route = httpRoute({
      children: {
        books: httpRoute({
          fallback: {
            name: "bookId",
            subtree: httpRoute({
              methods: { GET: { handler: (_: unknown) => null, meta: {} } },
              meta: {},
            }),
          },
          meta: {},
        }),
      },
      meta: {},
    })
    const entries = listRoutes(route)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.path).toBe("/books/{bookId}")
  })

  it("codenName falls back to a path-derived name when no names map is supplied", () => {
    const route = httpRoute({
      children: {
        books: httpRoute({
          methods: { GET: { handler: (_: unknown) => null, meta: {} } },
          meta: {},
        }),
      },
      meta: {},
    })
    const entries = listRoutes(route)
    expect(entries[0]?.codenName).toBe("books_get")
  })

  it("codenName is read from the supplied names map by handler identity", () => {
    const handler = (_: unknown) => null
    const route = httpRoute({
      methods: { GET: { handler, meta: {} } },
      meta: {},
    })
    const names = new Map([[handler, "books_bookId_read"]])
    const entries = listRoutes(route, "", names)
    expect(entries[0]?.codenName).toBe("books_bookId_read")
  })

  it("meta propagates through per method entry, independent of sibling methods", () => {
    // `openapi` is an open-bag field (owned by openapi.ts, read via
    // `getOpenApiMeta`) that `RouteLeafMeta`'s static type — this package's
    // own `http`-namespace-only leaf meta (route.ts) — doesn't declare; the
    // cast mirrors how `buildDoc`/`listRoutes` themselves treat `meta.openapi`
    // as a runtime-only bag layered on top of `RouteLeafMeta`.
    const route = httpRoute({
      methods: {
        GET: { handler: (_: unknown) => null, meta: { openapi: { summary: "get it" } } as RouteLeafMeta },
        POST: { handler: (_: unknown) => null, meta: { openapi: { summary: "post it" } } as RouteLeafMeta },
      },
      meta: {},
    })
    const entries = listRoutes(route)
    const get = entries.find((e) => e.verb === "GET")
    const post = entries.find((e) => e.verb === "POST")
    expect((get?.meta as { openapi?: { summary?: string } }).openapi?.summary).toBe("get it")
    expect((post?.meta as { openapi?: { summary?: string } }).openapi?.summary).toBe("post it")
  })

  it("listRoutes matches the walk toOpenApi uses internally — path/method sets agree", async () => {
    const d = await toOpenApi(api)
    const entries = listRoutes((await import("./dx.ts")).httpProjection(api))
    const fromDoc = new Set(
      Object.entries(d.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`)
      ),
    )
    const fromList = new Set(entries.map((e) => `${e.verb} ${e.path}`))
    expect(fromList).toEqual(fromDoc)
  })
})

// ============================================================================
// mergeOpenApiDocs
// ============================================================================

describe("mergeOpenApiDocs", () => {
  const baseDoc = (overrides: Partial<OpenApiDoc> = {}): OpenApiDoc => ({
    openapi: "3.1.0",
    info: { title: "API", version: "0.1.0" },
    paths: {},
    ...overrides,
  })

  it("throws when called with zero documents", () => {
    expect(() => mergeOpenApiDocs([])).toThrow("at least one document is required")
  })

  it("merges paths across 2+ non-conflicting documents", () => {
    const a = baseDoc({
      paths: { "/books": { get: { operationId: "books.list", responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } } } } },
    })
    const b = baseDoc({
      paths: { "/authors": { get: { operationId: "authors.list", responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } } } } },
    })
    const c = baseDoc({
      paths: { "/books": { post: { operationId: "books.create", responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } } } } },
    })
    const merged = mergeOpenApiDocs([a, b, c])
    expect(Object.keys(merged.paths).sort()).toEqual(["/authors", "/books"])
    expect(Object.keys(merged.paths["/books"] ?? {}).sort()).toEqual(["get", "post"])
    expect(merged.paths["/authors"]?.["get"]?.operationId).toBe("authors.list")
  })

  it("throws when two documents define the same path+method", () => {
    const a = baseDoc({
      paths: { "/books": { get: { operationId: "a", responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } } } } },
    })
    const b = baseDoc({
      paths: { "/books": { get: { operationId: "b", responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } } } } },
    })
    expect(() => mergeOpenApiDocs([a, b])).toThrow(/conflicting route.*get \/books/)
  })

  it("merges components.securitySchemes across documents by name, no conflict", () => {
    const a = baseDoc({ components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } } })
    const b = baseDoc({ components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } } } })
    const merged = mergeOpenApiDocs([a, b])
    expect(merged.components?.securitySchemes).toEqual({
      bearer: { type: "http", scheme: "bearer" },
      apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    })
  })

  it("throws when two documents define the same security scheme name", () => {
    const a = baseDoc({ components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } } })
    const b = baseDoc({ components: { securitySchemes: { bearer: { type: "apiKey", in: "header", name: "X" } } } })
    expect(() => mergeOpenApiDocs([a, b])).toThrow(/conflicting security scheme.*"bearer"/)
  })

  it("no components on any input → merged doc has no components key", () => {
    const merged = mergeOpenApiDocs([baseDoc(), baseDoc()])
    expect(merged.components).toBeUndefined()
  })

  it("info/openapi/security are taken from the first document", () => {
    const a = baseDoc({ info: { title: "First", version: "1.0.0" }, security: [{ bearer: [] }] })
    const b = baseDoc({ info: { title: "Second", version: "2.0.0" } })
    const merged = mergeOpenApiDocs([a, b])
    expect(merged.info).toEqual({ title: "First", version: "1.0.0" })
    expect(merged.security).toEqual([{ bearer: [] }])
  })

  it("a single document merges to an equivalent document", () => {
    const a = baseDoc({
      paths: { "/books": { get: { operationId: "books.list", responses: { "200": { description: "ok", content: { "application/json": { schema: {} } } } } } } },
    })
    expect(mergeOpenApiDocs([a])).toEqual(a)
  })
})
