// The addressing convention shared by importers of HTTP-shaped API
// descriptions (OpenAPI, RAML, Postman, ...): an operation's address mirrors
// its URL path, a literal segment is a static segment, a whole-segment
// `{name}` template is a param segment, and the lowercased HTTP method is
// the operation's own key. Changing that convention here changes it for
// every such importer at once.
//
// Paths are given in `{name}` template syntax; an importer whose format
// spells templates differently rewrites them first.

import type { Segment } from "./api-description.ts";

export type AddressedPath =
  | {
      readonly ok: true;
      readonly segments: readonly Segment[];
      /** Each template name in this path mapped to the param-segment name it is bound to (they differ only after a rebind). */
      readonly pathParamKeys: ReadonlyMap<string, string>;
      /** Template names rebound to a name another path already gave the same position. */
      readonly rebound: readonly { readonly own: string; readonly bound: string }[];
    }
  | { readonly ok: false; readonly reason: string };

export type HttpAddressing = {
  /** Address of `path`. Positions are bound to the first param name any earlier call gave them, so call this in document order. */
  readonly addressPath: (path: string) => AddressedPath;
  /** The operation key for `method` at `path`: the lowercased method, or `fallbackKey` when a static child segment of that name exists at the same position among the paths this addressing was created with. */
  readonly operationKey: (
    path: string,
    method: string,
    fallbackKey: string,
  ) => { readonly key: string; readonly collided: boolean };
};

const split = (path: string): string[] => path.split("/").filter((s) => s.length > 0);
const templateName = (seg: string): string | undefined => /^\{([^{}]+)\}$/.exec(seg)?.[1];
const positionOf = (segs: readonly string[]): string =>
  segs.map((s) => (templateName(s) !== undefined ? "{}" : `=${s}`)).join("/");

export function httpAddressing(allPaths: readonly string[]): HttpAddressing {
  const positions = new Set(allPaths.map((p) => positionOf(split(p))));
  const paramNameAt = new Map<string, string>();

  const addressPath = (path: string): AddressedPath => {
    const segments: Segment[] = [];
    const pathParamKeys = new Map<string, string>();
    const rebound: { own: string; bound: string }[] = [];
    let prefix = "";
    for (const raw of split(path)) {
      const own = templateName(raw);
      if (own !== undefined) {
        const bound = paramNameAt.get(prefix) ?? own;
        paramNameAt.set(prefix, bound);
        if (bound !== own) rebound.push({ own, bound });
        pathParamKeys.set(own, bound);
        segments.push({ kind: "param", name: bound });
        prefix += "/{}";
      } else if (raw.includes("{") || raw.includes("}")) {
        return {
          ok: false,
          reason: `segment "${raw}" mixes literal text and a template expression`,
        };
      } else {
        segments.push({ kind: "static", name: raw });
        prefix += `/=${raw}`;
      }
    }
    return { ok: true, segments, pathParamKeys, rebound };
  };

  const operationKey = (path: string, method: string, fallbackKey: string) => {
    const key = method.toLowerCase();
    const segs = split(path);
    const collided = positions.has(positionOf([...segs, key]));
    return collided ? { key: fallbackKey, collided } : { key, collided };
  };

  return { addressPath, operationKey };
}
