import { describe, expect, it } from "bun:test";
import { verbFromTags } from "./tags.ts";
import type { LeafMeta } from "@rhi-zone/fractal-api-tree/node";
import type { HttpLeafMeta } from "./project.ts";

// These tests deliberately feed malformed `meta.http` shapes (wrong type
// for `http` itself, a `verb` value that isn't a string) to verify
// verbFromTags's runtime defensive parsing still degrades gracefully — the
// shape is invalid ON PURPOSE, so it's built as `unknown` and cast, bypassing
// the compile-time `HttpLeafMeta` shape (see node.ts / project.ts).
function malformed(meta: unknown): LeafMeta & HttpLeafMeta {
  return meta as LeafMeta & HttpLeafMeta;
}

describe("verbFromTags — tag lattice dispatch", () => {
  it("no tags, no meta.http → POST", () => {
    expect(verbFromTags({})).toBe("POST");
  });

  it("readOnly = true → GET", () => {
    expect(verbFromTags({ tags: { readOnly: true } })).toBe("GET");
  });

  it("idempotent = true, destructive = true → DELETE", () => {
    expect(verbFromTags({ tags: { idempotent: true, destructive: true } })).toBe("DELETE");
  });

  it("idempotent = true, destructive unset → PUT", () => {
    expect(verbFromTags({ tags: { idempotent: true } })).toBe("PUT");
  });

  it("idempotent = true, destructive = false → PUT", () => {
    expect(verbFromTags({ tags: { idempotent: true, destructive: false } })).toBe("PUT");
  });

  it("readOnly = false, no other tags → POST", () => {
    expect(verbFromTags({ tags: { readOnly: false } })).toBe("POST");
  });
});

describe("verbFromTags — flat meta.http.verb key", () => {
  it("overrides tags entirely", () => {
    expect(
      verbFromTags({
        tags: { readOnly: true },
        http: { verb: "PATCH" },
      }),
    ).toBe("PATCH");
  });

  it("is uppercased", () => {
    expect(verbFromTags({ http: { verb: "patch" } })).toBe("PATCH");
  });

  it("meta.http not an object → falls through to tags", () => {
    expect(verbFromTags(malformed({ tags: { readOnly: true }, http: "GET" }))).toBe("GET");
  });

  it("meta.http.verb not a string → ignored, falls through to tags", () => {
    expect(verbFromTags(malformed({ tags: { readOnly: true }, http: { verb: 123 } }))).toBe("GET");
  });
});
