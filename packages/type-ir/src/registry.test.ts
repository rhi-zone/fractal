import { describe, expect, it } from "bun:test";

import { t, types, typeRefDocument, type TypeRefDocument } from "./index.ts";
import {
  appliesTo,
  convert,
  getImporter,
  getProjector,
  importerIds,
  ingest,
  ingestCorpus,
  project,
  projectorIds,
  projectorRegistry,
  renderProjection,
} from "./registry.ts";

const sample: TypeRefDocument = typeRefDocument(
  t(
    types.object({
      id: t(types.string),
      count: t(types.number),
      nickname: t(types.string, { optional: true }),
    }),
  ),
);

const multi: TypeRefDocument = typeRefDocument(sample.root, {
  User: sample.root,
  Account: t(types.object({ owner: t(types.string) })),
});

// ============================================================================
// Coverage — the point of the registry is that every subpath is reachable
// ============================================================================

describe("registry coverage", () => {
  it("every canonical projector id resolves and declares a distinct subpath", () => {
    const subpaths = new Set(projectorIds.map((id) => getProjector(id).subpath));
    expect(subpaths.size).toBe(projectorIds.length);
  });

  it("every importer id resolves", () => {
    for (const id of importerIds) expect(getImporter(id).id).toBe(id);
  });

  it("aliases resolve to canonical projectors, not to separate instances", () => {
    expect(projectorRegistry.byId.get("zod")).toBe(projectorRegistry.byId.get("typescript-zod"));
    expect(projectorRegistry.byId.get("go")).toBe(projectorRegistry.byId.get("go-encoding-json"));
    expect(projectorRegistry.byId.get("cpp")).toBe(projectorRegistry.byId.get("cpp-nlohmann"));
    // Aliases are additive: the map is strictly larger than the canonical set.
    expect(projectorRegistry.byId.size).toBeGreaterThan(projectorIds.length);
  });

  it("rejects unknown ids rather than returning undefined", () => {
    expect(() => getProjector("nope")).toThrow(/unknown output format/);
    expect(() => getImporter("nope")).toThrow(/unknown input format/);
  });

  // `typescript` is an OPTIONAL peer dependency. Keeping it out of the core
  // mechanism and the base registry is the entire reason the checker-backed
  // entries live in their own module, and it is a property a single casual
  // import would silently destroy — so it is asserted, not just documented.
  it("neither the core mechanism nor the base registry imports typescript", async () => {
    for (const module of ["registry-core.ts", "registry.ts"]) {
      const source = await Bun.file(`${import.meta.dir}/${module}`).text();
      expect(source).not.toMatch(/from "typescript"/);
    }
  });

  it("the core mechanism has no imports at all", async () => {
    const source = await Bun.file(`${import.meta.dir}/registry-core.ts`).text();
    expect(source).not.toMatch(/^import /m);
  });
});

// ============================================================================
// Projection — every projector runs on both single-def and multi-def input
// ============================================================================

describe("projectors", () => {
  // `json-rpc` is the sole projector with a genuine precondition (an
  // `interface` root); it is exercised separately below against input it can
  // actually accept, rather than being asserted to work on an object type.
  const universal = projectorIds.filter((id) => getProjector(id).requires === "any");

  for (const id of universal) {
    it(`${id} projects a single-def document`, () => {
      const projection = project(id, sample);
      expect(renderProjection(projection).length).toBeGreaterThan(0);
    });

    it(`${id} projects a multi-def document`, () => {
      const projection = project(id, multi);
      expect(renderProjection(projection).length).toBeGreaterThan(0);
    });
  }

  it("only json-rpc constrains its input", () => {
    expect(projectorIds.filter((id) => getProjector(id).requires !== "any")).toEqual(["json-rpc"]);
  });

  it("json-rpc projects an interface root and rejects anything else", () => {
    const service = typeRefDocument(t(types.interface({ ping: t(types.object({})) })));
    expect(appliesTo(getProjector("json-rpc"), service)).toBe(true);
    expect(appliesTo(getProjector("json-rpc"), sample)).toBe(false);
    expect(renderProjection(project("json-rpc", service)).length).toBeGreaterThan(0);
    expect(() => project("json-rpc", sample)).toThrow(/requires an interface root/);
  });

  it("honours the root name option for name-first projectors", () => {
    const text = renderProjection(project("typescript", sample, { name: "Widget" }));
    expect(text).toContain("Widget");
  });

  it("preserves output shape rather than collapsing everything to text", () => {
    expect(project("typescript", sample).kind).toBe("text");
    expect(project("json-schema", sample).kind).toBe("json");
    expect(project("docusaurus-reference", multi).kind).toBe("files");
  });

  it("json projections carry a structured value, not a pre-serialized string", () => {
    const projection = project("json-schema", sample);
    if (projection.kind !== "json") throw new Error("expected json projection");
    expect(typeof projection.value).toBe("object");
  });

  it("file projections carry per-path content", () => {
    const projection = project("mkdocs-reference", multi);
    if (projection.kind !== "files") throw new Error("expected files projection");
    expect(projection.files.size).toBeGreaterThan(0);
  });
});

// ============================================================================
// Ingestion — one entry point per input shape
// ============================================================================

describe("importers", () => {
  it("json importers parse their source", () => {
    const doc = ingest("json", JSON.stringify({ id: "a", count: 1 }));
    expect(doc.root.shape.kind).toBe("object");
  });

  it("json-schema round-trips a simple object schema", () => {
    const doc = ingest(
      "json-schema",
      JSON.stringify({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
    );
    expect(doc.root.shape.kind).toBe("object");
  });

  it("text importers take raw source and promote the first declaration to root", () => {
    const doc = ingest("graphql", `type User { id: ID! }\ntype Account { owner: String! }`);
    expect(Object.keys(doc.defs)).toContain("Account");
    expect(doc.root.shape.kind).toBe("object");
  });

  it("corpus ingestion accepts many separate sources, not just one JSON array", () => {
    const doc = ingestCorpus("json-corpus", [
      JSON.stringify({ id: "a", count: 1 }),
      JSON.stringify({ id: "b", count: 2 }),
    ]);
    expect(doc.root.shape.kind).toBe("object");
  });

  it("rejects corpus ingestion of a non-corpus importer", () => {
    expect(() => ingestCorpus("graphql", ["type A { b: String }"])).toThrow(
      /not a corpus importer/,
    );
  });

  it("importers declare their input shape", () => {
    expect(getImporter("graphql").input).toBe("text");
    expect(getImporter("json-schema").input).toBe("json");
    expect(getImporter("json-corpus").input).toBe("json-corpus");
  });
});

// ============================================================================
// End to end
// ============================================================================

describe("convert", () => {
  it("crosses format families", () => {
    const out = convert(
      "json-schema",
      "python-pydantic",
      JSON.stringify({ type: "object", properties: { id: { type: "string" } } }),
    );
    expect(out).toContain("class");
  });

  it("reaches every applicable projector from a single JSON input", () => {
    const source = JSON.stringify({ id: "a", count: 1 });
    for (const id of projectorIds) {
      if (getProjector(id).requires !== "any") continue;
      expect(convert("json", id, source).length).toBeGreaterThan(0);
    }
  });
});
