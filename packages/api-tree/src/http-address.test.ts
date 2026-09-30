import { describe, expect, test } from "bun:test";
import { httpAddressing } from "./http-address.ts";

describe("httpAddressing", () => {
  test("literal and template segments become static and param segments", () => {
    const a = httpAddressing(["/pets/{petId}"]);
    const r = a.addressPath("/pets/{petId}");
    expect(r.ok && r.segments).toEqual([
      { kind: "static", name: "pets" },
      { kind: "param", name: "petId" },
    ]);
  });

  test("a position keeps the first param name given to it", () => {
    const a = httpAddressing(["/pets/{id}", "/pets/{petId}/photo"]);
    a.addressPath("/pets/{id}");
    const r = a.addressPath("/pets/{petId}/photo");
    expect(r.ok && r.segments[1]).toEqual({ kind: "param", name: "id" });
    expect(r.ok && [...r.pathParamKeys]).toEqual([["petId", "id"]]);
    expect(r.ok && r.rebound).toEqual([{ own: "petId", bound: "id" }]);
  });

  test("mixed segments are refused", () => {
    expect(httpAddressing([]).addressPath("/f/{name}.json").ok).toBe(false);
  });

  test("the method key yields to a same-named static child", () => {
    const a = httpAddressing(["/items", "/items/delete", "/other/{x}"]);
    expect(a.operationKey("/items", "DELETE", "removeItem")).toEqual({
      key: "removeItem",
      collided: true,
    });
    expect(a.operationKey("/items", "GET", "listItems")).toEqual({ key: "get", collided: false });
  });
});
