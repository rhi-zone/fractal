// packages/http-api-projector/src/codegen-source.test.ts — proves the static
// entry point (`generateClientFromSource`, no runtime tree import) produces
// BYTE-IDENTICAL output to the runtime path it replaces
// (`generateClientFromNode`, live `Node` + `extractToolSchemas`) for the
// library-api fixture — the actual safety proof for this refactor, not just
// "it compiles". The fixture exercises the exact case that needs full
// static-naming fidelity: `read`/`replace`/`remove` are `http.moveTo("..")`-
// co-located onto `/books/{bookId}` alongside `checkout`'s own subtree, and
// `list`/`add` sit at the collection root — if authored member names
// (`.read()`/`.replace()`/`.remove()` instead of `.get()`/`.put()`/
// `.delete()`) or codegen-name schema lookups drifted, this file's own
// tree's structure is exactly what would expose it.

import { describe, expect, it } from "bun:test";
import { extractToolSchemas } from "@rhi-zone/fractal-api-tree/tree";
import { generateClientFromNode } from "./codegen.ts";
import { generateClientFromSource } from "./codegen-source.ts";
import { api } from "../../../examples/library-api/src/tree.ts";

const treePath = new URL("../../../examples/library-api/src/tree.ts", import.meta.url).pathname;

describe("generateClientFromSource — identical output to generateClientFromNode", () => {
  it("produces byte-identical source for the library-api fixture", () => {
    const schemas = extractToolSchemas(treePath);
    const fromNode = generateClientFromNode(api, schemas, { clientName: "Client" });
    const fromSource = generateClientFromSource(treePath, { treeId: "api", clientName: "Client" });
    expect(fromSource).toBe(fromNode);
  });

  it("recovers authored co-located member names, not lowercased verbs", () => {
    const source = generateClientFromSource(treePath, { treeId: "api" });
    expect(source).toContain("read:");
    expect(source).toContain("replace:");
    expect(source).toContain("remove:");
    expect(source).not.toMatch(/readonly get:/);
    expect(source).not.toMatch(/readonly put:/);
  });

  it("emits codegen-name-derived type aliases matching extractToolSchemas' own naming", () => {
    const source = generateClientFromSource(treePath, { treeId: "api" });
    // "books_bookId_read" -> BooksBookIdRead — same base-name convention
    // generateClientFromNode's Handler-keyed codegenNames map produces.
    expect(source).toContain("export type BooksBookIdReadOutput");
    expect(source).toContain("export type BooksAddInput");
  });

  it("throws a named-candidate error when entryFilePath exports more than one tree and treeId is omitted", () => {
    expect(() => generateClientFromSource(treePath)).toThrow(/exports 3 trees/);
  });

  it("throws a clear error when an explicit treeId doesn't match any export", () => {
    expect(() => generateClientFromSource(treePath, { treeId: "nope" })).toThrow(
      /no tree named "nope"/,
    );
  });
});
