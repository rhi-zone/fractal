// packages/http-api-projector/src/codegen.test.ts — client codegen tests
//
// Three kinds of coverage:
//   1. Structural (Node-driven): assert the generated source string contains
//      the expected type/client shapes for the library-api example tree (the
//      same canonical fixture openapi.test.ts uses), generated via
//      `generateClientFromNode` — this is the path that recovers authored
//      member names (`.read()`/`.replace()`/`.remove()`) and exact
//      `extractToolSchemas` codegen-name matches for co-located routes.
//   2. Structural (HttpRoute-driven): `generateClient(route, schemas)` called
//      directly on an already-projected `HttpRoute`, no `Node` involved —
//      proves the core entry point works standalone and exercises its
//      degraded naming (lowercased verb as member name) when no name maps
//      are available.
//   3. Eval (end-to-end): write the generated source to a temp file, import
//      it as a real module, spin up the library-api tree on a real Bun
//      server, and drive the generated `createClient` against it over HTTP —
//      proving the emitted code is not just plausible-looking text but an
//      actually-typed, actually-working client.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { generateClient, generateClientFromNode } from "./codegen.ts"
import { httpProjection } from "./dx.ts"
import { createFetch } from "./preset.ts"
import { serveBun } from "./adapter.ts"
import { api, clearStore, type Book } from "../../../examples/library-api/src/tree.ts"
import { extractToolSchemas } from "@rhi-zone/fractal-api-tree/tree"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { http } from "./verbs.ts"

const treePath = new URL("../../../examples/library-api/src/tree.ts", import.meta.url).pathname
const schemas = extractToolSchemas(treePath)

let source: string

beforeAll(() => {
  source = generateClientFromNode(api, schemas, { clientName: "Client" })
})

beforeEach(() => {
  clearStore()
})

// ============================================================================
// 1. Structural assertions — generateClientFromNode (Node-driven naming)
// ============================================================================

describe("generateClientFromNode — structure", () => {
  it("emits no imports (standalone)", () => {
    expect(source).not.toMatch(/^\s*import /m)
  })

  it("emits Input/Output type aliases named from the codegen name", () => {
    expect(source).toContain("export type BooksAddInput")
    expect(source).toContain("export type BooksAddOutput")
    expect(source).toContain("export type BooksListOutput")
    expect(source).toContain("export type BooksBookIdReadOutput")
  })

  it("BooksAddInput has the three required book fields", () => {
    expect(source).toMatch(/BooksAddInput = \{[^}]*readonly title: string/s)
    expect(source).toMatch(/BooksAddInput = \{[^}]*readonly author: string/s)
    expect(source).toMatch(/BooksAddInput = \{[^}]*readonly genre: string/s)
  })

  it("read has no Input type — its only field (bookId) is supplied via the path-param call chain", () => {
    expect(source).not.toContain("export type BooksBookIdReadInput")
  })

  it("remove has no Input type — same reasoning as read (bookId-only input)", () => {
    expect(source).not.toContain("export type BooksBookIdRemoveInput")
  })

  it("catalog.search (GET) DOES get an Input type — the GET query-params fix", () => {
    expect(source).toContain("export type CatalogSearchInput")
    expect(source).toMatch(/CatalogSearchInput = \{[^}]*readonly q\?: string/s)
    expect(source).toMatch(/readonly search: \(input: CatalogSearchInput\) => Promise<CatalogSearchOutput>/)
  })

  it("emits a Client type with a nested books branch", () => {
    expect(source).toContain("export type Client")
    expect(source).toMatch(/readonly books: \{/)
  })

  it("emits a bookId param as a function type taking a string", () => {
    expect(source).toMatch(/readonly bookId: \(bookId: string\) => \{/)
  })

  it("emits list/add/read/remove client members with the right call signatures", () => {
    expect(source).toMatch(/readonly list: \(\) => Promise<BooksListOutput>/)
    expect(source).toMatch(/readonly add: \(input: BooksAddInput\) => Promise<BooksAddOutput>/)
    expect(source).toMatch(/readonly read: \(\) => Promise<BooksBookIdReadOutput>/)
    expect(source).toMatch(/readonly remove: \(\) => Promise<BooksBookIdRemoveOutput>/)
  })

  it("emits createClient and ClientError", () => {
    expect(source).toContain("export function createClient(baseUrl: string")
    expect(source).toContain("export class ClientError extends Error")
  })

  it("respects a custom clientName option", () => {
    const named = generateClientFromNode(api, schemas, { clientName: "LibraryClient" })
    expect(named).toContain("export type LibraryClient =")
    expect(named).toContain("): LibraryClient {")
  })

  it("degrades to unknown input/output when no SchemaMap is supplied", () => {
    const untyped = generateClientFromNode(api)
    expect(untyped).not.toContain("export type BooksAddInput")
    expect(untyped).toMatch(/readonly add: \(\) => Promise<unknown>/)
  })
})

// ============================================================================
// 2. Structural assertions — generateClient (HttpRoute-driven, no Node)
// ============================================================================

describe("generateClient — HttpRoute + SchemaMap directly, no Node", () => {
  it("walks a plain HttpRoute tree with no name maps, degrading co-located names to the lowercased verb", () => {
    const tree = api_({
      widgets: api_({
        list: op((_: unknown): { id: string }[] => [], http.get),
      }, { fallback: { name: "widgetId", subtree: api_({
        get: op((input: { widgetId: string }): { id: string } => ({ id: input.widgetId }), http.get, http.moveTo("..")),
      }) } }),
    })
    const route = httpProjection(tree)

    // No SchemaMap: still produces a complete, working (untyped) client.
    const untyped = generateClient(route)
    expect(untyped).not.toMatch(/^\s*import /m)
    expect(untyped).toContain("export function createClient(baseUrl: string")
    expect(untyped).toMatch(/readonly widgets: \{/)
    expect(untyped).toMatch(/readonly widgetId: \(widgetId: string\) => \{/)
    // Co-located single GET at the fallback position has no Node-derived
    // name available, so it degrades to the lowercased verb.
    expect(untyped).toMatch(/readonly get: \(\) => Promise<unknown>/)
  })

  it("types operations from a manually-built SchemaMap keyed by the path-derived codegen name", () => {
    const tree = api_({
      widgets: op((input: { q?: string }): { id: string }[] => [], http.get),
    })
    const route = httpProjection(tree)

    // generateClient's degraded naming (no Node) keys schema lookups as
    // `<path-segments>_<verb>` — see codegen.ts's `nameFromPath`.
    const manualSchemas: SchemaMap = {
      widgets_get: {
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
        outputSchema: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
    }

    const typed = generateClient(route, manualSchemas)
    expect(typed).toContain("export type WidgetsGetInput")
    expect(typed).toContain("export type WidgetsGetOutput")
    expect(typed).toMatch(/WidgetsGetInput = \{[^}]*readonly q\?: string/s)
    expect(typed).toMatch(/readonly widgets: \(input: WidgetsGetInput\) => Promise<WidgetsGetOutput>/)
  })
})

// ============================================================================
// 3. Eval test — real server, real generated module, real HTTP calls
// ============================================================================

describe("generateClientFromNode — eval end-to-end", () => {
  let server: { port: number; stop(closeActiveConnections?: boolean): void } | undefined
  let tmpDir: string | undefined

  afterAll(async () => {
    server?.stop(true)
    if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true })
  })

  it("generated createClient drives real HTTP calls against a live server", async () => {
    // Real server hosting the library-api tree.
    const fetchHandler = createFetch(api, { openapi: false })
    server = serveBun(fetchHandler, { port: 0 })

    // Write the generated module to disk and import it for real.
    tmpDir = await mkdtemp(join(tmpdir(), "fractal-codegen-"))
    const modulePath = join(tmpDir, "client.ts")
    await writeFile(modulePath, source, "utf8")
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      createClient: (baseUrl: string) => {
        readonly books: {
          readonly list: () => Promise<Book[]>
          readonly add: (input: { title: string; author: string; genre: string }) => Promise<Book>
          readonly bookId: (bookId: string) => {
            readonly read: () => Promise<Book>
            readonly remove: () => Promise<{ deleted: boolean }>
          }
        }
        readonly catalog: {
          readonly search: (input: { q?: string }) => Promise<Book[]>
        }
      }
      ClientError: new (status: number, statusText: string, body: unknown) => Error
    }

    const client = mod.createClient(`http://localhost:${server.port}`)

    // add -> list
    const created = await client.books.add({ title: "Codegen Test", author: "Robot", genre: "SciFi" })
    expect(created.title).toBe("Codegen Test")
    expect(typeof created.id).toBe("string")

    const books = await client.books.list()
    expect(books.map((b) => b.title)).toContain("Codegen Test")

    // bookId(...).read()
    const fetched = await client.books.bookId(created.id).read()
    expect(fetched).toEqual(created)

    // catalog.search
    const results = await client.catalog.search({ q: "codegen" })
    expect(results.map((b) => b.id)).toContain(created.id)

    // bookId(...).remove()
    const removed = await client.books.bookId(created.id).remove()
    expect(removed.deleted).toBe(true)

    const booksAfter = await client.books.list()
    expect(booksAfter.find((b) => b.id === created.id)).toBeUndefined()
  })

  it("throws a ClientError with status/statusText/body on a non-2xx response", async () => {
    // server, tmpDir, and the module are already set up by the previous test
    tmpDir ??= await mkdtemp(join(tmpdir(), "fractal-codegen-"))
    const modulePath = join(tmpDir, "client-error.ts")
    await writeFile(modulePath, source, "utf8")
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      createClient: (baseUrl: string) => {
        readonly books: { readonly bookId: (bookId: string) => { readonly read: () => Promise<unknown> } }
      }
      ClientError: new (...args: unknown[]) => Error & { status: number; statusText: string; body: unknown }
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const client = mod.createClient(`http://localhost:${server!.port}`)

    let caught: unknown
    try {
      await client.books.bookId("does-not-exist").read()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(mod.ClientError)
    expect((caught as { status: number }).status).toBe(500)
    expect((caught as { statusText: string }).statusText.length).toBeGreaterThan(0)
    expect((caught as { body: unknown }).body).toBeDefined()
  })
})
