// packages/codegen/test/drift.test.ts — the REAL drift-guard proof on the full
// pipeline (toOpenApi → generate → embedded guard), on BOTH compilers.
//
// tests-are-the-spec: this is the load-bearing test for Goal C. It copies the
// example app + its generated client/server into a temp dir, then:
//   1. IN SYNC — typechecks (tsgo AND stock tsc) → exit 0 (guard is green).
//   2. PLANTED DRIFT — mutates the APP (adds a route / changes a body shape)
//      WITHOUT regenerating, then typechecks → exit NON-ZERO with a `__drift__`
//      error (the stale generated union no longer equals the derived union).
//   3. RESTORE — confirms green again.
//
// Both compilers are exercised because the guard must hold under stock tsc (the
// O(N^2) formulations crashed it; the linear union-vs-union one survives).

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const exampleSrc = resolve(repoRoot, "examples/todo-api/src");
// Temp dir UNDER the example src so module resolution (node_modules, the
// `@rhi-zone/*` workspace dist) and the generated client's `../app.ts` relative
// import both resolve exactly as in the real example.
const tmp = resolve(exampleSrc, ".drift-test");
const tmpApp = resolve(tmp, "app.ts");
const tmpTsconfig = resolve(tmp, "tsconfig.json");

const binDir = resolve(repoRoot, "node_modules/.bin");
const tsgo = resolve(binDir, "tsgo");
const tsc = resolve(binDir, "tsc");

function typecheck(bin: string): { code: number; out: string } {
  const r = spawnSync(bin, ["--noEmit", "--project", tmpTsconfig], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

beforeAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // Copy app + the (committed, in-sync) generated dir verbatim.
  cpSync(resolve(exampleSrc, "app.ts"), tmpApp);
  cpSync(resolve(exampleSrc, "generated"), resolve(tmp, "generated"), {
    recursive: true,
  });
  writeFileSync(
    tmpTsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM"],
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          types: ["bun-types"],
        },
        include: ["app.ts", "generated/client.ts", "generated/server.ts"],
      },
      null,
      2,
    ),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const pristineApp = (): string => readFileSync(resolve(exampleSrc, "app.ts"), "utf8");

describe("drift guard — full pipeline, both compilers", () => {
  it("IN SYNC: tsgo and tsc both green (exit 0)", () => {
    writeFileSync(tmpApp, pristineApp());
    const g = typecheck(tsgo);
    const c = typecheck(tsc);
    expect(g.code, `tsgo in-sync output:\n${g.out}`).toBe(0);
    expect(c.code, `tsc in-sync output:\n${c.out}`).toBe(0);
  });

  it("PLANTED DRIFT (added route): tsgo and tsc both FAIL with __drift__", () => {
    // Add a brand-new top-level route to the APP only (generated is stale).
    const drifted = pristineApp().replace(
      "export const app = path({\n  todos: todosResource,",
      'export const app = path({\n  ghost: methods({ GET: () => text("boo") }),\n  todos: todosResource,',
    );
    expect(drifted).not.toBe(pristineApp()); // the anchor matched
    writeFileSync(tmpApp, drifted);

    const g = typecheck(tsgo);
    const c = typecheck(tsc);
    expect(g.code, `tsgo should FAIL on drift:\n${g.out}`).not.toBe(0);
    expect(c.code, `tsc should FAIL on drift:\n${c.out}`).not.toBe(0);
    expect(g.out).toContain("__drift__");
    expect(c.out).toContain("__drift__");
  });

  it("PLANTED DRIFT (changed body shape): tsgo and tsc both FAIL with __drift__", () => {
    // Change the validated create-body field from a string title to a boolean —
    // the generated union still says `{ title: string }`, so the derived union
    // (now `{ title: boolean }`) no longer matches.
    const drifted = pristineApp().replace(
      'const createSchema = schema({ title: "string" });',
      'const createSchema = schema({ title: "boolean" });',
    );
    expect(drifted).not.toBe(pristineApp());
    writeFileSync(tmpApp, drifted);

    const g = typecheck(tsgo);
    const c = typecheck(tsc);
    expect(g.code, `tsgo should FAIL on body drift:\n${g.out}`).not.toBe(0);
    expect(c.code, `tsc should FAIL on body drift:\n${c.out}`).not.toBe(0);
    expect(g.out).toContain("__drift__");
    expect(c.out).toContain("__drift__");
  });

  it("RESTORED: tsgo and tsc green again (exit 0)", () => {
    writeFileSync(tmpApp, pristineApp());
    const g = typecheck(tsgo);
    const c = typecheck(tsc);
    expect(g.code, `tsgo restored output:\n${g.out}`).toBe(0);
    expect(c.code, `tsc restored output:\n${c.out}`).toBe(0);
  });
});
