// packages/graphql-api-projector/src/codegen.test.ts — generateGraphQLClient tests
//
// Three kinds of coverage, mirroring http-api-projector/src/codegen.test.ts:
//   1. Structural: assert the generated source string contains the expected
//      type/document/client shapes for a tree exercising nested Query
//      namespaces, a flat Mutation, fallback capture, and mixed operation
//      types (query/mutation) — the exact same fixture client.test.ts uses,
//      so a change to either client is exercised against a known-good shape.
//   2. Degrade: no `types`/`namedTypes` supplied still produces a complete,
//      syntactically valid (untyped) client.
//   3. Eval (end-to-end): write the generated source to a temp file, import
//      it as a real module, and drive its `createClient` against a real
//      `createGraphQLServer` built from the SAME tree/types — proving the
//      emitted code is not just plausible-looking text but an actually-typed,
//      actually-working client.

import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node"
import { t, types } from "@rhi-zone/fractal-type-ir"
import { generateGraphQLClient } from "./codegen.ts"
import { createGraphQLServer } from "./server.ts"
import type { FieldTypeMap } from "./project.ts"

// ============================================================================
// Fixture — identical to client.test.ts's: nested Query branch (with a
// fallback for slug-captured args), a flat Mutation, and a root-level scalar
// Query leaf.
// ============================================================================

const tree = api_({
  users: api_(
    {
      get: op((input: { id: string }) => ({ id: input.id, name: "Alice" }), { tags: { readOnly: true } }),
      admin: api_({
        settings: op((_: unknown) => ({ theme: "dark" }), { tags: { readOnly: true } }),
      }),
    },
    {
      fallback: {
        name: "userId",
        subtree: api_({
          profile: op((input: { userId: string }) => ({ id: input.userId, bio: "hello" }), {
            tags: { readOnly: true },
          }),
          rename: op((input: { userId: string; name: string }) => ({ id: input.userId, name: input.name })),
        }),
      },
    },
  ),
  createUser: op((input: { name: string }) => ({ id: "1", name: input.name })),
  ping: op((_: unknown) => "pong", { tags: { readOnly: true } }),
})

const typesMap: FieldTypeMap = {
  users_get: { input: t(types.object({ id: t(types.string) })), output: t(types.ref("User")) },
  users_admin_settings: { output: t(types.ref("Settings")) },
  users_userId_profile: { output: t(types.ref("Profile")) },
  users_userId_rename: {
    input: t(types.object({ userId: t(types.string), name: t(types.string) })),
    output: t(types.ref("User")),
  },
  createUser: { input: t(types.object({ name: t(types.string) })), output: t(types.ref("User")) },
}

const namedTypes = {
  User: t(types.object({ id: t(types.string), name: t(types.string) }), { typeName: "User" }),
  Settings: t(types.object({ theme: t(types.string) }), { typeName: "Settings" }),
  Profile: t(types.object({ id: t(types.string), bio: t(types.string) }), { typeName: "Profile" }),
}

const source = generateGraphQLClient(tree, { types: typesMap, namedTypes, clientName: "Client" })

// ============================================================================
// 1. Structural assertions
// ============================================================================

describe("generateGraphQLClient — structure", () => {
  it("emits no imports (standalone)", () => {
    expect(source).not.toMatch(/^\s*import /m)
  })

  it("emits Input/Output type aliases named from the underscore-joined lookup key", () => {
    expect(source).toContain("export type UsersGetInput")
    expect(source).toContain("export type UsersGetOutput")
    expect(source).toContain("export type UsersAdminSettingsOutput")
    expect(source).toContain("export type CreateUserInput")
    expect(source).toContain("export type CreateUserOutput")
  })

  it("UsersGetInput reflects the declared object shape", () => {
    expect(source).toMatch(/UsersGetInput = \{ id: string \}/)
  })

  it("two-level nested query leaf with no declared args has no Input type", () => {
    expect(source).not.toContain("export type UsersAdminSettingsInput")
  })

  it("a fallback-only leaf (profile: only userId, which is captured) has no Input type", () => {
    expect(source).not.toContain("export type UsersUserIdProfileInput")
  })

  it("rename declares userId+name — fallback-shadowed by a declared arg — still gets a real Input type", () => {
    expect(source).toContain("export type UsersUserIdRenameInput")
    expect(source).toMatch(/UsersUserIdRenameInput = \{ userId: string; name: string \}/)
  })

  it("emits a per-operation document constant", () => {
    expect(source).toMatch(/const UsersGetDocument = "/)
    expect(source).toMatch(/const CreateUserDocument = "/)
    expect(source).toContain("query")
    expect(source).toContain("mutation")
  })

  it("query document nests through the users namespace", () => {
    expect(source).toMatch(/const UsersGetDocument = "[^"]*users \{/)
  })

  it("mutation document is flat (camelCase field name, no namespace nesting)", () => {
    expect(source).toMatch(/const CreateUserDocument = "mutation/)
    expect(source).not.toMatch(/const CreateUserDocument = "[^"]*users \{/)
  })

  it("emits a Client type with a nested users branch and a userId param", () => {
    expect(source).toContain("export type Client")
    expect(source).toMatch(/readonly users: \{/)
    expect(source).toMatch(/readonly userId: \(userId: string\) => \{/)
  })

  it("emits client member call signatures matching hasInput", () => {
    expect(source).toMatch(/readonly get: \(input: UsersGetInput\) => Promise<UsersGetOutput>/)
    expect(source).toMatch(/readonly settings: \(\) => Promise<UsersAdminSettingsOutput>/)
    expect(source).toMatch(/readonly profile: \(\) => Promise<UsersUserIdProfileOutput>/)
    expect(source).toMatch(/readonly rename: \(input: UsersUserIdRenameInput\) => Promise<UsersUserIdRenameOutput>/)
    expect(source).toMatch(/readonly createUser: \(input: CreateUserInput\) => Promise<CreateUserOutput>/)
    expect(source).toMatch(/readonly ping: \(\) => Promise<unknown>/)
  })

  it("emits createClient, GraphQLClientError, and the GraphQLTransport type", () => {
    expect(source).toContain("export function createClient(transport: GraphQLTransport): Client")
    expect(source).toContain("export class GraphQLClientError extends Error")
    expect(source).toContain("export type GraphQLTransport")
  })

  it("respects a custom clientName option", () => {
    const named = generateGraphQLClient(tree, { types: typesMap, namedTypes, clientName: "AppClient" })
    expect(named).toContain("export type AppClient =")
    expect(named).toContain("): AppClient {")
  })
})

// ============================================================================
// 2. Degrade: no types/namedTypes
// ============================================================================

describe("generateGraphQLClient — degraded (no types/namedTypes)", () => {
  it("still produces a complete, valid client with unknown input/output", () => {
    const untyped = generateGraphQLClient(tree)
    expect(untyped).not.toMatch(/^\s*import /m)
    expect(untyped).not.toContain("export type UsersGetInput")
    expect(untyped).not.toContain("export type UsersGetOutput")
    expect(untyped).toMatch(/readonly get: \(\) => Promise<unknown>/)
    expect(untyped).toContain("export function createClient(transport: GraphQLTransport): Client")
  })
})

// ============================================================================
// 3. Eval test — real server, real generated module
// ============================================================================

describe("generateGraphQLClient — eval end-to-end", () => {
  it("generated createClient drives real GraphQL execution against a live server", async () => {
    const server = createGraphQLServer(tree, { types: typesMap, namedTypes })

    const tmpDir = await mkdtemp(join(tmpdir(), "fractal-graphql-codegen-"))
    try {
      const modulePath = join(tmpDir, "client.ts")
      await writeFile(modulePath, source, "utf8")
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        createClient: (transport: unknown) => {
          readonly users: {
            readonly get: (input: { id: string }) => Promise<{ id: string; name: string }>
            readonly admin: { readonly settings: () => Promise<{ theme: string }> }
            readonly userId: (userId: string) => {
              readonly profile: () => Promise<{ id: string; bio: string }>
              readonly rename: (input: { userId: string; name: string }) => Promise<{ id: string; name: string }>
            }
          }
          readonly createUser: (input: { name: string }) => Promise<{ id: string; name: string }>
          readonly ping: () => Promise<unknown>
        }
        GraphQLClientError: new (errors: readonly { message: string }[]) => Error
      }

      const transport = async (query: string, variables?: Record<string, unknown>) => {
        const result = await server.execute(query, variables)
        return { data: result.data, ...(result.errors !== undefined ? { errors: result.errors } : {}) }
      }
      const client = mod.createClient(transport)

      const got = await client.users.get({ id: "42" })
      expect(got).toEqual({ id: "42", name: "Alice" })

      const settings = await client.users.admin.settings()
      expect(settings).toEqual({ theme: "dark" })

      const created = await client.createUser({ name: "Bob" })
      expect(created).toEqual({ id: "1", name: "Bob" })

      const pinged = await client.ping()
      expect(pinged).toBe("pong")

      const sub = client.users.userId("7")
      const profile = await sub.profile()
      expect(profile).toEqual({ id: "7", bio: "hello" })

      const renamed = await sub.rename({ userId: "7", name: "Bobby" })
      expect(renamed).toEqual({ id: "7", name: "Bobby" })
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it("generated GraphQLClientError carries the transport's errors array", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "fractal-graphql-codegen-err-"))
    try {
      const modulePath = join(tmpDir, "client-error.ts")
      await writeFile(modulePath, source, "utf8")
      const mod = (await import(pathToFileURL(modulePath).href)) as {
        createClient: (transport: unknown) => { readonly ping: () => Promise<unknown> }
        GraphQLClientError: new (errors: readonly { message: string }[]) => Error & {
          errors: readonly { message: string }[]
        }
      }

      const transport = async () => ({ errors: [{ message: "boom" }] })
      const client = mod.createClient(transport)

      let caught: unknown
      try {
        await client.ping()
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(mod.GraphQLClientError)
      expect((caught as { errors: readonly { message: string }[] }).errors).toEqual([{ message: "boom" }])
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
