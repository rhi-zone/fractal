import { describe, expect, test } from "bun:test";
import { applyOverlay, OverlayError, type Json, type Overlay } from "./overlay.ts";

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
};

const ov = (version: string, ...actions: Record<string, unknown>[]): Overlay =>
  ({ overlay: version, info: { title: "t", version: "1.0.0" }, actions }) as unknown as Overlay;

const apply = (doc: Json, overlay: Overlay) =>
  applyOverlay(deepFreeze(structuredClone(doc)), deepFreeze(structuredClone(overlay)));

describe("Overlay Specification 1.2.0 examples", () => {
  test("structured overlay", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      paths: { "/pets": { get: { summary: "old" } } },
    };
    const { document, diagnostics } = apply(
      doc,
      ov("1.2.0", {
        target: "$",
        update: {
          info: { "x-overlay-applied": "structured-overlay" },
          paths: {
            "/": {
              summary: "The root resource",
              get: { summary: "Retrieve the root resource", "x-rate-limit": 100 },
            },
            "/pets": { get: { summary: "Retrieve a list of pets", "x-rate-limit": 100 } },
          },
        },
      }),
    );
    expect(diagnostics).toEqual([]);
    expect(document).toEqual({
      openapi: "3.1.0",
      info: { title: "x", version: "1", "x-overlay-applied": "structured-overlay" },
      paths: {
        "/pets": { get: { summary: "Retrieve a list of pets", "x-rate-limit": 100 } },
        "/": {
          summary: "The root resource",
          get: { summary: "Retrieve the root resource", "x-rate-limit": 100 },
        },
      },
    });
  });

  test("targeted overlay replaces primitives and adds a child", () => {
    const doc = {
      paths: { "/foo": { get: { description: "a" } }, "/bar": { get: { description: "b" } } },
    };
    const { document } = apply(
      doc,
      ov(
        "1.1.0",
        { target: "$.paths['/foo'].get.description", update: "This is the new description" },
        { target: "$.paths['/bar'].get.description", update: "This is the updated description" },
        { target: "$.paths['/bar']", update: { post: { description: "child", "x-safe": false } } },
      ),
    );
    expect(document).toEqual({
      paths: {
        "/foo": { get: { description: "This is the new description" } },
        "/bar": {
          get: { description: "This is the updated description" },
          post: { description: "child", "x-safe": false },
        },
      },
    });
  });

  test("wildcard overlay", () => {
    const doc = {
      paths: {
        "/a": {
          get: {
            parameters: [
              { name: "filter", in: "query" },
              { name: "other", in: "query" },
            ],
          },
        },
        "/b": { get: { parameters: [{ name: "filter", in: "header" }] }, post: {} },
      },
    };
    const { document } = apply(
      doc,
      ov(
        "1.2.0",
        { target: "$.paths.*.get", update: { "x-safe": true } },
        {
          target: "$.paths.*.get.parameters[?@.name=='filter' && @.in=='query']",
          update: { schema: { $ref: "#/components/schemas/filterSchema" } },
        },
      ),
    );
    expect(document).toEqual({
      paths: {
        "/a": {
          get: {
            "x-safe": true,
            parameters: [
              {
                name: "filter",
                in: "query",
                schema: { $ref: "#/components/schemas/filterSchema" },
              },
              { name: "other", in: "query" },
            ],
          },
        },
        "/b": { get: { "x-safe": true, parameters: [{ name: "filter", in: "header" }] }, post: {} },
      },
    });
  });

  test("array modification: append, and remove by filter", () => {
    const doc = { paths: { "/a": { get: { parameters: [{ name: "dummy" }, { name: "keep" }] } } } };
    const added = apply(
      doc,
      ov("1.2.0", {
        target: "$.paths.*.get.parameters",
        update: { name: "newParam", in: "query" },
      }),
    );
    expect(added.document).toEqual({
      paths: {
        "/a": {
          get: {
            parameters: [{ name: "dummy" }, { name: "keep" }, { name: "newParam", in: "query" }],
          },
        },
      },
    });
    const removed = apply(
      doc,
      ov("1.2.0", { target: "$.paths.*.get.parameters[?@.name == 'dummy']", remove: true }),
    );
    expect(removed.document).toEqual({
      paths: { "/a": { get: { parameters: [{ name: "keep" }] } } },
    });
  });

  test("removing primitive array elements", () => {
    const doc = {
      paths: {
        "/a": { get: { tags: ["dummy", "x", "dummy"] } },
        "/b": { get: { tags: ["dummy"] } },
      },
    };
    const { document } = apply(
      doc,
      ov("1.1.0", { target: "$.paths.*.get.tags[?@ == 'dummy']", remove: true }),
    );
    expect(document).toEqual({
      paths: { "/a": { get: { tags: ["x"] } }, "/b": { get: { tags: [] } } },
    });
  });

  test("traits overlay with the spec's stated result", () => {
    const doc = {
      openapi: "3.2.0",
      info: { title: "API with a paged collection", version: "1.0.0" },
      paths: {
        "/items": {
          get: { "x-oai-traits": ["paged"], responses: { "200": { description: "OK" } } },
        },
        "/items/{id}/subitems": {
          get: {
            "x-oai-traits": ["paged"],
            parameters: [{ name: "id", in: "path", required: true }],
            responses: { "200": { description: "OK" } },
          },
        },
        "/other": { get: { responses: { "200": { description: "OK" } } } },
      },
    };
    const paging = [
      { name: "top", in: "query" },
      { name: "skip", in: "query" },
    ];
    const { document, diagnostics } = apply(
      doc,
      ov("1.2.0", {
        target: "$.paths[?(@.get['x-oai-traits'][?(@ == 'paged')])].get",
        update: { parameters: paging },
      }),
    );
    expect(diagnostics).toEqual([]);
    expect(document).toEqual({
      openapi: "3.2.0",
      info: { title: "API with a paged collection", version: "1.0.0" },
      paths: {
        "/items": {
          get: {
            "x-oai-traits": ["paged"],
            responses: { "200": { description: "OK" } },
            parameters: paging,
          },
        },
        "/items/{id}/subitems": {
          get: {
            "x-oai-traits": ["paged"],
            parameters: [{ name: "id", in: "path", required: true }, ...paging],
            responses: { "200": { description: "OK" } },
          },
        },
        "/other": { get: { responses: { "200": { description: "OK" } } } },
      },
    });
  });

  const copySource = {
    openapi: "3.2.0",
    info: { title: "Example API", version: "1.0.0" },
    paths: {
      "/items": { get: { responses: { "200": { description: "OK" } } } },
      "/some-items": { delete: { responses: { "200": { description: "OK" } } } },
    },
  };

  test("simple copy", () => {
    const { document } = apply(
      copySource,
      ov("1.1.0", { target: '$.paths["/some-items"]', copy: '$.paths["/items"]' }),
    );
    expect(document).toEqual({
      ...copySource,
      paths: {
        "/items": { get: { responses: { "200": { description: "OK" } } } },
        "/some-items": {
          delete: { responses: { "200": { description: "OK" } } },
          get: { responses: { "200": { description: "OK" } } },
        },
      },
    });
  });

  test("ensure the target exists, then copy", () => {
    const { document } = apply(
      copySource,
      ov(
        "1.1.0",
        { target: "$.paths", update: { "/other-items": {} } },
        { target: '$.paths["/other-items"]', copy: '$.paths["/items"]' },
      ),
    );
    expect((document as any).paths["/other-items"]).toEqual({
      get: { responses: { "200": { description: "OK" } } },
    });
    expect(Object.keys((document as any).paths).sort()).toEqual([
      "/items",
      "/other-items",
      "/some-items",
    ]);
  });

  test("move: update, copy, remove", () => {
    const { document } = apply(
      copySource,
      ov(
        "1.1.0",
        { target: "$.paths", update: { "/new-items": {} } },
        { target: '$.paths["/new-items"]', copy: '$.paths["/items"]' },
        { target: '$.paths["/items"]', remove: true },
      ),
    );
    expect(document).toEqual({
      ...copySource,
      paths: {
        "/some-items": { delete: { responses: { "200": { description: "OK" } } } },
        "/new-items": { get: { responses: { "200": { description: "OK" } } } },
      },
    });
  });

  test("reusable action reference", () => {
    const notFound = {
      "404": {
        description: "Not Found",
        content: {
          "application/json": {
            schema: { type: "object", properties: { message: { type: "string" } } },
          },
        },
      },
    };
    const overlay = {
      overlay: "1.2.0",
      info: { title: "t", version: "1" },
      components: {
        actions: {
          errorResponse: {
            fields: { update: notFound },
            description: "Adds an error response to the operation",
          },
        },
      },
      actions: [
        { $ref: "#/components/actions/errorResponse", target: "$.paths['/items'].get.responses" },
        {
          $ref: "#/components/actions/errorResponse",
          target: "$.paths['/some-items'].delete.responses",
        },
      ],
    } as unknown as Overlay;
    const { document } = apply(copySource, overlay);
    expect(document).toEqual({
      ...copySource,
      paths: {
        "/items": { get: { responses: { "200": { description: "OK" }, ...notFound } } },
        "/some-items": { delete: { responses: { "200": { description: "OK" }, ...notFound } } },
      },
    });
  });
});

describe("not OpenAPI-specific", () => {
  test("applies to an arbitrary JSON document", () => {
    const doc = {
      methods: [
        { name: "a", params: [] },
        { name: "b", params: [] },
      ],
      info: { version: 1 },
    };
    const { document } = apply(
      doc,
      ov(
        "1.2.0",
        { target: "$.methods[?@.name=='b'].params", update: { name: "x" } },
        { target: "$.info.version", update: 2 },
      ),
    );
    expect(document).toEqual({
      methods: [
        { name: "a", params: [] },
        { name: "b", params: [{ name: "x" }] },
      ],
      info: { version: 2 },
    });
  });

  test("a primitive root is replaced", () => {
    expect(apply("a", ov("1.1.0", { target: "$", update: "b" })).document).toBe("b");
  });
});

describe("merge rules", () => {
  const merge = (version: string, target: Json, update: Json) => () =>
    apply({ t: target }, ov(version, { target: "$.t", update })).document;

  test("1.1: primitive replaces, array concatenates, object recurses, new keys inserted, others kept", () => {
    expect(
      merge(
        "1.1.0",
        { a: 1, l: [1], o: { x: 1, y: 2 }, keep: true },
        { a: 2, l: [2], o: { y: 3, z: 4 }, added: null },
      )(),
    ).toEqual({
      t: { a: 2, l: [1, 2], o: { x: 1, y: 3, z: 4 }, keep: true, added: null },
    });
  });

  test("1.1: incompatible property kinds are an error", () => {
    expect(merge("1.1.0", { a: 1 }, { a: { b: 1 } })).toThrow(OverlayError);
    expect(merge("1.1.0", { a: [1] }, { a: 1 })).toThrow(OverlayError);
    expect(merge("1.1.0", { a: { b: 1 } }, { a: [1] })).toThrow(OverlayError);
    expect(merge("1.1.0", { o: { a: 1 } }, { o: { a: [] } })).toThrow(/document \/t\/o\/a/);
  });

  test("1.0: only objects recurse, any other value replaces (an array replaces an array)", () => {
    expect(
      merge("1.0.0", { l: [1], a: 1, o: { x: 1 } }, { l: [2], a: { b: 1 }, o: { y: 2 } })(),
    ).toEqual({
      t: { l: [2], a: { b: 1 }, o: { x: 1, y: 2 } },
    });
  });

  test("an object target needs an object update", () => {
    expect(merge("1.1.0", { a: 1 }, [1])).toThrow(/must be an object/);
    expect(merge("1.0.0", { a: 1 }, "s")).toThrow(/must be an object/);
  });

  test("array target: 1.1 concatenates arrays and appends anything else; 1.0 appends the value as one entry", () => {
    expect(merge("1.1.0", [1], [2, 3])()).toEqual({ t: [1, 2, 3] });
    expect(merge("1.1.0", [1], { a: 1 })()).toEqual({ t: [1, { a: 1 }] });
    expect(merge("1.1.0", [1], "s")()).toEqual({ t: [1, "s"] });
    expect(merge("1.0.0", [1], [2, 3])()).toEqual({ t: [1, [2, 3]] });
  });

  test("primitive target: replaced by a primitive in 1.1, an error in 1.0", () => {
    expect(merge("1.1.0", 1, null)()).toEqual({ t: null });
    expect(merge("1.1.0", 1, { a: 1 })).toThrow(/must be a primitive/);
    expect(merge("1.0.0", 1, 2)).toThrow(/only targets objects and arrays/);
  });

  test("two or more selected nodes must share a kind (1.1+)", () => {
    const doc = { a: { x: 1 }, b: [1] };
    expect(() => apply(doc, ov("1.1.0", { target: "$.*", update: { y: 1 } }))).toThrow(
      /mixed kinds/,
    );
    const v10 = apply(doc, ov("1.0.0", { target: "$.*", update: { y: 1 } })).document;
    expect(v10).toEqual({ a: { x: 1, y: 1 }, b: [1, { y: 1 }] });
  });

  test("a node selected twice is updated once", () => {
    expect(apply({ l: [1] }, ov("1.1.0", { target: "$['l','l']", update: [2] })).document).toEqual({
      l: [1, 2],
    });
  });

  test("the same update applied to several nodes is cloned per node", () => {
    const { document } = apply(
      { a: {}, b: {} },
      ov("1.1.0", { target: "$.*", update: { shared: { n: 1 } } }),
    );
    const d = document as any;
    expect(d.a.shared).toEqual({ n: 1 });
    expect(d.a.shared).not.toBe(d.b.shared);
  });

  test("__proto__ keys are data, never a prototype write", () => {
    const update = JSON.parse('{"__proto__": {"polluted": true}}');
    const { document } = apply({ t: {} }, ov("1.1.0", { target: "$.t", update }));
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.keys((document as any).t)).toEqual(["__proto__"]);
  });
});

describe("remove", () => {
  test("indices selected together are all removed", () => {
    expect(
      apply({ a: [0, 1, 2, 3] }, ov("1.1.0", { target: "$.a[0,2]", remove: true })).document,
    ).toEqual({ a: [1, 3] });
  });

  test("an ancestor and its descendant selected together", () => {
    const doc = {
      items: [
        { drop: true, kids: [{ drop: true }, { drop: false }] },
        { drop: false, kids: [{ drop: true }, { keep: 1 }] },
      ],
    };
    const { document } = apply(doc, ov("1.1.0", { target: "$..[?@.drop == true]", remove: true }));
    expect(document).toEqual({ items: [{ drop: false, kids: [{ keep: 1 }] }] });
  });

  test("object members", () => {
    expect(
      apply({ a: { x: 1, y: 2 }, b: { x: 3 } }, ov("1.1.0", { target: "$.*.x", remove: true }))
        .document,
    ).toEqual({ a: { y: 2 }, b: {} });
  });

  test("the root cannot be removed", () => {
    expect(() => apply({ a: 1 }, ov("1.1.0", { target: "$", remove: true }))).toThrow(/root/);
  });

  test("1.0 cannot remove primitives", () => {
    expect(() => apply({ a: [1] }, ov("1.0.0", { target: "$.a[0]", remove: true }))).toThrow(
      /only targets objects and arrays/,
    );
  });

  test("remove wins over update", () => {
    expect(
      apply({ a: { b: 1 } }, ov("1.1.0", { target: "$.a", remove: true, update: { c: 1 } }))
        .document,
    ).toEqual({});
  });

  test("a later action sees the previous action's result", () => {
    const { document } = apply(
      { a: { b: 1 } },
      ov("1.1.0", { target: "$.a", remove: true }, { target: "$", update: { a: { c: 2 } } }),
    );
    expect(document).toEqual({ a: { c: 2 } });
  });
});

describe("diagnostics", () => {
  test("a target selecting nothing is a diagnostic and changes nothing", () => {
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      const { document, diagnostics } = apply(
        { a: 1 },
        ov(version, { target: "$.nope", update: { x: 1 } }, { target: "$.nope", remove: true }),
      );
      expect(document).toEqual({ a: 1 });
      expect(diagnostics.map((d) => d.at)).toEqual(["/actions/0/target", "/actions/1/target"]);
    }
  });

  test("an action with nothing to do is reported", () => {
    const { diagnostics } = apply({ a: 1 }, ov("1.1.0", { target: "$.a" }));
    expect(diagnostics).toEqual([
      { at: "/actions/0", message: expect.stringContaining("changes nothing") },
    ]);
  });

  test("unknown fields are reported, extensions are not", () => {
    const { diagnostics } = apply(
      { a: {} },
      ov("1.1.0", { target: "$.a", update: { b: 1 }, replace: 1, "x-note": 1 }),
    );
    expect(diagnostics).toEqual([
      { at: "/actions/0/replace", message: expect.stringContaining("unknown action field") },
    ]);
  });
});

describe("errors", () => {
  test("malformed overlays", () => {
    expect(() => applyOverlay({}, null as never)).toThrow(OverlayError);
    expect(() =>
      applyOverlay({}, { overlay: "1.1.0", actions: [{ target: "$" }] } as never),
    ).toThrow(/info/);
    expect(() =>
      applyOverlay({}, {
        overlay: "1.1.0",
        info: { title: "t", version: "1" },
        actions: [],
      } as never),
    ).toThrow(/at least one/);
    expect(() => applyOverlay({}, ov("1.1.0", { update: {} }))).toThrow(/target/);
    expect(() => applyOverlay({}, ov("1.1.0", { target: "$", remove: "yes" }))).toThrow(/boolean/);
  });

  test("unsupported versions", () => {
    for (const version of ["2.0.0", "1.3.0", "1.1", "latest"]) {
      expect(() => applyOverlay({}, ov(version, { target: "$", update: {} }))).toThrow(/overlay/);
    }
    expect(() => applyOverlay({}, ov("1.1.7", { target: "$", update: {} }))).not.toThrow();
  });

  test("features newer than the declared version", () => {
    expect(() => applyOverlay({ a: {} }, ov("1.0.0", { target: "$.a", copy: "$" }))).toThrow(
      /1\.1\.0/,
    );
    const withRef = {
      ...ov("1.1.0", { $ref: "#/components/actions/x", target: "$" }),
      components: { actions: { x: {} } },
    };
    expect(() => applyOverlay({}, withRef as never)).toThrow(/1\.2\.0/);
  });

  test("errors name the action", () => {
    try {
      applyOverlay(
        { a: 1 },
        ov("1.1.0", { target: "$.a", update: { b: 1 } }, { target: "$.a", update: { b: 1 } }),
      );
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(OverlayError);
      expect((e as OverlayError).at).toBe("/actions/0");
    }
  });

  test("copy must select exactly one node", () => {
    expect(() =>
      apply({ a: 1, b: [1, 2] }, ov("1.1.0", { target: "$.a", copy: "$.b[*]" })),
    ).toThrow(/exactly one node, .* selected 2/);
    expect(() => apply({ a: 1 }, ov("1.1.0", { target: "$.a", copy: "$.none" }))).toThrow(
      /selected 0/,
    );
  });

  test("update together with copy is refused", () => {
    expect(() => apply({ a: {} }, ov("1.1.0", { target: "$.a", update: {}, copy: "$" }))).toThrow(
      /both set/,
    );
  });

  test("copy takes the source at the time of the action and does not alias it", () => {
    const { document } = apply(
      { a: { n: [1] }, b: {} },
      ov("1.1.0", { target: "$.b", copy: "$.a" }, { target: "$.b.n", update: [2] }),
    );
    expect(document).toEqual({ a: { n: [1] }, b: { n: [1, 2] } });
  });

  describe("reusable actions", () => {
    const withComponents = (actions: Record<string, unknown>, ...refs: Record<string, unknown>[]) =>
      ({
        overlay: "1.2.0",
        info: { title: "t", version: "1" },
        components: { actions },
        actions: refs,
      }) as never;

    test("a reference may override the description only, and needs a target", () => {
      const base = { x: { fields: { update: { n: 1 }, description: "d" } } };
      expect(
        apply(
          { a: {} },
          withComponents(base, {
            $ref: "#/components/actions/x",
            target: "$.a",
            description: "mine",
          }),
        ).document,
      ).toEqual({ a: { n: 1 } });
      expect(() => apply({}, withComponents(base, { $ref: "#/components/actions/x" }))).toThrow(
        /target/,
      );
      expect(() =>
        apply(
          {},
          withComponents(base, { $ref: "#/components/actions/x", target: "$", update: {} }),
        ),
      ).toThrow(/may only supply/);
    });

    test("bad references", () => {
      const base = { x: { fields: { update: {} } } };
      expect(() =>
        apply({}, withComponents(base, { $ref: "#/components/actions/missing", target: "$" })),
      ).toThrow(/no reusable action/);
      expect(() =>
        apply({}, withComponents(base, { $ref: "#/components/schemas/x", target: "$" })),
      ).toThrow(/must be a string starting with/);
      expect(() =>
        apply({}, withComponents(base, { $ref: "#/components/actions/x/fields", target: "$" })),
      ).toThrow(/exactly one key/);
      expect(() =>
        apply(
          {},
          withComponents(
            { x: { fields: { target: "$", update: {} } } },
            { $ref: "#/components/actions/x", target: "$" },
          ),
        ),
      ).toThrow(/must not contain `target`/);
    });

    test("keys are RFC 6901 escaped", () => {
      const overlay = withComponents(
        { "a/b~c": { fields: { update: { n: 1 } } } },
        { $ref: "#/components/actions/a~1b~0c", target: "$" },
      );
      expect(apply({}, overlay).document).toEqual({ n: 1 });
    });
  });
});

describe("JSONPath (RFC 9535)", () => {
  const doc = {
    books: [
      { title: "A", price: 5, tags: ["x", "y"], meta: { isbn: "abc-1" } },
      { title: "B", price: 15, tags: ["y"], meta: { isbn: "xyz-2" } },
      { title: "Cc", price: 25, tags: [], meta: {} },
    ],
    nested: { deep: { price: 99 } },
  };
  const titles = (target: string) => {
    const out = apply(doc, ov("1.1.0", { target, update: { picked: true } })).document as any;
    return (out.books as any[]).filter((b) => b.picked).map((b) => b.title);
  };

  test("selectors", () => {
    expect(titles("$.books[0]")).toEqual(["A"]);
    expect(titles("$.books[-1]")).toEqual(["Cc"]);
    expect(titles("$.books[0:2]")).toEqual(["A", "B"]);
    expect(titles("$.books[::2]")).toEqual(["A", "Cc"]);
    expect(titles("$['books'][0,2]")).toEqual(["A", "Cc"]);
    expect(titles("$.books[*]")).toEqual(["A", "B", "Cc"]);
  });

  test("descendant segments", () => {
    const { document } = apply(doc, ov("1.1.0", { target: "$..price", remove: true }));
    expect(JSON.stringify(document)).not.toContain("price");
  });

  test("filters: comparison, logic, existence, nested queries", () => {
    expect(titles("$.books[?@.price > 10]")).toEqual(["B", "Cc"]);
    expect(titles("$.books[?@.price >= 5 && @.price < 25]")).toEqual(["A", "B"]);
    expect(titles("$.books[?@.price == 5 || @.title == 'Cc']")).toEqual(["A", "Cc"]);
    expect(titles("$.books[?!(@.price > 10)]")).toEqual(["A"]);
    expect(titles("$.books[?@.meta.isbn]")).toEqual(["A", "B"]);
    expect(titles("$.books[?@.tags[?@ == 'x']]")).toEqual(["A"]);
    expect(titles("$.books[?@.price < $.nested.deep.price && @.price > 20]")).toEqual(["Cc"]);
  });

  test("function extensions: length, count, match, search, value", () => {
    expect(titles("$.books[?length(@.title) == 2]")).toEqual(["Cc"]);
    expect(titles("$.books[?count(@.tags[*]) >= 1]")).toEqual(["A", "B"]);
    expect(titles("$.books[?match(@.meta.isbn, 'abc-.')]")).toEqual(["A"]);
    expect(titles("$.books[?match(@.meta.isbn, 'abc')]")).toEqual([]);
    expect(titles("$.books[?search(@.meta.isbn, 'z-')]")).toEqual(["B"]);
    expect(titles("$.books[?value(@.tags[?@ == 'x']) == 'x']")).toEqual(["A"]);
  });

  test("invalid or non-standard expressions throw with the action's pointer", () => {
    for (const target of [
      "$.books[",
      "books",
      "$.books[?@.price >]",
      "$.books[?length(@.tags)]",
      "$.books[?nope(@)]",
      "$.books.~",
      "$.books[?@ in [1]]",
    ]) {
      try {
        applyOverlay(doc, ov("1.1.0", { target, update: {} }));
        throw new Error(`expected ${target} to throw`);
      } catch (e) {
        expect(e).toBeInstanceOf(OverlayError);
        expect((e as OverlayError).at).toBe("/actions/0/target");
      }
    }
  });
});

describe("purity", () => {
  test("inputs are not mutated (they are frozen) and the result shares nothing with them", () => {
    const doc = deepFreeze({ a: { list: [1], n: 1 } });
    const update = deepFreeze({ list: [2], extra: { deep: [1] } });
    const overlay = deepFreeze(ov("1.1.0", { target: "$.a", update }));
    const { document } = applyOverlay(doc, overlay);
    const a = (document as any).a;
    expect(a).toEqual({ list: [1, 2], n: 1, extra: { deep: [1] } });
    expect(a.extra).not.toBe(update.extra);
    expect(a.list).not.toBe(doc.a.list);
    expect(doc).toEqual({ a: { list: [1], n: 1 } });
  });

  test("a document the overlay does not touch comes back equal but not identical", () => {
    const doc = { a: [1, { b: 2 }] };
    const { document } = applyOverlay(doc, ov("1.1.0", { target: "$.zzz", update: {} }));
    expect(document).toEqual(doc);
    expect(document).not.toBe(doc);
  });
});
