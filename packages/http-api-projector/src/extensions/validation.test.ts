// packages/http-api-projector/src/extensions/validation.test.ts — @rhi-zone/fractal-http-api-projector
//
// Coverage, mirroring streaming.test.ts's own split:
//   1. Unit: `validation()`'s `decodeResponse` against hand-built JSON
//      `Response`s + a `DecodeContext.codegenName` — throw/warn/strip modes,
//      and the "no schema known" no-op fallthrough.
//   2. Runtime integration: `createClient(node, ...)` + `createFetch`
//      (in-process, no network) — proves `DecodeContext.codegenName`
//      actually threads through from the real `Node` tree walk.
//   3. Codegen: structural (emitted `__SCHEMA_*`/`__validate` source) and
//      eval end-to-end (real Bun server + a real generated module).

import { afterAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import type { SchemaMap } from "@rhi-zone/fractal-api-tree/tree"
import type { JsonSchema } from "@rhi-zone/fractal-api-tree/extract"
import { createClient } from "../client.ts"
import { createFetch } from "../preset.ts"
import { generateClientFromNode } from "../codegen.ts"
import { serveBun } from "../adapter.ts"
import { ValidationError, validation } from "./validation.ts"
import type { DecodeContext } from "../extension.ts"

const BOOK_SCHEMA: JsonSchema = {
  type: "object",
  properties: { title: { type: "string" }, pages: { type: "number" } },
  required: ["title", "pages"],
}

const schemas: SchemaMap = {
  book: { inputSchema: {}, outputSchema: BOOK_SCHEMA },
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

function ctxFor(codegenName: string | undefined): DecodeContext {
  return { request: new Request("http://localhost/"), refetch: async () => new Response(), meta: {}, codegenName }
}

// ============================================================================
// 1. Unit — decodeResponse against hand-built responses
// ============================================================================

describe("validation() — decodeResponse (unit)", () => {
  it("passes a valid response through unchanged", async () => {
    const ext = validation({ schemas })
    const decoded = ext.decodeResponse?.(jsonResponse({ title: "Dune", pages: 412 }), ctxFor("book"))
    expect(decoded).toBeDefined()
    await expect(decoded?.value).resolves.toEqual({ title: "Dune", pages: 412 })
  })

  it("throws ValidationError (default mode) for a missing required field", async () => {
    const ext = validation({ schemas })
    const decoded = ext.decodeResponse?.(jsonResponse({ title: "Dune" }), ctxFor("book"))
    await expect(decoded?.value).rejects.toBeInstanceOf(ValidationError)
  })

  it("ValidationError carries per-field details", async () => {
    const ext = validation({ schemas })
    const decoded = ext.decodeResponse?.(jsonResponse({ title: 123, pages: "many" }), ctxFor("book"))
    const err = (await Promise.resolve(decoded?.value).catch((e: unknown) => e)) as ValidationError
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.details.some((d) => d.includes("title"))).toBe(true)
    expect(err.details.some((d) => d.includes("pages"))).toBe(true)
    expect(err.codegenName).toBe("book")
  })

  it("'warn' mode logs and returns the body unchanged instead of throwing", async () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      const ext = validation({ schemas, mode: "warn" })
      const decoded = ext.decodeResponse?.(jsonResponse({ title: "Dune" }), ctxFor("book"))
      await expect(decoded?.value).resolves.toEqual({ title: "Dune" })
      expect(warnings.length).toBe(1)
    } finally {
      console.warn = originalWarn
    }
  })

  it("'strip' mode removes fields not in the schema, then validates what remains", async () => {
    const ext = validation({ schemas, mode: "strip" })
    const decoded = ext.decodeResponse?.(
      jsonResponse({ title: "Dune", pages: 412, extra: "unexpected" }),
      ctxFor("book"),
    )
    await expect(decoded?.value).resolves.toEqual({ title: "Dune", pages: 412 })
  })

  it("'strip' mode still throws when a required field is missing after stripping", async () => {
    const ext = validation({ schemas, mode: "strip" })
    const decoded = ext.decodeResponse?.(jsonResponse({ title: "Dune", extra: "x" }), ctxFor("book"))
    await expect(decoded?.value).rejects.toBeInstanceOf(ValidationError)
  })

  it("falls through (undefined) when codegenName is unknown to the extension", () => {
    const ext = validation({ schemas })
    const decoded = ext.decodeResponse?.(jsonResponse({ title: "Dune", pages: 412 }), ctxFor("nonexistent_op"))
    expect(decoded).toBeUndefined()
  })

  it("falls through (undefined) when no codegenName is available at all", () => {
    const ext = validation({ schemas })
    const decoded = ext.decodeResponse?.(jsonResponse({ title: "Dune", pages: 412 }), ctxFor(undefined))
    expect(decoded).toBeUndefined()
  })

  it("falls through (undefined) for a non-2xx response, leaving error handling to the default/errors() path", () => {
    const ext = validation({ schemas })
    const res = new Response(JSON.stringify({ title: "Dune" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })
    const decoded = ext.decodeResponse?.(res, ctxFor("book"))
    expect(decoded).toBeUndefined()
  })

  it("falls through (undefined) for a non-JSON response", () => {
    const ext = validation({ schemas })
    const res = new Response("plain text", { status: 200 })
    const decoded = ext.decodeResponse?.(res, ctxFor("book"))
    expect(decoded).toBeUndefined()
  })
})

// ============================================================================
// 2. Runtime integration — createClient + createFetch, no network
// ============================================================================

describe("validation() — createClient integration (in-process, no network)", () => {
  function makeTree(returnValue: unknown) {
    return api_({
      book: op((_: unknown) => returnValue, {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
  }

  it("a valid handler response passes through untouched", async () => {
    const tree = makeTree({ title: "Dune", pages: 412 })
    const client = createClient(tree, {
      baseUrl: "http://localhost",
      fetch: createFetch(tree),
      extensions: [validation({ schemas })],
    })
    await expect(client.book()).resolves.toEqual({ title: "Dune", pages: 412 })
  })

  it("an invalid handler response throws ValidationError, DecodeContext.codegenName resolved from the real Node tree", async () => {
    const tree = makeTree({ title: "Dune" }) // missing required "pages"
    const client = createClient(tree, {
      baseUrl: "http://localhost",
      fetch: createFetch(tree),
      extensions: [validation({ schemas })],
    })
    const caught = await client.book().catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(ValidationError)
    expect((caught as ValidationError).codegenName).toBe("book")
  })
})

// ============================================================================
// 3. Codegen — structural + eval end-to-end
// ============================================================================

describe("generateClientFromNode — validation() codegen", () => {
  const tree = api_({
    book: op((_: unknown): { title: string; pages: number } => ({ title: "Dune", pages: 412 }), {
      http: { directives: [{ kind: "method", value: "GET" }] },
    }),
  })

  it("emits no validation helpers when validation() is NOT included", () => {
    const withoutExt = generateClientFromNode(tree, schemas)
    expect(withoutExt).not.toContain("__validate")
    expect(withoutExt).not.toContain("__SCHEMA_")
  })

  it("emits __SCHEMA_ constants, __validate helper, and a wrapped call site", () => {
    const withExt = generateClientFromNode(tree, schemas, { extensions: [validation()] })
    expect(withExt).toContain("const __SCHEMA_book: unknown =")
    expect(withExt).toContain("function __validate(")
    expect(withExt).toContain("export class ValidationError extends ClientError")
    expect(withExt).toMatch(/__request\(.*\)\.then\(\(__v: unknown\) => __validate\(__v, __SCHEMA_book, "throw", "book"\)\)/)
  })

  it("bakes the configured mode into the emitted call site", () => {
    const withExt = generateClientFromNode(tree, schemas, { extensions: [validation({ mode: "warn" })] })
    expect(withExt).toContain('__validate(__v, __SCHEMA_book, "warn", "book")')
  })
})

describe("generateClientFromNode — validation() eval end-to-end against a real server", () => {
  let server: { port: number; stop(closeActiveConnections?: boolean): void } | undefined
  let tmpDir: string | undefined

  afterAll(async () => {
    server?.stop(true)
    if (tmpDir !== undefined) await rm(tmpDir, { recursive: true, force: true })
  })

  it("a generated client throws ValidationError against a real server's malformed response", async () => {
    // Handler is cast to `any` to deliberately return a body that violates
    // its own declared schema (missing "pages") — exercising validation()
    // against a real server round-trip, not just an in-memory Response.
    const badTree = api_({
      book: op((_: unknown): { title: string; pages: number } => ({ title: "Dune" }) as never, {
        http: { directives: [{ kind: "method", value: "GET" }] },
      }),
    })
    const source = generateClientFromNode(badTree, schemas, { extensions: [validation()] })

    const fetchHandler = createFetch(badTree)
    server = serveBun(fetchHandler, { port: 0 })

    tmpDir = await mkdtemp(join(tmpdir(), "fractal-codegen-validation-"))
    const modulePath = join(tmpDir, "client.ts")
    await writeFile(modulePath, source, "utf8")
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      createClient: (baseUrl: string) => { readonly book: () => Promise<unknown> }
      ValidationError: new (...args: unknown[]) => Error & { details: readonly string[] }
    }

    const client = mod.createClient(`http://localhost:${server.port}`)
    const caught = await client.book().catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(mod.ValidationError)
    expect((caught as { details: readonly string[] }).details.some((d) => d.includes("pages"))).toBe(true)
  })
})
