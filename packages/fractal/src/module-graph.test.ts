// packages/fractal/src/module-graph.test.ts
//
// The umbrella's load-bearing property, checked rather than asserted in a
// comment: importing ONE protocol subpath must not drag another protocol's
// runtime into the module graph. `@rhi-zone/fractal/http` pulling in
// graphql-js or the MCP SDK would re-create exactly the bloat that keeps the
// five projectors in five packages (docs/design/decisions.md § "Umbrella
// package @rhi-zone/fractal").
//
// The walk is over the STATIC import graph of the source tree, starting at
// each facade module. `Bun.Transpiler.scanImports` is the parser: it runs the
// real TS transpiler, so `import type` / `export type` edges — which are
// erased and cost nothing at runtime — are correctly absent from its output,
// which a regex over the source text could not tell apart. Workspace
// specifiers are resolved through the target package's own `exports` map (the
// authoritative answer, aliases included) and followed; anything else is an
// external leaf and is recorded, not followed.

import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const PACKAGES_DIR = resolve(import.meta.dir, "../..")
const SCOPE = "@rhi-zone/fractal"

// Protocol runtimes that must stay quarantined behind their own subpath.
const GRAPHQL_RUNTIME = "graphql"
const MCP_RUNTIME = "@modelcontextprotocol/sdk"

const transpiler = new Bun.Transpiler({ loader: "ts" })

/** `@rhi-zone/fractal-http-api-projector/route` -> `[http-api-projector, ./route]` */
function splitWorkspaceSpecifier(spec: string): { dir: string; subpath: string } | undefined {
  if (spec !== SCOPE && !spec.startsWith(`${SCOPE}-`)) return undefined
  const rest = spec === SCOPE ? "" : spec.slice(SCOPE.length + 1)
  const slash = rest.indexOf("/")
  // The umbrella itself is `@rhi-zone/fractal`, whose package dir is `fractal`.
  if (rest === "") return { dir: "fractal", subpath: "." }
  if (slash === -1) return { dir: rest, subpath: "." }
  return { dir: rest.slice(0, slash), subpath: `./${rest.slice(slash + 1)}` }
}

/**
 * Resolve a workspace specifier to the source file that backs it. The `exports`
 * map ships `./dist/X.js` (what is published); the source it is built from is
 * `./src/X.ts`. Going through the map rather than guessing `src/<subpath>.ts`
 * keeps aliases (e.g. type-ir's `./typescript` -> `typescript-native.ts`)
 * correct.
 */
function resolveWorkspaceSource(spec: string): string {
  const split = splitWorkspaceSpecifier(spec)
  if (!split) throw new Error(`not a workspace specifier: ${spec}`)
  const pkgJsonPath = join(PACKAGES_DIR, split.dir, "package.json")
  if (!existsSync(pkgJsonPath)) throw new Error(`no workspace package for ${spec}`)
  const exportsMap = (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { exports?: Record<string, { import?: string }> })
    .exports
  const entry = exportsMap?.[split.subpath]?.import
  if (!entry) throw new Error(`${spec}: no "${split.subpath}" entry in ${split.dir}'s exports map`)
  const sourceRel = entry.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts")
  const sourcePath = join(PACKAGES_DIR, split.dir, sourceRel)
  if (!existsSync(sourcePath)) throw new Error(`${spec} resolves to ${sourcePath}, which does not exist`)
  return sourcePath
}

function resolveRelative(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) return candidate
  }
  throw new Error(`unresolvable relative import ${spec} from ${fromFile}`)
}

/**
 * Every external (non-workspace, non-relative) specifier reachable from
 * `entryFile` through static, value-level imports.
 */
function externalsOf(entryFile: string): Set<string> {
  const externals = new Set<string>()
  const seen = new Set<string>()
  const queue = [entryFile]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const imported of transpiler.scanImports(readFileSync(file, "utf8"))) {
      const spec = imported.path
      if (spec.startsWith(".")) {
        queue.push(resolveRelative(file, spec))
      } else if (splitWorkspaceSpecifier(spec)) {
        queue.push(resolveWorkspaceSource(spec))
      } else if (!spec.startsWith("node:") && !spec.startsWith("bun:")) {
        externals.add(spec)
      }
    }
  }
  return externals
}

const dependsOn = (externals: Set<string>, pkg: string): boolean =>
  [...externals].some((spec) => spec === pkg || spec.startsWith(`${pkg}/`))

const facade = (name: string): string => join(import.meta.dir, `${name}.ts`)

describe("subpath isolation", () => {
  // Positive controls first: if the walker could not see a protocol runtime
  // even where one is definitely used, every negative assertion below would
  // pass vacuously.
  it("sees graphql-js in the ./graphql subpath's graph", () => {
    expect(dependsOn(externalsOf(facade("graphql")), GRAPHQL_RUNTIME)).toBe(true)
  })

  it("sees the MCP SDK in the ./mcp subpath's graph", () => {
    expect(dependsOn(externalsOf(facade("mcp")), MCP_RUNTIME)).toBe(true)
  })

  for (const name of ["index", "http", "cli", "json-rpc"]) {
    it(`./${name} pulls in neither graphql-js nor the MCP SDK`, () => {
      const externals = externalsOf(facade(name))
      expect(dependsOn(externals, GRAPHQL_RUNTIME)).toBe(false)
      expect(dependsOn(externals, MCP_RUNTIME)).toBe(false)
    })
  }

  it("./graphql does not pull in the MCP SDK", () => {
    expect(dependsOn(externalsOf(facade("graphql")), MCP_RUNTIME)).toBe(false)
  })

  it("./mcp does not pull in graphql-js", () => {
    expect(dependsOn(externalsOf(facade("mcp")), GRAPHQL_RUNTIME)).toBe(false)
  })
})

describe("re-export surface", () => {
  // The isolation walk above is static; this checks the facades actually
  // resolve and carry the underlying package's values through at runtime.
  // Dynamic imports so each protocol's runtime loads only inside its own test.
  const probes: ReadonlyArray<readonly [string, string]> = [
    ["index", "op"],
    ["http", "createFetch"],
    ["cli", "runCli"],
    ["json-rpc", "createJsonRpcHttpHandler"],
    ["graphql", "projectGraphQL"],
    ["mcp", "toTools"],
  ]
  for (const [name, exported] of probes) {
    it(`./${name} re-exports ${exported}`, async () => {
      const mod = (await import(`./${name}.ts`)) as Record<string, unknown>
      expect(typeof mod[exported]).toBe("function")
    })
  }
})

describe("facade purity", () => {
  // The umbrella is a re-export surface. If a facade module ever grows logic,
  // the "no runtime code of its own" claim in the README stops being true and
  // the package acquires a version-skew hazard against the packages it fronts.
  for (const name of ["index", "http", "cli", "json-rpc", "graphql", "mcp"]) {
    it(`./${name} is a pure re-export`, () => {
      const source = readFileSync(facade(name), "utf8")
      const code = source
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("//"))
        .join("\n")
      expect(code.trim()).toMatch(/^export \* from "@rhi-zone\/fractal-[a-z-]+"$/)
    })
  }
})
