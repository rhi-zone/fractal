// packages/http-api-projector/src/dx.test.ts — crud() and httpProjection() DX sugar tests

import { describe, expect, it } from "bun:test";
import { isLeaf } from "@rhi-zone/fractal-api-tree/node";
import type { Node } from "@rhi-zone/fractal-api-tree/node";
import { api } from "@rhi-zone/fractal-api-tree";
import { crud, httpProjection, restCrud } from "./dx.ts";
import { naiveTransform, routeCandidatesForUrl } from "./route.ts";
import { createFetch } from "./preset.ts";

function methodDirective(n: Node): string | undefined {
  const http_ = n.meta.http as { method?: string } | undefined;
  return http_?.method;
}

// ============================================================================
// crud() — all handlers
// ============================================================================

describe("crud() with all handlers", () => {
  const list = (_: unknown) => [];
  const create = (_: unknown) => ({});
  const get = (_: unknown) => ({});
  const update = (_: unknown) => ({});
  const del = (_: unknown) => ({});

  const tree = crud({ list, create, get, update, delete: del });

  it("produces a branch node with one child per handler", () => {
    expect(Object.keys(tree.children ?? {}).sort()).toEqual([
      "create",
      "delete",
      "get",
      "list",
      "update",
    ]);
  });

  it("each child is a leaf node wrapping the given handler", () => {
    expect(isLeaf(tree.children?.list as Node)).toBe(true);
    expect((tree.children?.list as Node).handler).toBe(list);
    expect((tree.children?.create as Node).handler).toBe(create);
    expect((tree.children?.get as Node).handler).toBe(get);
    expect((tree.children?.update as Node).handler).toBe(update);
    expect((tree.children?.delete as Node).handler).toBe(del);
  });

  it("sets the correct HTTP method directive per operation", () => {
    expect(methodDirective(tree.children?.list as Node)).toBe("GET");
    expect(methodDirective(tree.children?.create as Node)).toBe("POST");
    expect(methodDirective(tree.children?.get as Node)).toBe("GET");
    expect(methodDirective(tree.children?.update as Node)).toBe("PUT");
    expect(methodDirective(tree.children?.delete as Node)).toBe("DELETE");
  });
});

// ============================================================================
// crud() — partial handlers
// ============================================================================

describe("crud() with partial handlers", () => {
  const list = (_: unknown) => [];
  const create = (_: unknown) => ({});

  const tree = crud({ list, create });

  it("only produces children for the handlers provided", () => {
    expect(Object.keys(tree.children ?? {}).sort()).toEqual(["create", "list"]);
  });

  it("omits get/update/delete entirely", () => {
    expect(tree.children?.get).toBeUndefined();
    expect(tree.children?.update).toBeUndefined();
    expect(tree.children?.delete).toBeUndefined();
  });
});

describe("crud() with no handlers", () => {
  it("produces a branch node with no children", () => {
    const tree = crud({});
    expect(tree.children).toEqual({});
  });
});

// ============================================================================
// httpProjection() — default transforms
// ============================================================================

describe("httpProjection() with default transforms", () => {
  const list = (_: unknown) => [];
  const create = (_: unknown) => ({});

  it("applies the standard rewriter pipeline (methods renamed off the POST default)", () => {
    const tree = crud({ list, create });
    const routes = httpProjection(tree);
    expect(Object.keys(routes.children?.list?.methods ?? {})).toEqual(["GET"]);
    expect(Object.keys(routes.children?.create?.methods ?? {})).toEqual(["POST"]);
  });

  it("is equivalent to composeTransforms(applyMethods, applyMoveTo, applyResponse)(naiveTransform(tree))", async () => {
    const { applyMethods, applyMoveTo, applyResponse, composeTransforms } =
      await import("./route.ts");
    const tree = crud({ list, create });
    const expected = composeTransforms(
      applyMethods,
      applyMoveTo,
      applyResponse,
    )(naiveTransform(tree));
    expect(httpProjection(tree)).toEqual(expected);
  });
});

// ============================================================================
// httpProjection() — custom transforms
// ============================================================================

describe("httpProjection() with custom transforms", () => {
  it("uses exactly the transforms passed in opts.transforms, in order", () => {
    const list = (_: unknown) => [];
    const tree = crud({ list });

    const calls: string[] = [];
    const tap = (label: string) => (r: import("./route.ts").HttpRoute) => {
      calls.push(label);
      return r;
    };

    httpProjection(tree, { transforms: [tap("a"), tap("b")] });
    expect(calls).toEqual(["a", "b"]);
  });

  it("an empty transforms array yields the naive transform unchanged", () => {
    const list = (_: unknown) => [];
    const tree = crud({ list });
    const routes = httpProjection(tree, { transforms: [] });
    // No applyMethods run — the naive default POST entry is left untouched.
    expect(Object.keys(routes.children?.list?.methods ?? {})).toEqual(["POST"]);
  });
});

// ============================================================================
// restCrud() — REST-shaped 5-op resource: list/create at the collection
// root, get/update/delete co-located onto the id fallback via moveTo("..")
// ============================================================================

describe("restCrud() tree shape", () => {
  const list = (_: unknown) => [];
  const create = (_: unknown) => ({});
  const get = (_: unknown) => ({});
  const update = (_: unknown) => ({});
  const del = (_: unknown) => ({});

  it("wires list/create as children carrying moveTo('..'), not sibling keys", () => {
    const tree = restCrud({ list, create, get, update, delete: del });
    expect(Object.keys(tree.children ?? {}).sort()).toEqual(["create", "list"]);
    expect((tree.children?.list as Node).meta.http).toMatchObject({ method: "GET", moveTo: ".." });
    expect((tree.children?.create as Node).meta.http).toMatchObject({
      method: "POST",
      moveTo: "..",
    });
  });

  it("wires get/update/delete under the id fallback, each carrying moveTo('..')", () => {
    const tree = restCrud({ list, create, get, update, delete: del });
    expect(tree.fallback?.name).toBe("id");
    const idChildren = tree.fallback?.subtree.children ?? {};
    expect(Object.keys(idChildren).sort()).toEqual(["delete", "get", "update"]);
    expect((idChildren.get as Node).meta.http).toMatchObject({ method: "GET", moveTo: ".." });
    expect((idChildren.update as Node).meta.http).toMatchObject({ method: "PUT", moveTo: ".." });
    expect((idChildren.delete as Node).meta.http).toMatchObject({ method: "DELETE", moveTo: ".." });
  });

  it("opts.idParam names the fallback param", () => {
    const tree = restCrud({ get }, { idParam: "bookId" });
    expect(tree.fallback?.name).toBe("bookId");
  });

  it("omits the fallback entirely when no id-scoped op is provided", () => {
    const tree = restCrud({ list, create });
    expect(tree.fallback).toBeUndefined();
  });

  it("omits list/create's root children entirely when neither is provided", () => {
    const tree = restCrud({ get });
    expect(tree.children).toEqual({});
  });

  it("restCrud({}) produces an empty resource with no children and no fallback", () => {
    const tree = restCrud({});
    expect(tree.children).toEqual({});
    expect(tree.fallback).toBeUndefined();
  });

  it("after httpProjection + applyMoveTo, list/create land as GET/POST at the resource root", () => {
    const tree = restCrud({ list, create });
    const routes = httpProjection(tree);
    // No leftover "list"/"create" path children — moveTo("..") collapsed them onto the root.
    expect(routes.children).toEqual({});
    expect(Object.keys(routes.methods ?? {}).sort()).toEqual(["GET", "POST"]);
  });

  it("after httpProjection + applyMoveTo, get/update/delete land at the id fallback root", () => {
    const tree = restCrud({ get, update, delete: del });
    const routes = httpProjection(tree);
    expect(routes.fallback?.subtree.children).toEqual({});
    expect(Object.keys(routes.fallback?.subtree.methods ?? {}).sort()).toEqual([
      "DELETE",
      "GET",
      "PUT",
    ]);
  });
});

// ============================================================================
// restCrud() — end-to-end HTTP round-trip, proving the moveTo("..")
// co-location actually dispatches correctly (not just a tree-shape assertion)
// ============================================================================

describe("restCrud() end-to-end over HTTP", () => {
  type Widget = { readonly id: string; readonly name: string };

  function makeWidgetsApi() {
    let seq = 0;
    const store = new Map<string, Widget>();
    const widgets = restCrud({
      list: (_: unknown): Widget[] => [...store.values()],
      create: (input: { name: string }): Widget => {
        const id = `widget-${++seq}`;
        const widget: Widget = { id, name: input.name };
        store.set(id, widget);
        return widget;
      },
      get: (input: { id: string }): Widget => {
        const widget = store.get(input.id);
        if (widget === undefined) throw new Error(`Not Found: ${input.id}`);
        return widget;
      },
      update: (input: { id: string; name: string }): Widget => {
        const existing = store.get(input.id);
        if (existing === undefined) throw new Error(`Not Found: ${input.id}`);
        const updated: Widget = { id: existing.id, name: input.name };
        store.set(input.id, updated);
        return updated;
      },
      delete: (input: { id: string }) => ({ deleted: store.delete(input.id) }),
    });
    return api({ widgets });
  }

  function jsonReq(method: string, url: string, body?: unknown): Request {
    return new Request(url, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  }

  it("GET / lists, POST / creates, GET/PUT/DELETE /:id co-locate onto the id fallback", async () => {
    const fetch = createFetch(makeWidgetsApi());

    // list — empty to start
    const listRes = await fetch(jsonReq("GET", "http://localhost/widgets"));
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([]);

    // create
    const createRes = await fetch(
      jsonReq("POST", "http://localhost/widgets", { name: "Widget One" }),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as Widget;
    expect(created.name).toBe("Widget One");

    // get — co-located onto the fallback root via moveTo("..")
    const getRes = await fetch(jsonReq("GET", `http://localhost/widgets/${created.id}`));
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(created);

    // update — same path, different method, same fallback co-location
    const updateRes = await fetch(
      jsonReq("PUT", `http://localhost/widgets/${created.id}`, { name: "Widget One (renamed)" }),
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as Widget;
    expect(updated.name).toBe("Widget One (renamed)");

    // list now reflects the create
    const listRes2 = await fetch(jsonReq("GET", "http://localhost/widgets"));
    expect(await listRes2.json()).toEqual([updated]);

    // delete — same path, third method, same fallback co-location
    const deleteRes = await fetch(jsonReq("DELETE", `http://localhost/widgets/${created.id}`));
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ deleted: true });

    // get after delete — handler throws a plain Error, no thrownErrorEncoder
    // configured, so it falls back to createFetch's default 500 response.
    const getAfterDeleteRes = await fetch(jsonReq("GET", `http://localhost/widgets/${created.id}`));
    expect(getAfterDeleteRes.status).toBe(500);
  });

  it("no path collision between /widgets (collection) and /widgets/:id (item)", () => {
    const tree = api({
      widgets: restCrud({ list: (_: unknown) => [], get: (_: { id: string }) => ({}) }),
    });
    const routes = httpProjection(tree);
    const collectionMethods = routeCandidatesForUrl(routes, "http://localhost/widgets").map(
      (c) => c.method,
    );
    const itemMethods = routeCandidatesForUrl(routes, "http://localhost/widgets/abc").map(
      (c) => c.method,
    );
    expect(collectionMethods).toEqual(["GET"]);
    expect(itemMethods).toEqual(["GET"]);
  });
});
