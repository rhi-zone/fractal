// tooling/comment-approval/comments.test.ts — @rhi-zone/fractal (tooling, not a workspace package)
//
// Extraction/normalization/hashing correctness — the load-bearing logic the
// hook, CI check, and approve command all sit on top of. Filesystem/git
// plumbing (cli.ts) is exercised separately, if at all, since it's thin
// glue over these functions.

import { describe, it, expect } from "bun:test"
import { extractComments, normalizeComment, hashText, isSourceFile } from "./comments.ts"

describe("isSourceFile", () => {
  it("accepts JS/TS family extensions", () => {
    for (const f of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mts", "a.cts", "a.mjs", "a.cjs"]) {
      expect(isSourceFile(f)).toBe(true)
    }
  })

  it("rejects everything else", () => {
    for (const f of ["a.md", "a.json", "a.sh", "a.py", "README"]) {
      expect(isSourceFile(f)).toBe(false)
    }
  })
})

describe("extractComments — line comments", () => {
  it("extracts a simple line comment", async () => {
    const comments = await extractComments("const x = 1 // hello\n")
    expect(comments).toHaveLength(1)
    expect(comments[0]!.kind).toBe("line")
    expect(comments[0]!.raw).toBe("// hello")
    expect(comments[0]!.normalized).toBe("hello")
  })

  it("does not treat a string containing // as a comment", async () => {
    const comments = await extractComments('const url = "http://example.com"\n')
    expect(comments).toHaveLength(0)
  })

  it("does not treat // inside a template literal as a comment", async () => {
    const comments = await extractComments("const s = `see // not a comment here`\n")
    expect(comments).toHaveLength(0)
  })

  it("reports 1-based line numbers", async () => {
    const comments = await extractComments("const a = 1\nconst b = 2 // second line\n")
    expect(comments[0]!.line).toBe(2)
  })
})

describe("extractComments — block comments", () => {
  it("extracts a simple block comment", async () => {
    const comments = await extractComments("/* hello */\nconst x = 1\n")
    expect(comments).toHaveLength(1)
    expect(comments[0]!.kind).toBe("block")
    expect(comments[0]!.normalized).toBe("hello")
  })

  it("does not treat /* inside a regex literal as a comment start", async () => {
    const comments = await extractComments("const re = /a\\/*b/\n")
    expect(comments).toHaveLength(0)
  })

  it("extracts JSDoc-style block comments with leading * decoration stripped", async () => {
    const src = "/**\n * Does the thing.\n * @param x the input\n */\nfunction f(x) {}\n"
    const comments = await extractComments(src)
    expect(comments).toHaveLength(1)
    expect(comments[0]!.normalized).toBe("Does the thing.\n@param x the input")
  })

  it("ignores shebang lines (not a comment)", async () => {
    const comments = await extractComments("#!/usr/bin/env bun\nconst x = 1 // real comment\n")
    expect(comments).toHaveLength(1)
    expect(comments[0]!.normalized).toBe("real comment")
  })
})

describe("normalizeComment — position/formatting independence", () => {
  it("strips delimiters", () => {
    expect(normalizeComment("// hi", "line")).toBe("hi")
    expect(normalizeComment("/* hi */", "block")).toBe("hi")
  })

  it("is stable across JSDoc reindentation", () => {
    const a = normalizeComment("/**\n * hello\n * world\n */", "block")
    const b = normalizeComment("/**\n   * hello\n   * world\n   */", "block")
    expect(a).toBe(b)
    expect(a).toBe("hello\nworld")
  })

  it("trims leading/trailing blank lines but keeps internal ones", () => {
    const normalized = normalizeComment("/*\n\n first\n\n second\n\n*/", "block")
    expect(normalized).toBe("first\n\nsecond")
  })

  it("treats a reworded comment as different content", () => {
    const a = normalizeComment("// the cache is invalidated on write", "line")
    const b = normalizeComment("// the cache is invalidated on read", "line")
    expect(a).not.toBe(b)
  })
})

describe("hashText — content identity, not position", () => {
  it("is deterministic", async () => {
    const h1 = await hashText("hello")
    const h2 = await hashText("hello")
    expect(h1).toBe(h2)
  })

  it("differs for different content", async () => {
    const h1 = await hashText("hello")
    const h2 = await hashText("goodbye")
    expect(h1).not.toBe(h2)
  })

  it("same comment hashes identically whether it's line 1 or line 100 (moving a comment doesn't change its hash)", async () => {
    const early = await extractComments("// stable note\nconst a = 1\n")
    const late = await extractComments("const a = 1\nconst b = 2\nconst c = 3\n// stable note\n")
    expect(early[0]!.hash).toBe(late[0]!.hash)
  })

  it("a comment edited in place changes hash even though its position didn't move", async () => {
    const before = await extractComments("// original wording\nconst a = 1\n")
    const after = await extractComments("// changed wording\nconst a = 1\n")
    expect(before[0]!.hash).not.toBe(after[0]!.hash)
  })
})

describe("extractComments — grouping consecutive line comments into one logical comment", () => {
  it("merges a same-indentation multi-line // paragraph into one comment", async () => {
    const src = "// first sentence.\n// second sentence.\n// third sentence.\nconst x = 1\n"
    const comments = await extractComments(src)
    expect(comments).toHaveLength(1)
    expect(comments[0]!.normalized).toBe("first sentence.\nsecond sentence.\nthird sentence.")
  })

  it("does not merge across a blank line", async () => {
    const src = "// paragraph one.\n\n// paragraph two.\nconst x = 1\n"
    const comments = await extractComments(src)
    expect(comments).toHaveLength(2)
  })

  it("does not merge across an intervening code line", async () => {
    const src = "// note about a\nconst a = 1\n// note about b\nconst b = 2\n"
    const comments = await extractComments(src)
    expect(comments).toHaveLength(2)
    expect(comments[0]!.normalized).toBe("note about a")
    expect(comments[1]!.normalized).toBe("note about b")
  })

  it("does not merge a trailing same-line comment into a following standalone paragraph at a different column", async () => {
    const src = "const x = 1 // trailing note\n// standalone paragraph start\n// standalone paragraph continues\n"
    const comments = await extractComments(src)
    expect(comments).toHaveLength(2)
    expect(comments[0]!.normalized).toBe("trailing note")
    expect(comments[1]!.normalized).toBe("standalone paragraph start\nstandalone paragraph continues")
  })

  it("merging is content-hash-stable under reindentation of the whole block", async () => {
    const a = await extractComments("// one\n// two\nconst x = 1\n")
    const b = await extractComments("  // one\n  // two\n  const x = 1\n")
    expect(a[0]!.hash).toBe(b[0]!.hash)
  })

  it("editing one line of a merged paragraph changes the group's hash", async () => {
    const a = await extractComments("// one\n// two\nconst x = 1\n")
    const b = await extractComments("// one\n// TWO CHANGED\nconst x = 1\n")
    expect(a[0]!.hash).not.toBe(b[0]!.hash)
  })

  it("does not merge block comments with adjacent line comments", async () => {
    const src = "/* block */\n// line\nconst x = 1\n"
    const comments = await extractComments(src)
    expect(comments).toHaveLength(2)
  })
})

describe("extractComments — multiple comments in source order", () => {
  it("returns comments in the order they appear", async () => {
    const src = "// first\nconst a = 1 /* second */\nconst b = 2\n// third\n"
    const comments = await extractComments(src)
    expect(comments.map((c) => c.normalized)).toEqual(["first", "second", "third"])
  })
})
