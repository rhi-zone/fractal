// packages/api-tree/src/cache.test.ts — content-addressed build cache tests
//
// Covers checkCache/writeCacheMetadata (cache.ts) via build.ts's
// `writeValidatorModuleCached`/schema-build.ts's `writeSchemaModuleCached`
// wrappers end-to-end against a real fixture entry file (so "touching a
// dependency the extractor reads, not just the entry file" is proven
// against genuine multi-file extraction, not a synthetic closure list).

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { writeValidatorModuleCached } from "./build.ts"
import { writeSchemaModuleCached } from "./schema-build.ts"
import { checkCache } from "./cache.ts"

const FIXTURE = `${import.meta.dir}/__fixtures__/tree.fixture.ts`
const DEP_FIXTURE = `${import.meta.dir}/__fixtures__/result-reexport.fixture.ts`

const TMP_DIR = `${import.meta.dir}/__fixtures__/.cache-test-tmp`

function freshOutFile(name: string): string {
  return path.join(TMP_DIR, name)
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true })
})

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe("cache.ts — content-addressed incremental build cache", () => {
  it("first build is a miss (no cache metadata yet); rebuilding immediately after is a hit", async () => {
    const outFile = freshOutFile("v1.ts")

    const first = await writeValidatorModuleCached(FIXTURE, outFile)
    expect(first.status).toBe("built")
    expect(fs.existsSync(outFile)).toBe(true)
    expect(fs.existsSync(`${outFile}.cache.json`)).toBe(true)

    const second = await writeValidatorModuleCached(FIXTURE, outFile)
    expect(second.status).toBe("hit")

    const check = checkCache(FIXTURE, outFile)
    expect(check.hit).toBe(true)
  })

  it("touching a DEPENDENCY the extractor reads (not the entry file itself) invalidates the cache", async () => {
    const outFile = freshOutFile("v2.ts")
    await writeValidatorModuleCached(FIXTURE, outFile)
    expect((await writeValidatorModuleCached(FIXTURE, outFile)).status).toBe("hit")

    // Touch result-reexport.fixture.ts — a real transitive dependency of
    // tree.fixture.ts's `ResultFromBarrel` import — via a content change,
    // reverted in `finally` so the fixture stays clean for other tests.
    const original = fs.readFileSync(DEP_FIXTURE, "utf8")
    try {
      fs.writeFileSync(DEP_FIXTURE, `${original}\n// cache-test perturbation\n`)
      const check = checkCache(FIXTURE, outFile)
      expect(check.hit).toBe(false)
      if (!check.hit) expect(check.reason).toContain("result-reexport.fixture.ts")

      const rebuilt = await writeValidatorModuleCached(FIXTURE, outFile)
      expect(rebuilt.status).toBe("built")
    } finally {
      fs.writeFileSync(DEP_FIXTURE, original)
    }
  })

  it("editing the entry file itself invalidates the cache", async () => {
    const outFile = freshOutFile("v3.ts")
    // A throwaway copy of the fixture, with its relative imports rewritten
    // to still resolve from the copy's new (tmp) location, so it extracts
    // cleanly and can safely be edited without touching the real fixture.
    const entryCopy = freshOutFile("entry.fixture.ts")
    const rewritten = fs
      .readFileSync(FIXTURE, "utf8")
      .replaceAll("./result-reexport.fixture.ts", path.relative(TMP_DIR, DEP_FIXTURE))
      .replaceAll(
        "./deployment-meta.fixture.ts",
        path.relative(TMP_DIR, `${import.meta.dir}/__fixtures__/deployment-meta.fixture.ts`),
      )
      .replaceAll('"../node.ts"', `"${path.relative(TMP_DIR, `${import.meta.dir}/node.ts`)}"`)
      .replaceAll('"../index.ts"', `"${path.relative(TMP_DIR, `${import.meta.dir}/index.ts`)}"`)
    fs.writeFileSync(entryCopy, rewritten)

    await writeValidatorModuleCached(entryCopy, outFile)
    expect((await writeValidatorModuleCached(entryCopy, outFile)).status).toBe("hit")

    fs.appendFileSync(entryCopy, "\n// entry-file perturbation\n")
    const check = checkCache(entryCopy, outFile)
    expect(check.hit).toBe(false)
    expect((await writeValidatorModuleCached(entryCopy, outFile)).status).toBe("built")
  })

  it("force bypasses the cache unconditionally, even on a hit", async () => {
    const outFile = freshOutFile("v4.ts")
    await writeValidatorModuleCached(FIXTURE, outFile)
    expect((await writeValidatorModuleCached(FIXTURE, outFile)).status).toBe("hit")
    expect((await writeValidatorModuleCached(FIXTURE, outFile, { force: true })).status).toBe("built")
  })

  it("hand-editing the output file invalidates the cache even though no input changed", async () => {
    const outFile = freshOutFile("v5.ts")
    await writeValidatorModuleCached(FIXTURE, outFile)
    fs.appendFileSync(outFile, "\n// hand edit\n")
    const check = checkCache(FIXTURE, outFile)
    expect(check.hit).toBe(false)
    if (!check.hit) expect(check.reason).toContain("output file changed")
  })

  it("cacheFile/cacheDir options relocate cache metadata away from the default <output>.cache.json sibling", async () => {
    const outFile = freshOutFile("v6.ts")
    const cacheDir = freshOutFile("cache-pool")
    const outcome = await writeValidatorModuleCached(FIXTURE, outFile, { cacheDir })
    expect(outcome.status).toBe("built")
    expect(fs.existsSync(`${outFile}.cache.json`)).toBe(false)
    expect(fs.existsSync(path.join(cacheDir, `${path.basename(outFile)}.cache.json`))).toBe(true)
    expect((await writeValidatorModuleCached(FIXTURE, outFile, { cacheDir })).status).toBe("hit")
  })

  it("schema-build.ts's writeSchemaModuleCached uses the SAME cache contract, independently of the validator module's cache entry", async () => {
    const validatorOut = freshOutFile("v7.validators.ts")
    const schemaOut = freshOutFile("v7.schemas.ts")

    expect((await writeSchemaModuleCached(FIXTURE, schemaOut)).status).toBe("built")
    expect((await writeSchemaModuleCached(FIXTURE, schemaOut)).status).toBe("hit")

    // Building the validator module for the same entry doesn't touch the
    // schema artifact's cache entry (separate outFile, separate metadata).
    expect((await writeValidatorModuleCached(FIXTURE, validatorOut)).status).toBe("built")
    expect((await writeSchemaModuleCached(FIXTURE, schemaOut)).status).toBe("hit")

    const source = fs.readFileSync(schemaOut, "utf8")
    expect(source).toContain("export const schemas")
    expect(source).toContain("namedType_search")
  })
})
