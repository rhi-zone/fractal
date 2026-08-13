// tooling/comment-approval/manifest.test.ts — @rhi-zone/fractal (tooling, not a workspace package)

import { describe, it, expect } from "bun:test"
import { extractComments } from "./comments.ts"
import { approveComments, emptyManifest, isApproved, makeExcerpt, parseManifest, serializeManifest } from "./manifest.ts"

describe("emptyManifest / isApproved", () => {
  it("starts with nothing approved", () => {
    expect(isApproved(emptyManifest(), "deadbeef")).toBe(false)
  })
})

describe("approveComments", () => {
  it("adds every comment's hash", async () => {
    const comments = await extractComments("// a\nconst x = 1 // b\n")
    const manifest = approveComments(emptyManifest(), comments)
    for (const c of comments) expect(isApproved(manifest, c.hash)).toBe(true)
  })

  it("does not disturb hashes approved in an earlier call", async () => {
    const first = await extractComments("// keep me\n")
    const second = await extractComments("// also keep me\n")
    let manifest = approveComments(emptyManifest(), first)
    manifest = approveComments(manifest, second)
    expect(isApproved(manifest, first[0]!.hash)).toBe(true)
    expect(isApproved(manifest, second[0]!.hash)).toBe(true)
  })

  it("re-approving an already-approved hash is a no-op on membership", async () => {
    const comments = await extractComments("// once\n")
    let manifest = approveComments(emptyManifest(), comments)
    manifest = approveComments(manifest, comments)
    expect(Object.keys(manifest.approved)).toHaveLength(1)
  })
})

describe("serializeManifest / parseManifest round-trip", () => {
  it("round-trips", async () => {
    const comments = await extractComments("// one\nconst x = 1 // two\n")
    const manifest = approveComments(emptyManifest(), comments)
    const parsed = parseManifest(serializeManifest(manifest))
    expect(Object.keys(parsed.approved).sort()).toEqual(Object.keys(manifest.approved).sort())
  })

  it("serializes with sorted keys, so re-serializing an unchanged manifest is byte-identical", async () => {
    const comments = await extractComments("// zzz\nconst x = 1 // aaa\nconst y = 2 // mmm\n")
    const manifest = approveComments(emptyManifest(), comments)
    const first = serializeManifest(manifest)
    const second = serializeManifest(parseManifest(first))
    expect(first).toBe(second)
  })

  it("rejects a malformed manifest", () => {
    expect(() => parseManifest("null")).toThrow()
    expect(() => parseManifest('{"approved": "not an object"}')).toThrow()
  })
})

describe("makeExcerpt", () => {
  it("takes the first line only", () => {
    expect(makeExcerpt("first\nsecond")).toBe("first")
  })

  it("truncates long lines", () => {
    const long = "x".repeat(200)
    expect(makeExcerpt(long).length).toBeLessThan(long.length)
  })
})
