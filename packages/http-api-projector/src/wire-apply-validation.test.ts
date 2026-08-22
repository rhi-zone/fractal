// packages/http-api-projector/src/wire-apply-validation.test.ts
//
// End-to-end coverage for the 3-arg `applyValidation(key, routes, "http")`
// staged-validation wiring documented in preset.ts/route.ts — the design
// doc's own required test list names "http query-param decode end-to-end"
// explicitly (docs/design/wire-profiles-and-staged-validation.md). Builds
// the REAL generated module from wire-apply-validation-http.fixture.ts via
// `buildWireApplyValidationModuleSource` (api-tree's call-site-anchored
// codegen), evaluates it (same `evalModule` trick
// apply-validation-build.test.ts uses on its own generated output), wires
// the result onto `createFetch` via `rewriters`, and issues a REAL fetch
// request with a numeric-string query param — proving the query store's
// `queryProfile`-style coercion ("3" -> 3) runs before the handler, unlike
// today's raw `assemble()` output.

import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { buildWireApplyValidationModuleSource } from "@rhi-zone/fractal-api-tree/apply-validation-build";
import { createApplyValidation } from "@rhi-zone/fractal-api-tree/apply-validation";
import { createFetch } from "./presets.ts";
import type { HttpRoute } from "./route.ts";
import { booksTree } from "./__fixtures__/wire-apply-validation-http.fixture.ts";

const FIXTURE = `${import.meta.dir}/__fixtures__/wire-apply-validation-http.fixture.ts`;

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

/** Evaluate a generated wire-profile module, standing in for its one
 * runtime import (`createApplyValidation`) with the real function — mirrors
 * api-tree's `apply-validation-build.test.ts` `evalModule` helper exactly. */
function evalModule(source: string): { applyValidation: ReturnType<typeof createApplyValidation> } {
  const withoutImports = source
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n");
  const commonJs =
    tsTranspiler.transformSync(withoutImports).replaceAll("export const ", "const ") +
    "\nreturn { applyValidation };";
  return new Function("createApplyValidation", commonJs)(createApplyValidation);
}

describe('3-arg applyValidation("http") end-to-end — query-param decode', () => {
  it("emits a syntactically valid module for the http fixture's GET leaf", () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "@rhi-zone/fractal-api-tree/apply-validation",
    });
    const parsed = ts.createSourceFile("generated.ts", source, ts.ScriptTarget.ESNext, true);
    expect(
      (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [],
    ).toHaveLength(0);
  });

  it('a query-string numeric "page" is decoded to a number before the handler runs', async () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "@rhi-zone/fractal-api-tree/apply-validation",
    });
    const { applyValidation } = evalModule(source);

    const f = createFetch(booksTree, {
      rewriters: [
        (routes: HttpRoute) => applyValidation("wire-books", routes, "http") as HttpRoute,
      ],
    });

    const res = await f(new Request("http://localhost/list?page=3"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: 3, doubled: 6 });
  });

  it('a non-numeric "page" query value is rejected with a 400 (validateEncoding failure, not a silent NaN)', async () => {
    const source = buildWireApplyValidationModuleSource(FIXTURE, {
      runtimeImport: "@rhi-zone/fractal-api-tree/apply-validation",
    });
    const { applyValidation } = evalModule(source);

    const f = createFetch(booksTree, {
      rewriters: [
        (routes: HttpRoute) => applyValidation("wire-books", routes, "http") as HttpRoute,
      ],
    });

    const res = await f(new Request("http://localhost/list?page=notanumber"));
    expect(res.status).toBe(400);
  });
});
