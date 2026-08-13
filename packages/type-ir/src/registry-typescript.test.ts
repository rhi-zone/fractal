import { describe, expect, it } from "bun:test";

import { mergeRegistries, has, lookup } from "./registry-core.ts";
import { createExtractorProgram } from "./from-typescript.ts";
import { importerRegistry, ingest, project, renderProjection } from "./registry.ts";
import {
  getTypeScriptImporter,
  importTypeScript,
  ingestFrom,
  typescriptImporterIds,
  typescriptImporterRegistry,
  type AnyImporter,
} from "./registry-typescript.ts";

const fixture = `${import.meta.dir}/__fixtures__/from-typescript.fixture.ts`;

describe("typescript importer registry", () => {
  it("every id resolves and declares the typescript input shape", () => {
    for (const id of typescriptImporterIds) {
      const importer = getTypeScriptImporter(id);
      expect(importer.id).toBe(id);
      expect(importer.input).toBe("typescript");
    }
    expect(typescriptImporterRegistry.entries.length).toBe(typescriptImporterIds.length);
  });

  it("rejects unknown ids", () => {
    expect(() => getTypeScriptImporter("nope")).toThrow(/unknown TypeScript input format/);
  });

  it("extracts an exported type alias, building its own program when none is given", () => {
    const doc = getTypeScriptImporter("typescript").run({ file: fixture, symbol: "Sample" });
    expect(doc.root.shape.kind).toBe("object");
  });

  it("reuses a caller-supplied program across extractions", () => {
    const program = createExtractorProgram(fixture);
    const a = importTypeScript({ file: fixture, symbol: "Sample", program });
    const b = importTypeScript({ file: fixture, symbol: "Sample", program });
    expect(a.shape.kind).toBe("object");
    expect(b.shape.kind).toBe("object");
  });

  it("reports a missing export rather than returning an empty type", () => {
    expect(() => importTypeScript({ file: fixture, symbol: "NotThere" })).toThrow(
      /does not export NotThere/,
    );
  });

  it("reports a missing file", () => {
    expect(() =>
      importTypeScript({ file: `${import.meta.dir}/__fixtures__/nope.ts`, symbol: "Sample" }),
    ).toThrow();
  });
});

// ============================================================================
// The merge — the point of splitting core mechanism from registry data
// ============================================================================

describe("merged importer registry", () => {
  const merged = mergeRegistries<AnyImporter>(importerRegistry, typescriptImporterRegistry);

  it("spans both halves under one id space", () => {
    expect(has(merged, "graphql")).toBe(true);
    expect(has(merged, "typescript")).toBe(true);
    expect(merged.entries.length).toBe(
      importerRegistry.entries.length + typescriptImporterRegistry.entries.length,
    );
  });

  it("drives a checker-backed importer through the unified call", () => {
    const doc = ingestFrom(merged, "typescript", { file: fixture, symbol: "Sample" });
    expect(doc.root.shape.kind).toBe("object");
  });

  it("drives a text importer through the same unified call", () => {
    const doc = ingestFrom(merged, "graphql", `type User { id: ID! }`);
    expect(doc.root.shape.kind).toBe("object");
  });

  it("narrows on the input tag to recover each entry's real signature", () => {
    // The static point of the discriminated union: this is how a CLI decides
    // what to read from argv, and each branch typechecks against a different
    // `run` signature without a cast.
    for (const id of ["graphql", "typescript"]) {
      const importer = lookup(merged, "input format", id);
      const doc =
        importer.input === "typescript"
          ? importer.run({ file: fixture, symbol: "Sample" })
          : importer.run(`type User { id: ID! }`);
      expect(doc.root.shape.kind).toBe("object");
    }
  });

  it("reports an input-shape mismatch by name instead of failing inside the importer", () => {
    expect(() => ingestFrom(merged, "typescript", "type User { id: ID! }")).toThrow(
      /needs a file and symbol/,
    );
    expect(() => ingestFrom(merged, "graphql", { file: fixture, symbol: "Sample" })).toThrow(
      /needs source text/,
    );
  });

  it("merging is non-destructive — the base registry still rejects TS ids", () => {
    expect(has(importerRegistry, "typescript")).toBe(false);
    expect(() => ingest("typescript", "irrelevant")).toThrow(/unknown input format/);
  });

  it("feeds the projector registry — both halves produce the same document type", () => {
    const fromTs = ingestFrom(merged, "typescript", { file: fixture, symbol: "Sample" });
    const out = renderProjection(project("python-pydantic", fromTs, { name: "Sample" }));
    expect(out).toContain("class Sample");
  });
});
