import { describe, expect, it } from "bun:test"
import { verbFromTags } from "./tags.ts"
import type { Meta } from "@rhi-zone/fractal-api-tree/node"

// These tests deliberately feed malformed `meta.http` shapes (wrong type
// for `http` itself, `directives` not an array, a directive `value` that
// isn't a string) to verify verbFromTags's runtime defensive parsing still
// degrades gracefully — the shape is invalid ON PURPOSE, so it's built as
// `unknown` and cast, bypassing the compile-time `HttpMeta` shape that
// declaration merging now gives `meta.http` (see node.ts / project.ts).
function malformed(meta: unknown): Meta {
  return meta as Meta
}

describe("verbFromTags — tag lattice dispatch", () => {
  it("no tags, no directives → POST", () => {
    expect(verbFromTags({})).toBe("POST")
  })

  it("readOnly = true → GET", () => {
    expect(verbFromTags({ tags: { readOnly: true } })).toBe("GET")
  })

  it("idempotent = true, destructive = true → DELETE", () => {
    expect(verbFromTags({ tags: { idempotent: true, destructive: true } })).toBe("DELETE")
  })

  it("idempotent = true, destructive unset → PUT", () => {
    expect(verbFromTags({ tags: { idempotent: true } })).toBe("PUT")
  })

  it("idempotent = true, destructive = false → PUT", () => {
    expect(verbFromTags({ tags: { idempotent: true, destructive: false } })).toBe("PUT")
  })

  it("readOnly = false, no other tags → POST", () => {
    expect(verbFromTags({ tags: { readOnly: false } })).toBe("POST")
  })
})

describe("verbFromTags — meta.http verb directive", () => {
  it("overrides tags entirely", () => {
    expect(
      verbFromTags({
        tags: { readOnly: true },
        http: { directives: [{ kind: "verb", value: "PATCH" }] },
      }),
    ).toBe("PATCH")
  })

  it("is uppercased", () => {
    expect(verbFromTags({ http: { directives: [{ kind: "verb", value: "patch" }] } })).toBe("PATCH")
  })

  it("meta.http not an object → falls through to tags", () => {
    expect(verbFromTags(malformed({ tags: { readOnly: true }, http: "GET" }))).toBe("GET")
  })

  it("meta.http.directives not an array → falls through to tags", () => {
    expect(
      verbFromTags(malformed({ tags: { readOnly: true }, http: { directives: "verb" } })),
    ).toBe("GET")
  })

  it("verb directive with non-string value → ignored, falls through to tags", () => {
    expect(
      verbFromTags(malformed({
        tags: { readOnly: true },
        http: { directives: [{ kind: "verb", value: 123 }] },
      })),
    ).toBe("GET")
  })
})
