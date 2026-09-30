// OpenAPI Overlay Specification (1.0.x, 1.1.x, 1.2.x) applied to any JSON
// document: `applyOverlay(document, overlay)` -> `{ document, diagnostics }`.
// Targets are RFC 9535 JSONPath queries, so nothing here is OpenAPI-specific.
//
// Contract:
//   - Pure: neither argument is mutated, and the result shares no structure
//     with either (values copied out of the overlay are cloned on insertion).
//   - Actions apply in order; each sees the previous action's result.
//   - A malformed overlay, an unsupported version or feature, an invalid or
//     unsupported JSONPath, and anything the spec defines as an error (mixed
//     node kinds, incompatible merge, non-singular `copy`) throw
//     `OverlayError`. No partial result is returned.
//   - Things that are not errors go to `diagnostics` (`at` is a JSON pointer
//     into the overlay): a target selecting zero nodes, an action with nothing
//     to do, an unrecognized action field. Zero nodes is never an error.
//   - `extends` and `$self` identify a target document; choosing which
//     document to apply to is the caller's job, so they are not interpreted.
//   - The overlay's `overlay` field selects the rules. Patch versions are
//     ignored. Rules by minor version:
//       1.0  update merges objects (a non-object property value replaces the
//            target's, so an array replaces an array); an array target gets
//            the update value appended as one entry; only object and array
//            nodes are valid targets.
//       1.1  adds `copy`; per-property merge (primitive replaces, array
//            concatenates, object recurses, anything else is an error); array
//            target with an array update concatenates; primitive targets are
//            replaced or removed; two or more selected nodes must share a
//            kind.
//       1.2  adds `components.actions` and `$ref` reusable actions.
//   - A node selected twice by one target is acted on once.
//   - JSON `null` counts as a primitive.
//
// Spec references: Overlay Specification 1.0.0, 1.1.0, 1.2.0 (Versions,
// Overlay Object, Action Object, Components Object, Reusable Action Object,
// Reusable Action Reference Object, RFC9535 Compliance); RFC 9535 (JSONPath),
// evaluated by json-p3 with its default, extension-free environment; RFC 6901
// §3 (escaping of `components.actions` keys in `$ref`).

import { query } from "json-p3";
import type { Diagnostic } from "./api-description.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type OverlayAction = {
  readonly target: string;
  readonly description?: string;
  readonly update?: Json;
  readonly copy?: string;
  readonly remove?: boolean;
  readonly [extension: `x-${string}`]: Json;
};

export type ReusableActionReference = {
  readonly $ref: string;
  readonly target: string;
  readonly description?: string;
  readonly [extension: `x-${string}`]: Json;
};

export type ReusableAction = {
  readonly description?: string;
  readonly fields?: Omit<OverlayAction, "target"> | Record<string, Json>;
  readonly [extension: `x-${string}`]: Json;
};

export type Overlay = {
  readonly overlay: string;
  readonly $self?: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly extends?: string;
  readonly actions: readonly (OverlayAction | ReusableActionReference)[];
  readonly components?: { readonly actions?: Readonly<Record<string, ReusableAction>> };
  readonly [extension: `x-${string}`]: Json;
};

export type OverlayResult = {
  readonly document: Json;
  readonly diagnostics: readonly Diagnostic[];
};

/** `at` is a JSON pointer into the overlay locating the offending part. */
export class OverlayError extends Error {
  readonly at: string;
  constructor(at: string, message: string) {
    super(`overlay ${at || "/"}: ${message}`);
    this.name = "OverlayError";
    this.at = at;
  }
}

type Obj = { [key: string]: Json };
type Location = readonly (string | number)[];
type Kind = "object" | "array" | "primitive";

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const kindOf = (v: Json): Kind => (Array.isArray(v) ? "array" : isObj(v) ? "object" : "primitive");
const clone = <T extends Json>(v: T): T => structuredClone(v);
const isExtension = (key: string): boolean => key.startsWith("x-");

const escapeToken = (s: string | number): string =>
  String(s).replaceAll("~", "~0").replaceAll("/", "~1");
const pointer = (loc: Location): string => loc.map((k) => `/${escapeToken(k)}`).join("");

/** Own-property write that stays safe for keys like `__proto__`. */
function setOwn(target: Obj | Json[], key: string | number, value: Json): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function getAt(doc: Json, loc: Location): Json {
  let cur = doc;
  for (const k of loc) cur = (cur as Obj | Json[])[k as never];
  return cur;
}

// Descendants before ancestors, higher array indices before lower, so each
// removal leaves every remaining location valid.
function removalOrder(a: Location, b: Location): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return y - x;
    return String(x) < String(y) ? -1 : 1;
  }
  return b.length - a.length;
}

type Features = {
  /** copy, per-property merge rules, primitive targets, array concatenation. */
  readonly v11: boolean;
  /** components.actions and `$ref`. */
  readonly v12: boolean;
};

function featuresOf(overlay: Obj): Features {
  const version = overlay.overlay;
  if (typeof version !== "string")
    throw new OverlayError("/overlay", "`overlay` must be a version string");
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m)
    throw new OverlayError(
      "/overlay",
      `\`overlay\` must look like major.minor.patch, got ${JSON.stringify(version)}`,
    );
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== 1 || minor > 2) {
    throw new OverlayError(
      "/overlay",
      `unsupported overlay version ${version} (supported: 1.0.x, 1.1.x, 1.2.x)`,
    );
  }
  return { v11: minor >= 1, v12: minor >= 2 };
}

type ResolvedAction = {
  readonly target: string;
  readonly update: { readonly value: Json } | undefined;
  readonly copy: string | undefined;
  readonly remove: boolean;
};

const REF_PREFIX = "#/components/actions/";
const ACTION_KEYS = new Set(["target", "description", "update", "copy", "remove"]);
const REFERENCE_KEYS = new Set(["$ref", "target", "description"]);

function unescapeRefKey(raw: string, at: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new OverlayError(at, `$ref has an invalid percent-encoding: ${JSON.stringify(raw)}`);
  }
  return decoded.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveAction(
  raw: unknown,
  index: number,
  overlay: Obj,
  features: Features,
  diagnostics: Diagnostic[],
): ResolvedAction {
  const at = `/actions/${index}`;
  if (!isObj(raw)) throw new OverlayError(at, "an action must be an object");

  let fields: Obj = raw;
  let fieldsAt = at;
  if (has(raw, "$ref")) {
    if (!features.v12)
      throw new OverlayError(`${at}/$ref`, "reusable actions need overlay 1.2.0 or later");
    const ref = raw.$ref;
    if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX)) {
      throw new OverlayError(`${at}/$ref`, `$ref must be a string starting with ${REF_PREFIX}`);
    }
    const rest = ref.slice(REF_PREFIX.length);
    if (rest.includes("/")) {
      throw new OverlayError(
        `${at}/$ref`,
        "$ref must name exactly one key under components.actions (escape `/` as ~1)",
      );
    }
    const key = unescapeRefKey(rest, `${at}/$ref`);
    const components = overlay.components;
    const table = isObj(components) ? components.actions : undefined;
    const reusable = isObj(table) && has(table, key) ? table[key] : undefined;
    if (!isObj(reusable))
      throw new OverlayError(
        `${at}/$ref`,
        `no reusable action ${JSON.stringify(key)} in components.actions`,
      );
    const base = reusable.fields === undefined ? {} : reusable.fields;
    if (!isObj(base))
      throw new OverlayError(
        `/components/actions/${escapeToken(key)}/fields`,
        "`fields` must be an object",
      );
    if (has(base, "target")) {
      throw new OverlayError(
        `/components/actions/${escapeToken(key)}/fields/target`,
        "a reusable action's `fields` must not contain `target`",
      );
    }
    for (const k of Object.keys(raw)) {
      if (!REFERENCE_KEYS.has(k) && !isExtension(k)) {
        throw new OverlayError(
          `${at}/${escapeToken(k)}`,
          `a reusable action reference may only supply $ref, target and description, not ${JSON.stringify(k)}`,
        );
      }
    }
    fields = { ...base, target: raw.target ?? null };
    if (has(raw, "description")) fields.description = raw.description ?? null;
    fieldsAt = `/components/actions/${escapeToken(key)}/fields`;
  }

  const { target } = fields;
  if (typeof target !== "string")
    throw new OverlayError(`${at}/target`, "`target` is required and must be a JSONPath string");
  for (const k of Object.keys(fields)) {
    if (!ACTION_KEYS.has(k) && !isExtension(k) && k !== "$ref") {
      diagnostics.push({
        at: `${fieldsAt}/${escapeToken(k)}`,
        message: `unknown action field ${JSON.stringify(k)} ignored`,
      });
    }
  }
  const remove = fields.remove;
  if (remove !== undefined && typeof remove !== "boolean")
    throw new OverlayError(`${at}/remove`, "`remove` must be a boolean");
  const copy = fields.copy;
  if (copy !== undefined) {
    if (!features.v11) throw new OverlayError(`${at}/copy`, "`copy` needs overlay 1.1.0 or later");
    if (typeof copy !== "string")
      throw new OverlayError(`${at}/copy`, "`copy` must be a JSONPath string");
  }
  const hasUpdate = has(fields, "update");
  if (hasUpdate && copy !== undefined && remove !== true) {
    throw new OverlayError(
      at,
      "`update` and `copy` are both set, and the spec says each one is ignored when the other is present",
    );
  }
  return {
    target,
    update: hasUpdate ? { value: fields.update as Json } : undefined,
    copy,
    remove: remove === true,
  };
}

function select(expression: string, doc: Json, at: string): { value: Json; location: Location }[] {
  let nodes: { value: unknown; location: Location }[];
  try {
    nodes = query(expression, doc as never).nodes;
  } catch (e) {
    throw new OverlayError(
      at,
      `${JSON.stringify(expression)} is not usable as an RFC 9535 JSONPath: ${(e as Error).message}`,
    );
  }
  const seen = new Set<string>();
  const out: { value: Json; location: Location }[] = [];
  for (const n of nodes) {
    const key = JSON.stringify(n.location);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: n.value as Json, location: n.location });
  }
  return out;
}

function merge(target: Obj, source: Obj, features: Features, at: string, loc: Location): void {
  for (const key of Object.keys(source)) {
    const sv = source[key]!;
    if (!has(target, key)) {
      setOwn(target, key, clone(sv));
      continue;
    }
    const tv = target[key]!;
    const here = [...loc, key];
    if (kindOf(tv) === "object" && kindOf(sv) === "object") {
      merge(tv as Obj, sv as Obj, features, at, here);
    } else if (!features.v11) {
      setOwn(target, key, clone(sv));
    } else if (kindOf(tv) === "array" && kindOf(sv) === "array") {
      (tv as Json[]).push(...clone(sv as Json[]));
    } else if (kindOf(tv) === "primitive" && kindOf(sv) === "primitive") {
      setOwn(target, key, sv);
    } else {
      throw new OverlayError(
        at,
        `cannot merge a${kindOf(sv) === "array" ? "n" : ""} ${kindOf(sv)} into a${kindOf(tv) === "array" ? "n" : ""} ${kindOf(tv)} at document ${pointer(here)}`,
      );
    }
  }
}

function updateNode(doc: Json, loc: Location, value: Json, features: Features, at: string): Json {
  const current = getAt(doc, loc);
  const kind = kindOf(current);
  const where = `document ${pointer(loc) || "root"}`;
  if (kind === "object") {
    if (!isObj(value))
      throw new OverlayError(
        at,
        `${where} is an object, so the value merged into it must be an object`,
      );
    merge(current as Obj, value, features, at, loc);
    return doc;
  }
  if (kind === "array") {
    if (features.v11 && Array.isArray(value)) (current as Json[]).push(...clone(value));
    else (current as Json[]).push(clone(value));
    return doc;
  }
  if (!features.v11) {
    throw new OverlayError(
      at,
      `${where} is a primitive, and overlay 1.0 only targets objects and arrays`,
    );
  }
  if (kindOf(value) !== "primitive") {
    throw new OverlayError(
      at,
      `${where} is a primitive, so the value replacing it must be a primitive`,
    );
  }
  if (loc.length === 0) return clone(value);
  const parent = getAt(doc, loc.slice(0, -1)) as Obj | Json[];
  setOwn(parent, loc[loc.length - 1] as never, clone(value));
  return doc;
}

function removeNodes(
  doc: Json,
  nodes: { value: Json; location: Location }[],
  features: Features,
  at: string,
): void {
  for (const { value, location } of nodes) {
    if (location.length === 0)
      throw new OverlayError(
        at,
        "the document root is contained in nothing, so it cannot be removed",
      );
    if (!features.v11 && kindOf(value) === "primitive") {
      throw new OverlayError(
        at,
        `document ${pointer(location)} is a primitive, and overlay 1.0 only targets objects and arrays`,
      );
    }
  }
  for (const { location } of [...nodes].sort((a, b) => removalOrder(a.location, b.location))) {
    const parent = getAt(doc, location.slice(0, -1));
    const key = location[location.length - 1]!;
    if (Array.isArray(parent)) parent.splice(key as number, 1);
    else delete (parent as Obj)[key as string];
  }
}

function checkOverlay(overlay: unknown): Obj {
  if (!isObj(overlay)) throw new OverlayError("", "an overlay must be an object");
  const info = overlay.info;
  if (!isObj(info) || typeof info.title !== "string" || typeof info.version !== "string") {
    throw new OverlayError("/info", "`info` is required and needs string `title` and `version`");
  }
  if (!Array.isArray(overlay.actions) || overlay.actions.length === 0) {
    throw new OverlayError("/actions", "`actions` is required and must hold at least one action");
  }
  return overlay;
}

export function applyOverlay(document: Json, overlay: Overlay): OverlayResult {
  const o = checkOverlay(overlay);
  const features = featuresOf(o);
  const diagnostics: Diagnostic[] = [];
  let doc = clone(document);

  (o.actions as Json[]).forEach((rawAction, index) => {
    const at = `/actions/${index}`;
    const action = resolveAction(rawAction, index, o, features, diagnostics);
    const nodes = select(action.target, doc, `${at}/target`);

    let value: Json | undefined;
    if (!action.remove && action.copy !== undefined) {
      const sources = select(action.copy, doc, `${at}/copy`);
      if (sources.length !== 1) {
        throw new OverlayError(
          `${at}/copy`,
          `\`copy\` must select exactly one node, ${JSON.stringify(action.copy)} selected ${sources.length}`,
        );
      }
      value = clone(sources[0]!.value);
    } else if (!action.remove && action.update !== undefined) {
      value = action.update.value;
    }

    if (!action.remove && value === undefined) {
      diagnostics.push({
        at,
        message: "action has none of `remove`, `update` or `copy`, so it changes nothing",
      });
      return;
    }
    if (nodes.length === 0) {
      diagnostics.push({
        at: `${at}/target`,
        message: `${JSON.stringify(action.target)} selected no nodes; the action was skipped`,
      });
      return;
    }
    if (action.remove) {
      removeNodes(doc, nodes, features, at);
      return;
    }
    if (features.v11) {
      const kinds = new Set(nodes.map((n) => kindOf(n.value)));
      if (kinds.size > 1) {
        throw new OverlayError(
          at,
          `${JSON.stringify(action.target)} selected nodes of mixed kinds (${[...kinds].join(", ")}); all must be objects, all arrays or all primitives`,
        );
      }
    }
    for (const { location } of nodes) doc = updateNode(doc, location, value as Json, features, at);
  });

  return { document: doc, diagnostics };
}
