// Cap'n Proto schema text (`.capnp`) -> ApiDescription: each `interface`
// method is an operation.
//
// Addressing: an interface's dotted path is a chain of static segments (a
// nested interface `Outer.Inner` is `[Outer, Inner]`) and the method name is
// the operation's own key, so `Store.get` is `[Store, get]`. Nesting in Cap'n
// Proto is namespacing only, so the address mirrors the qualified name. Each
// interface is a group at its own address carrying its description and
// `meta.capnp`.
//
// Input: the method's parameter list as one named-params object, each field
// carrying its implicit ordinal (its index) in `meta.ordinal`; a parameter
// with an explicit default is `optional` and carries `meta.default`. A
// method whose parameters name a struct type takes that struct's fields as
// the named-params object.
//
// Output: `void` for an empty result list, otherwise an `object` of the named
// results (a lone result stays a named field, not a bare value). A method
// whose results name a struct type returns that struct's object. Every
// result and parameter type is a `ref` into `defs` where it names a
// struct/enum.
//
// `meta.capnp` on an operation: `interface` (qualified name), `ordinal`,
// `typeParams`, `annotations`, `stream`, and `paramsType`/`resultsType` when a
// side names a struct. On an interface group: `kind`, `id`, `typeParams`,
// `extends`, `annotations`. On the root group: the file `id`.
//
// Capability-typed parameters/results (interface types) are `unknown` tagged
// `meta.capnpInterface`; `extends` is recorded, not expanded; generic
// parameters are `unknown` tagged `meta.capnpTypeParam`; generic
// instantiations keep their arguments in `meta.typeArgs`. All of these, plus
// `-> stream`, skipped `using`/`const`/`annotation` declarations and refs
// that resolve to no def in the file, are reported in `diagnostics`.
//
// Spec references: Cap'n Proto language reference, "Interfaces" (methods,
// parameter/result lists, named struct params, `extends`, streaming),
// "Generics", "Nested Types", "Annotations", "Unique IDs" and "Built-in
// Types" (https://capnproto.org/language.html).

import { t, types, withMeta, type TypeRef } from "@rhi-zone/fractal-type-ir";
import {
  buildCapnpRegistry,
  fromCapnpField,
  fromCapnpRegistry,
  parseCapnpSchema,
  resolveCapnpTypeName,
  type CapnpInterfaceDecl,
  type CapnpMethodDecl,
  type CapnpMethodParams,
  type CapnpRegistry,
  type CapnpTypeDesc,
} from "@rhi-zone/fractal-type-ir/from-capnp";
import type {
  ApiDescription,
  Diagnostic,
  Group,
  Imported,
  Operation,
  Segment,
} from "./api-description.ts";
import { addressKey, noInput } from "./api-description.ts";

type Obj = Record<string, unknown>;

function renderDesc(desc: CapnpTypeDesc, registry: CapnpRegistry, scope: string): string {
  const head = resolveCapnpTypeName(desc.name, registry, scope);
  if (desc.args === undefined) return head;
  return `${head}(${desc.args.map((a) => renderDesc(a, registry, scope)).join(", ")})`;
}

/** What a TypeRef (including its `meta`, where type arguments live) mentions. */
function scan(
  root: unknown,
  found: { refs: Set<string>; capabilities: Set<string>; typeArgs: Set<string> },
): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v !== "object" || v === null) continue;
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    const o = v as Obj;
    const shape = o.shape as { kind?: unknown; target?: unknown } | undefined;
    if (shape?.kind === "ref" && typeof shape.target === "string") {
      found.refs.add(shape.target);
      if (Array.isArray((o.meta as Obj | undefined)?.typeArgs)) found.typeArgs.add(shape.target);
    }
    const meta = o.meta as Obj | undefined;
    if (typeof meta?.capnpInterface === "string") found.capabilities.add(meta.capnpInterface);
    for (const child of Object.values(o)) stack.push(child);
  }
}

export function fromCapnpSchema(source: string): Imported {
  const diagnostics: Diagnostic[] = [];
  const file = parseCapnpSchema(source, {
    onError: (message) => diagnostics.push({ at: "schema", message: `${message}; skipped` }),
  });
  const registry = buildCapnpRegistry(file);
  const defs = fromCapnpRegistry(registry);

  for (const s of file.skipped) {
    const where = s.scope !== undefined ? `${s.scope}` : "schema";
    const label = s.name !== undefined ? `${s.kind} "${s.name}"` : `${s.kind} declaration`;
    diagnostics.push({
      at: where,
      message: `${label}${s.line !== undefined ? ` (line ${s.line})` : ""} is not represented${
        s.kind === "using" ? "; names it introduces resolve to no def" : ""
      }`,
    });
  }

  const operations: Operation[] = [];
  const groups: Group[] = [];
  const usedTypes: { at: string; ref: TypeRef }[] = [];

  if (file.id !== undefined) groups.push({ address: [], meta: { capnp: { id: file.id } } });

  const interfacePaths = new Set<string>();
  for (const [name, entry] of registry) if (entry.kind === "interface") interfacePaths.add(name);

  // A method sits at `[...interface path, name]`; a group and an operation
  // cannot share an address.
  const takenAddresses = new Set<string>(
    [...interfacePaths].map((p) => addressKey(p.split(".").map(staticSegment))),
  );

  for (const [qualified, entry] of registry) {
    if (entry.kind === "struct" && entry.decl.typeParams !== undefined) {
      diagnostics.push({
        at: qualified,
        message: `generic struct ${qualified}(${entry.decl.typeParams.join(", ")}) is defined once with its parameters as unknown; instantiations are refs with meta.typeArgs`,
      });
    }
    if (entry.kind !== "interface") continue;
    const iface = entry.decl;
    const prefix = qualified.split(".").map(staticSegment);

    const capnp: Obj = { kind: "interface" };
    if (iface.id !== undefined) capnp.id = iface.id;
    if (iface.typeParams !== undefined) capnp.typeParams = iface.typeParams;
    if (iface.extends.length > 0) {
      const bases = iface.extends.map((e) => renderDesc(e, registry, qualified));
      capnp.extends = bases;
      diagnostics.push({
        at: qualified,
        message: `extends ${bases.join(", ")}: inherited methods are not expanded onto ${qualified}`,
      });
    }
    if (iface.annotations.length > 0) capnp.annotations = iface.annotations;
    if (iface.typeParams !== undefined) {
      diagnostics.push({
        at: qualified,
        message: `generic interface ${qualified}(${iface.typeParams.join(", ")}): type parameters are unknown`,
      });
    }
    const groupMeta: Obj = { capnp };
    if (iface.description !== undefined) groupMeta.description = iface.description;
    groups.push({ address: prefix, meta: groupMeta });

    for (const method of iface.methods) {
      const at = `${qualified}.${method.name}`;
      const address = [...prefix, staticSegment(method.name)];
      const key = addressKey(address);
      if (takenAddresses.has(key)) {
        diagnostics.push({
          at,
          message: `another method or nested interface already occupies address "${key}"; skipped`,
        });
        continue;
      }
      takenAddresses.add(key);
      operations.push(
        convertMethod(
          iface,
          method,
          qualified,
          at,
          address,
          registry,
          defs,
          diagnostics,
          usedTypes,
        ),
      );
    }
  }

  const api: ApiDescription = { operations, groups, defs };

  // Every ref must resolve against `defs`; capabilities and unapplied type
  // arguments are reported where they are used.
  for (const [name, def] of Object.entries(defs)) usedTypes.push({ at: name, ref: def });
  const reported = new Set<string>();
  const report = (at: string, message: string): void => {
    const k = `${at}\u0000${message}`;
    if (reported.has(k)) return;
    reported.add(k);
    diagnostics.push({ at, message });
  };
  for (const { at, ref } of usedTypes) {
    const found = {
      refs: new Set<string>(),
      capabilities: new Set<string>(),
      typeArgs: new Set<string>(),
    };
    scan(ref, found);
    for (const target of found.refs) {
      if (defs[target] === undefined) {
        report(
          at,
          `type "${target}" is not defined in this schema (imported or unresolved); left as a dangling ref`,
        );
      }
    }
    for (const cap of found.capabilities) {
      report(
        at,
        `capability of interface ${cap} is represented as unknown; it cannot be passed over a data transport`,
      );
    }
    for (const target of found.typeArgs) {
      report(
        at,
        `generic instantiation of ${target}: type arguments are kept in meta.typeArgs, not applied to the def`,
      );
    }
  }

  return { api, diagnostics };
}

const staticSegment = (name: string): Segment => ({ kind: "static", name });

function convertMethod(
  iface: CapnpInterfaceDecl,
  method: CapnpMethodDecl,
  qualified: string,
  at: string,
  address: readonly Segment[],
  registry: CapnpRegistry,
  defs: Readonly<Record<string, TypeRef>>,
  diagnostics: Diagnostic[],
  usedTypes: { at: string; ref: TypeRef }[],
): Operation {
  const typeParams = new Set([...(iface.typeParams ?? []), ...(method.typeParams ?? [])]);
  const capnp: Obj = { interface: qualified };
  if (method.ordinal !== undefined) capnp.ordinal = method.ordinal;
  if (method.typeParams !== undefined) {
    capnp.typeParams = method.typeParams;
    diagnostics.push({
      at,
      message: `generic method [${method.typeParams.join(", ")}]: type parameters are unknown`,
    });
  }
  if (method.annotations.length > 0) capnp.annotations = method.annotations;

  const side = (
    which: "params" | "results",
    spec: CapnpMethodParams,
  ): { ref: TypeRef | undefined } => {
    if (spec.kind === "list") {
      const fields: Record<string, TypeRef> = {};
      spec.params.forEach((p, index) => {
        let ref = fromCapnpField(
          {
            kind: "field",
            name: p.name,
            ordinal: index,
            type: p.type,
            ...(p.default !== undefined ? { default: p.default } : {}),
            annotations: p.annotations,
            ...(p.description !== undefined ? { description: p.description } : {}),
          },
          registry,
          qualified,
          typeParams,
        );
        if (which === "params" && p.default !== undefined) ref = withMeta(ref, { optional: true });
        fields[p.name] = ref;
      });
      return { ref: t(types.object(fields)) };
    }
    const resolved = resolveCapnpTypeName(spec.type.name, registry, qualified);
    capnp[which === "params" ? "paramsType" : "resultsType"] = renderDesc(
      spec.type,
      registry,
      qualified,
    );
    const target = defs[resolved];
    if (registry.get(resolved)?.kind !== "struct" || target === undefined) {
      diagnostics.push({
        at,
        message: `${which} name "${spec.type.name}", which is not a struct defined in this schema; ${
          which === "params" ? "input is empty" : "output is left unspecified"
        }`,
      });
      return { ref: undefined };
    }
    if (spec.type.args !== undefined) {
      diagnostics.push({
        at,
        message: `${which} name generic struct ${renderDesc(spec.type, registry, qualified)}: type arguments are not applied`,
      });
    }
    return { ref: target };
  };

  const input = side("params", method.params).ref ?? noInput();
  usedTypes.push({ at, ref: input });

  let output: TypeRef | undefined;
  if (method.results.kind === "stream") {
    capnp.stream = true;
    output = t(types.void);
    diagnostics.push({
      at,
      message:
        "`-> stream` is a flow-controlled call with no results; kept as meta.capnp.stream and not mapped to meta.tags.streaming",
    });
  } else {
    const r = side("results", method.results).ref;
    if (r === undefined) output = undefined;
    else if (method.results.kind === "list" && method.results.params.length === 0) {
      output = t(types.void);
    } else output = r;
  }
  if (output !== undefined) usedTypes.push({ at, ref: output });

  const meta: Obj = { capnp };
  if (method.description !== undefined) meta.description = method.description;

  return {
    address,
    input,
    ...(output !== undefined ? { output } : {}),
    meta,
  };
}
