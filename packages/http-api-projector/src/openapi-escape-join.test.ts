// Regression coverage for `escapeJoin` (@rhi-zone/fractal-api-tree/path) at
// openapi.ts's join sites — `nameLeaves`/`buildNameMap` (codegen-name
// derivation, "_" delimiter) and, indirectly through `toOpenApi`'s use of
// both, `pathLeaves`/`buildPathMap` (schema correlation, "/" delimiter).
//
// Deliberately its own file, not added to openapi.test.ts: that file's
// module-level `const schemas = extractToolSchemas(treePath)` (evaluated
// against examples/library-api/src/tree.ts, which exports both `api` and
// `validatedApi` — two structurally-identical trees) throws at IMPORT time,
// a pre-existing bug in `extractToolSchemas`'s handling of a file exporting
// more than one candidate tree with overlapping leaf paths (unrelated to,
// and unaffected by, this escape-join fix — the colliding segments involved
// there, ["books","list"], contain no delimiter, so escaping changes nothing
// about that specific collision). That throw aborts the entire
// openapi.test.ts module before any of its tests can even register, so a new
// test added there would never run. This file avoids the broken import
// entirely (no `sourceFile`/`extractToolSchemas` use at all).

import { describe, expect, it } from "bun:test";
import { api as api_, op } from "@rhi-zone/fractal-api-tree/node";
import { http } from "./verbs.ts";
import { toOpenApi } from "./openapi.ts";

describe("nameLeaves / buildNameMap: a segment containing '_' no longer collides with a deeper tree position", () => {
  it("a leaf literally named 'widgets_list' and branch 'widgets' -> leaf 'list' derive two distinct operationIds", async () => {
    const n = api_({
      widgets_list: op((_: unknown) => ({ flat: true }), http.get),
      widgets: api_({ list: op((_: unknown) => ({ nested: true }), http.get) }),
    });
    const d = await toOpenApi(n, { title: "t", version: "1" });
    const flatOp = d.paths["/widgets_list"]?.["get"];
    const nestedOp = d.paths["/widgets/list"]?.["get"];
    expect(flatOp).toBeDefined();
    expect(nestedOp).toBeDefined();
    // operationId further maps "_" -> "." (codenName.replace(/_/g, ".")) on
    // top of the escaped codegen name — the escaped delimiter's own "_"
    // gets that same substitution, so the flat leaf's operationId keeps a
    // literal "\" marking where its OWN key's "_" was, distinguishing it
    // from the nested leaf's plain "." join.
    expect(flatOp?.operationId).toBe("widgets\\.list");
    // Byte-identical to the pre-escaping join: neither "widgets" nor "list"
    // contains the delimiter.
    expect(nestedOp?.operationId).toBe("widgets.list");
    expect(flatOp?.operationId).not.toBe(nestedOp?.operationId);
  });
});

// `pathLeaves`/`buildPathMap` (the "/"-joined schema-correlation key,
// unexported) was converted to `escapeJoin` too, for the same defense-in-
// depth reason as every other join site, but a clean demonstration of it in
// isolation isn't achievable through `toOpenApi`'s public surface: unlike
// MCP's resource URIs (an opaque naming scheme behind a scheme prefix),
// `buildPathMap`'s segments are the EXACT SAME tree keys route.ts's
// `naiveTransform` joins into the literal HTTP URL path — so a leaf key
// containing "/" collides at the URL-ROUTING level FIRST (a pre-existing,
// unescaped join in route.ts, not one of the six sites this fix converts),
// before schema correlation is ever reached. Verified directly: a tree with
// `"widgets/list"` as a leaf key alongside branch `"widgets"` -> leaf
// `"list"` produces a SINGLE `/widgets/list` path entry with the
// second-visited leaf's operation silently overwriting the first's — a
// separate, real bug in `naiveTransform`'s own unescaped path-joining,
// flagged here rather than fixed (out of scope for the six join sites this
// investigation covers).
