// WSDL 1.1 and WSDL 2.0 documents (XML text) -> ApiDescription. Both versions
// are covered; the embedded XML Schema (`types`) is converted by type-ir's
// `from-xsd`.
//
// Addressing: an operation's address is `[portType, operation]` (WSDL 1.1) or
// `[interface, operation]` (WSDL 2.0), both static segments. The abstract
// interface owns its operations one-to-one, whereas services, ports and
// bindings are deployment: one interface is routinely exposed through several
// bindings (SOAP 1.1 and 1.2) and several endpoints, and addressing by port
// would repeat every operation per port. Services, ports and endpoints are
// recorded on the interface's group and on each operation (below). An
// operation name repeated within one portType (WSDL 1.1 allows overloading by
// distinct input names) is keyed `name_<input name>` (else `name_<n>`) for
// every overload, and reported. WSDL 2.0 `extends` is kept on the group; inherited operations
// are not repeated on the derived interface (reported).
//
// No `meta.http`: every SOAP binding is a single POST endpoint, so there is no
// URL/method placement to state. The HTTP bindings (WSDL 1.1 §4, WSDL 2.0
// whttp) are kept verbatim under `meta.wsdl` and reported, not turned into
// `meta.http`, because their locations are relative to a per-endpoint address.
//
// Input: a named-params object. Each part of the operation's input message is
// a field named by the part. WSDL 2.0's message is one element, and is treated
// as one part named by that element. When the message is a single part that is
// an element named like the operation (document/literal "wrapped"), the
// element's children are the fields instead. Output: no parts or `#none` ->
// `void`; one part -> that part's type (a wrapper element's type is the object
// of its children); several parts -> an object of the parts. `#any`/`#other`
// content and an unresolvable type are `unknown` (`#other` and unresolvable types are reported).
//
// Message exchange patterns, described from the service's side (the same
// direction convention as from-asyncapi.ts):
//   - one-way (1.1) / in-only, robust-in-only (2.0): input, output `void`.
//   - request-response / in-out: input and output. in-opt-out: the same, the
//     response being optional (reported).
//   - notification / out-only, robust-out-only, and solicit-response / out-in,
//     out-opt-in: the service sends first, so input is empty and output is
//     `stream(message)` with `meta.tags.streaming`, as for an AsyncAPI `send`
//     operation. What the client must send back in the solicit patterns is a
//     client-to-service message that has no representation yet: it is kept
//     under `meta.wsdl.reply` and reported.
// The pattern itself is always kept as `meta.wsdl.pattern`.
//
// Faults (`fault`, `infault`, `outfault`) are kept verbatim under
// `meta.wsdl.faults` and reported once per operation; error types have no
// representation yet.
//
// Verbatim under `meta.wsdl` on each operation: `version`, `portType` or
// `interface`, `targetNamespace`, `operation`, `pattern`, `input`/`output`/
// `reply` (message name, parts with their element/type as `{namespace}local`),
// `parameterOrder`, `faults`, `style` and `safe` (2.0), and `bindings`: one
// entry per binding of the interface with the SOAP details (`soap.binding`:
// style, transport, version, ...; `soap.operation`: soapAction, style, ...;
// `soap.input`/`soap.output`: body use/namespace/encodingStyle/parts and
// headers; `soap.faults`), the HTTP details (`http`), any other extension
// (`extensions`, generic `{name, attributes, children}`), and `ports`: every
// service port/endpoint bound to it with its `address`. SOAP headers are input
// fields when their part is in the input message, and are reported.
//
// `meta.description` comes from `wsdl:documentation`. `meta.tags.readOnly`
// from WSDL 2.0 `wsdlx:safe="true"`.
//
// Reported, not represented: `wsdl:import` / `import` / `include` (not
// followed), extension elements inside `types` other than schemas, bindings
// or ports that reference something undeclared, MIME bindings, unresolvable
// messages, WSDL 2.0 RPC/IRI styles beyond keeping `style`, and everything
// from-xsd reports.
//
// Spec references: WSDL 1.1 (W3C Note 2001-03-15) §2.1.1 (import), §2.2 Types,
// §2.3 Messages, §2.4 Port Types (§2.4.1 one-way, §2.4.2 request-response,
// §2.4.3 solicit-response, §2.4.4 notification, §2.4.5 names of elements
// within an operation, §2.4.6 parameter order), §2.5 Bindings, §2.6 Ports,
// §2.7 Services, §3.3 soap:binding, §3.4 soap:operation, §3.5 soap:body, §3.6
// soap:fault, §3.7 soap:header and soap:headerfault, §3.8 soap:address, §4
// HTTP GET & POST binding, §5 MIME binding. WSDL 2.0 Part 1 (W3C Rec
// 2007-06-26) §2.1 Description, §2.2 Interface, §2.3 Interface Fault, §2.4
// Interface Operation (§2.4.1.1 message exchange pattern, §2.4.2.2 pattern,
// §2.4.3 its default in-out),
// §2.5 Interface Message Reference, §2.6 Interface Fault Reference, §2.7
// Binding, §2.12 Service, §2.13 Endpoint, §3 Types, §4 Modularizing. WSDL 2.0
// Part 2 Adjuncts §2.3 predefined message exchange patterns (in-only,
// robust-in-only, in-out), §3.1 operation safety (wsdlx:safe), §5 SOAP
// binding, §6 HTTP binding; WSDL 2.0 Additional MEPs (W3C Note 2007-06-26)
// §2.2 (in-opt-out, out-only, robust-out-only, out-in, out-opt-in). XML
// Namespaces 1.0 for QName resolution.

import { t, types, type TypeRef } from "@rhi-zone/fractal-type-ir";
import {
  attrNs,
  childrenNs,
  fromXsd,
  resolveQName,
  textContent,
  XSD_NS,
  type XmlElement,
  type XsdName,
  type XsdTypes,
} from "@rhi-zone/fractal-type-ir/from-xsd";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  noInput,
  type Diagnostic,
  type Group,
  type Imported,
  type Operation,
} from "./api-description.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type WsdlVersion = "1.1" | "2.0";
export type ImportedWsdl = Imported & { readonly version: WsdlVersion };

const NS = {
  wsdl11: "http://schemas.xmlsoap.org/wsdl/",
  soap11: "http://schemas.xmlsoap.org/wsdl/soap/",
  soap12: "http://schemas.xmlsoap.org/wsdl/soap12/",
  http11: "http://schemas.xmlsoap.org/wsdl/http/",
  mime11: "http://schemas.xmlsoap.org/wsdl/mime/",
  wsdl20: "http://www.w3.org/ns/wsdl",
  wsoap: "http://www.w3.org/ns/wsdl/soap",
  whttp: "http://www.w3.org/ns/wsdl/http",
  wsdlx: "http://www.w3.org/ns/wsdl-extensions",
} as const;

// ============================================================================
// XML text -> XmlElement
// ============================================================================

const charRefs = (s: string): string =>
  s.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (m, code: string) => {
    const n = code.startsWith("x") ? Number.parseInt(code.slice(1), 16) : Number(code);
    return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });

/** Parse XML text into an `XmlElement` tree with namespaces resolved. Throws on malformed XML and on a DOCTYPE declaration. */
export function parseXml(text: string): XmlElement {
  if (/<!DOCTYPE/i.test(text)) throw new Error("parseXml: DOCTYPE declarations are not supported");
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    throw new Error(`parseXml: ${valid.err.msg} (line ${valid.err.line})`);
  }
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  const nodes = parser.parse(text) as Obj[];
  const build = (node: Obj, parent: Readonly<Record<string, string>>): XmlElement | undefined => {
    const name = Object.keys(node).find((k) => k !== ":@" && k !== "#text");
    if (name === undefined) return undefined;
    const rawAttrs = isObj(node[":@"]) ? node[":@"] : {};
    const attrs: Record<string, string> = {};
    const scope: Record<string, string> = { ...parent };
    for (const [k, v] of Object.entries(rawAttrs)) {
      const key = k.slice(2);
      const value = charRefs(String(v));
      if (key === "xmlns") scope[""] = value;
      else if (key.startsWith("xmlns:")) scope[key.slice(6)] = value;
      else attrs[key] = value;
    }
    const i = name.indexOf(":");
    const children: XmlElement[] = [];
    let own = "";
    for (const child of node[name] as Obj[]) {
      if ("#text" in child) own += charRefs(String(child["#text"]));
      else {
        const built = build(child, scope);
        if (built !== undefined) children.push(built);
      }
    }
    return {
      name,
      local: i < 0 ? name : name.slice(i + 1),
      ns: scope[i < 0 ? "" : name.slice(0, i)],
      attrs,
      scope,
      children,
      text: own,
    };
  };
  const root = nodes
    .map((n) => build(n, { xml: "http://www.w3.org/XML/1998/namespace" }))
    .find((e) => e !== undefined);
  if (root === undefined) throw new Error("parseXml: the document has no root element");
  return root;
}

// ============================================================================
// Helpers
// ============================================================================

const clark = (n: XsdName): string => `{${n.ns}}${n.local}`;
const kids = (el: XmlElement, ns: string, local: string): XmlElement[] => childrenNs(el, ns, local);
const kid = (el: XmlElement, ns: string, local: string): XmlElement | undefined =>
  kids(el, ns, local)[0];
const words = (v: string | undefined): string[] =>
  (v ?? "").split(/\s+/).filter((s) => s.length > 0);

/** `el`'s attributes; a prefixed attribute is keyed `{namespace}local`. */
function attrsOf(el: XmlElement, skip: readonly string[] = []): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(el.attrs)) {
    const i = key.indexOf(":");
    if (i < 0) {
      if (!skip.includes(key)) out[key] = value;
    } else {
      const ns = el.scope[key.slice(0, i)];
      out[ns === undefined ? key : `{${ns}}${key.slice(i + 1)}`] = value;
    }
  }
  return out;
}

/** The attributes of `el` in namespace `ns`, keyed by local name. */
function attrsIn(el: XmlElement, ns: string): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(el.attrs)) {
    const i = key.indexOf(":");
    if (i > 0 && el.scope[key.slice(0, i)] === ns) out[key.slice(i + 1)] = value;
  }
  return out;
}

/** An arbitrary extension element as data. */
function extJson(el: XmlElement): Obj {
  const children = el.children.map(extJson);
  const text = el.text.trim();
  return {
    name: `{${el.ns ?? ""}}${el.local}`,
    attributes: attrsOf(el),
    ...(children.length > 0 ? { children } : {}),
    ...(text.length > 0 ? { text } : {}),
  };
}

const compact = (o: Obj): Obj =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const isEmpty = (o: Obj): boolean => Object.keys(o).length === 0;

// ============================================================================
// Version-neutral operation model
// ============================================================================

type Part = {
  readonly name: string;
  readonly element?: XsdName;
  readonly type?: XsdName;
  /** WSDL 2.0 `#any`, `#other`, or an absent element attribute. */
  readonly open?: string;
};

type MessageRef = {
  readonly label?: string;
  readonly message?: string;
  readonly parts: readonly Part[];
};

type Kind = "one-way" | "request-response" | "notification" | "solicit-response";

type OpModel = {
  readonly name: string;
  readonly at: string;
  readonly description?: string;
  readonly pattern: string;
  readonly kind: Kind;
  readonly optionalSecond: boolean;
  readonly toService?: MessageRef;
  readonly fromService?: MessageRef;
  /** Part names of each message that a SOAP binding carries in a header: input ones stay input fields, output ones are left out of the output. */
  readonly headerParts: {
    readonly input: ReadonlySet<string>;
    readonly output: ReadonlySet<string>;
  };
  readonly tags: Obj;
  readonly wsdl: Obj;
};

const partJson = (p: Part): Obj =>
  compact({
    name: p.name,
    element: p.element === undefined ? undefined : clark(p.element),
    type: p.type === undefined ? undefined : clark(p.type),
    open: p.open,
  });

const messageJson = (m: MessageRef): Obj =>
  compact({ name: m.label, message: m.message, parts: m.parts.map(partJson) });

// ============================================================================
// Entry point
// ============================================================================

export function fromWsdlDocument(input: string): ImportedWsdl {
  if (typeof input !== "string") throw new Error("fromWsdlDocument: input must be XML text");
  const root = parseXml(input);
  let version: WsdlVersion;
  if (root.ns === NS.wsdl11 && root.local === "definitions") version = "1.1";
  else if (root.ns === NS.wsdl20 && root.local === "description") version = "2.0";
  else {
    throw new Error(
      `fromWsdlDocument: the root element {${root.ns ?? ""}}${root.local} is not a WSDL 1.1 definitions or WSDL 2.0 description`,
    );
  }
  const w = version === "1.1" ? NS.wsdl11 : NS.wsdl20;
  const diagnostics: Diagnostic[] = [];
  const diag = (at: string, message: string): void => {
    diagnostics.push({ at, message });
  };
  const tns = root.attrs.targetNamespace ?? "";

  const docOf = (el: XmlElement): string | undefined => {
    const text = kids(el, w, "documentation")
      .map((d) => textContent(d).trim())
      .filter((s) => s.length > 0)
      .join("\n\n");
    return text.length > 0 ? text : undefined;
  };

  // ---- types ---------------------------------------------------------------
  const schemas: XmlElement[] = [];
  for (const types_ of kids(root, w, "types")) {
    for (const c of types_.children) {
      if (c.ns === XSD_NS && c.local === "schema") schemas.push(c);
      else if (c.ns === w && c.local === "documentation") continue;
      else if (version === "2.0" && c.ns === XSD_NS && c.local === "import") {
        diag("types", "an xs:import directly in types is not followed");
      } else diag("types", `extension element {${c.ns ?? ""}}${c.local} is not represented`);
    }
  }
  const xsd: XsdTypes = fromXsd(schemas);

  const nameOf = (el: XmlElement, value: string | undefined, at: string): XsdName | undefined => {
    if (value === undefined) return undefined;
    const n = resolveQName(el, value);
    if (n === undefined) diag(at, `"${value}" uses a namespace prefix that is not declared`);
    return n;
  };

  const unresolved = (at: string, what: string, name: XsdName): TypeRef => {
    diag(
      at,
      `${what} "${clark(name)}" is not declared in the document's types; treated as unknown`,
    );
    return t(types.unknown, { wsdl: { unresolved: clark(name) } });
  };

  const partType = (p: Part, at: string): TypeRef => {
    if (p.element !== undefined) {
      return xsd.element(p.element) ?? unresolved(at, "element", p.element);
    }
    if (p.type !== undefined) return xsd.type(p.type) ?? unresolved(at, "type", p.type);
    return t(types.unknown, p.open === undefined ? {} : { wsdl: { open: p.open } });
  };

  /** The named-params fields of a type that is an object, following refs. */
  const objectFieldsOf = (type: TypeRef): Readonly<Record<string, TypeRef>> | undefined => {
    let cur: TypeRef | undefined = type;
    for (let depth = 0; depth < 16 && cur !== undefined; depth++) {
      if (cur.shape.kind === "object") return cur.shape.fields;
      if (cur.shape.kind !== "ref") return undefined;
      cur = xsd.defs[cur.shape.target];
    }
    return undefined;
  };

  const inputType = (
    m: MessageRef | undefined,
    opName: string,
    at: string,
    headers: ReadonlySet<string>,
  ): TypeRef => {
    if (m === undefined) return noInput();
    const body = m.parts.filter((p) => !headers.has(p.name));
    const only = body.length === 1 ? body[0] : undefined;
    const fields: Record<string, TypeRef> = {};
    let rest = m.parts;
    if (only?.element !== undefined && only.element.local === opName) {
      const wrapped = objectFieldsOf(partType(only, at));
      if (wrapped !== undefined) {
        Object.assign(fields, wrapped);
        rest = m.parts.filter((p) => p !== only);
      }
    }
    for (const p of rest) {
      if (p.name in fields) {
        diag(at, `part "${p.name}" is declared twice; the second is skipped`);
        continue;
      }
      fields[p.name] = partType(p, at);
    }
    return t(types.object(fields));
  };

  const outputType = (
    m: MessageRef | undefined,
    at: string,
    headers: ReadonlySet<string>,
  ): TypeRef => {
    const parts = (m?.parts ?? []).filter((p) => !headers.has(p.name));
    if (parts.length === 0) return t(types.void);
    if (parts.length === 1) return partType(parts[0]!, at);
    const fields: Record<string, TypeRef> = {};
    for (const p of parts) if (!(p.name in fields)) fields[p.name] = partType(p, at);
    return t(types.object(fields));
  };

  // ---- generic operation building --------------------------------------------
  const buildOperation = (m: OpModel, address: readonly string[]): Operation => {
    const tags: Obj = { ...m.tags };
    let input: TypeRef;
    let output: TypeRef;
    const wsdl: Obj = { ...m.wsdl };
    switch (m.kind) {
      case "one-way":
        input = inputType(m.toService, m.name, m.at, m.headerParts.input);
        output = t(types.void);
        break;
      case "request-response":
        input = inputType(m.toService, m.name, m.at, m.headerParts.input);
        output = outputType(m.fromService, m.at, m.headerParts.output);
        if (m.optionalSecond) diag(m.at, "the response is optional; kept as the output type");
        break;
      case "notification":
      case "solicit-response": {
        input = noInput();
        output = t(types.stream(outputType(m.fromService, m.at, m.headerParts.output)));
        tags.streaming = true;
        diag(
          m.at,
          `${m.pattern}: the service sends the message, so it is represented as a streaming output with no input`,
        );
        if (m.kind === "solicit-response" && m.toService !== undefined) {
          wsdl.reply = messageJson(m.toService);
          diag(
            m.at,
            "the message the client must send back is kept under meta.wsdl.reply and not represented",
          );
        }
        break;
      }
    }
    return {
      address: address.map((name) => ({ kind: "static", name })),
      input,
      output,
      meta: {
        ...(m.description !== undefined ? { description: m.description } : {}),
        tags,
        wsdl,
      },
    };
  };

  const operations: Operation[] = [];
  const groups: Group[] = [];

  const rootWsdl: Obj = compact({
    version,
    name: root.attrs.name,
    targetNamespace: root.attrs.targetNamespace,
  });
  const imports = [
    ...kids(root, w, "import"),
    ...(version === "2.0" ? kids(root, w, "include") : []),
  ];
  if (imports.length > 0) {
    rootWsdl.imports = imports.map((i) => ({ kind: i.local, ...attrsOf(i) }));
    for (const i of imports)
      diag(
        i.local,
        `${i.local} of ${i.attrs.location ?? i.attrs.namespace ?? "?"} is not followed`,
      );
  }
  const rootDoc = docOf(root);
  groups.push({
    address: [],
    meta: { ...(rootDoc !== undefined ? { description: rootDoc } : {}), wsdl: rootWsdl },
  });

  const reportedHttp = new Set<string>();
  if (version === "1.1") importV11();
  else importV20();

  function reportHttp(binding: string): void {
    if (reportedHttp.has(binding)) return;
    reportedHttp.add(binding);
    diag(
      `binding[${binding}]`,
      "the HTTP binding is kept under meta.wsdl.bindings[].http; it is not turned into meta.http",
    );
  }

  function opKey(
    taken: Set<string>,
    name: string,
    overloaded: boolean,
    inputName: string | undefined,
    ordinal: number,
    at: string,
  ): string {
    const preferred = overloaded ? `${name}_${inputName ?? ordinal}` : name;
    let key = preferred;
    for (let n = 2; taken.has(key); n++) key = `${preferred}_${n}`;
    taken.add(key);
    if (key !== name) {
      diag(at, `operation "${name}" is declared more than once; keyed "${key}"`);
    }
    return key;
  }

  // ==========================================================================
  // WSDL 1.1
  // ==========================================================================
  function importV11(): void {
    type Msg = { name: string; parts: Part[] };
    const messages = new Map<string, Msg>();
    for (const m of kids(root, w, "message")) {
      const name = m.attrs.name;
      if (name === undefined) {
        diag("message", "a message has no name; skipped");
        continue;
      }
      const parts: Part[] = [];
      for (const p of kids(m, w, "part")) {
        const at = `message[${name}]/part[${p.attrs.name ?? ""}]`;
        if (p.attrs.name === undefined) {
          diag(at, "a part has no name; skipped");
          continue;
        }
        const element = nameOf(p, p.attrs.element, at);
        const type = nameOf(p, p.attrs.type, at);
        if (element === undefined && type === undefined) {
          diag(at, "a part has neither element nor type; treated as unknown");
        }
        parts.push({
          name: p.attrs.name,
          ...(element !== undefined ? { element } : {}),
          ...(type !== undefined ? { type } : {}),
        });
      }
      messages.set(clark({ ns: tns, local: name }), { name, parts });
    }

    const messageRef = (el: XmlElement, at: string): MessageRef | undefined => {
      const name = nameOf(el, el.attrs.message, at);
      if (name === undefined) {
        diag(at, "no message attribute; treated as an empty message");
        return { ...(el.attrs.name !== undefined ? { label: el.attrs.name } : {}), parts: [] };
      }
      const found = messages.get(clark(name));
      if (found === undefined) {
        diag(at, `message "${clark(name)}" is not declared; treated as empty`);
      }
      return {
        ...(el.attrs.name !== undefined ? { label: el.attrs.name } : {}),
        message: clark(name),
        parts: found?.parts ?? [],
      };
    };

    // Services and ports.
    type Port = {
      service: string;
      port: string;
      binding: XsdName | undefined;
      address: string | undefined;
      extensions: Obj[];
    };
    const ports: Port[] = [];
    for (const s of kids(root, w, "service")) {
      const sname = s.attrs.name ?? "";
      for (const p of kids(s, w, "port")) {
        const at = `service[${sname}]/port[${p.attrs.name ?? ""}]`;
        const addr = p.children.find(
          (c) => c.local === "address" && c.ns !== w && c.ns !== undefined,
        );
        const port: Port = {
          service: sname,
          port: p.attrs.name ?? "",
          binding: nameOf(p, p.attrs.binding, at),
          address: addr?.attrs.location,
          extensions: p.children.filter((c) => c !== addr && c.ns !== w).map(extJson),
        };
        if (addr === undefined) diag(at, "the port has no address extension element");
        ports.push(port);
      }
    }

    const bindingByName = new Map<string, XmlElement>();
    for (const b of kids(root, w, "binding")) {
      if (b.attrs.name !== undefined) bindingByName.set(clark({ ns: tns, local: b.attrs.name }), b);
    }
    for (const port of ports) {
      if (port.binding !== undefined && !bindingByName.has(clark(port.binding))) {
        diag(
          `service[${port.service}]/port[${port.port}]`,
          `binding "${clark(port.binding)}" is not declared`,
        );
      }
    }
    const portTypeNames = new Set(
      kids(root, w, "portType").flatMap((p) =>
        p.attrs.name === undefined ? [] : [clark({ ns: tns, local: p.attrs.name })],
      ),
    );
    for (const b of bindingByName.values()) {
      const type = nameOf(b, b.attrs.type, `binding[${b.attrs.name}]`);
      if (type === undefined || !portTypeNames.has(clark(type))) {
        diag(
          `binding[${b.attrs.name}]`,
          `portType "${type === undefined ? "" : clark(type)}" is not declared; the binding is not attached to any operation`,
        );
      }
    }

    const soapNsOf = (el: XmlElement | undefined): string | undefined =>
      el?.ns === NS.soap11 || el?.ns === NS.soap12 ? el.ns : undefined;

    const messageBinding = (
      el: XmlElement | undefined,
      soapNs: string | undefined,
    ): Obj | undefined => {
      if (el === undefined) return undefined;
      const out: Obj = {};
      if (soapNs !== undefined) {
        const body = kid(el, soapNs, "body");
        if (body !== undefined) out.body = attrsOf(body);
        const headers = kids(el, soapNs, "header").map((h) => ({
          ...attrsOf(h),
          ...(kids(h, soapNs, "headerfault").length > 0
            ? { headerfaults: kids(h, soapNs, "headerfault").map((f) => attrsOf(f)) }
            : {}),
        }));
        if (headers.length > 0) out.headers = headers;
      }
      const other = el.children.filter(
        (c) =>
          c.ns !== w &&
          !(soapNs !== undefined && c.ns === soapNs && ["body", "header"].includes(c.local)),
      );
      if (other.length > 0) out.extensions = other.map(extJson);
      return isEmpty(out) ? undefined : out;
    };

    const bindingEntry = (b: XmlElement, bop: XmlElement | undefined, opAt: string): Obj => {
      const bname = b.attrs.name ?? "";
      const soapBinding = b.children.find(
        (c) => soapNsOf(c) !== undefined && c.local === "binding",
      );
      const soapNs = soapNsOf(soapBinding);
      const entry: Obj = { binding: bname };
      const attached = ports.filter(
        (p) => p.binding !== undefined && p.binding.local === bname && p.binding.ns === tns,
      );
      if (soapNs !== undefined && soapBinding !== undefined) {
        const soap: Obj = {
          version: soapNs === NS.soap12 ? "1.2" : "1.1",
          binding: attrsOf(soapBinding),
        };
        if (bop !== undefined) {
          const sop = kid(bop, soapNs, "operation");
          if (sop !== undefined) soap.operation = attrsOf(sop);
          const inp = messageBinding(kid(bop, w, "input"), soapNs);
          const out = messageBinding(kid(bop, w, "output"), soapNs);
          if (inp !== undefined) soap.input = inp;
          if (out !== undefined) soap.output = out;
          const faultBindings = kids(bop, w, "fault").map((f) => ({
            name: f.attrs.name,
            ...(kid(f, soapNs, "fault") !== undefined ? attrsOf(kid(f, soapNs, "fault")!) : {}),
          }));
          if (faultBindings.length > 0) soap.faults = faultBindings;
          const hasHeaders = [inp, out].some((m) => m !== undefined && "headers" in m);
          if (hasHeaders) {
            diag(
              opAt,
              "SOAP headers are kept under meta.wsdl.bindings[].soap; header parts of the input message stay input fields and header parts of the output message are left out of the output",
            );
          }
        }
        entry.soap = soap;
      }
      const httpBinding = b.children.find((c) => c.ns === NS.http11 && c.local === "binding");
      if (httpBinding !== undefined) {
        const http: Obj = { binding: attrsOf(httpBinding) };
        if (bop !== undefined) {
          const hop = kid(bop, NS.http11, "operation");
          if (hop !== undefined) http.operation = attrsOf(hop);
          const inp = messageBinding(kid(bop, w, "input"), undefined);
          const out = messageBinding(kid(bop, w, "output"), undefined);
          if (inp !== undefined) http.input = inp;
          if (out !== undefined) http.output = out;
        }
        entry.http = http;
        reportHttp(bname);
      }
      const known = new Set<XmlElement | undefined>([soapBinding, httpBinding]);
      const extraB = b.children.filter((c) => c.ns !== w && !known.has(c));
      const extraOp = (bop?.children ?? []).filter(
        (c) =>
          c.ns !== w &&
          !(c.ns === soapNs && c.local === "operation") &&
          !(c.ns === NS.http11 && c.local === "operation"),
      );
      const extensions = [...extraB, ...extraOp].map(extJson);
      if (extensions.length > 0) entry.extensions = extensions;
      entry.ports = attached.map((p) =>
        compact({
          service: p.service,
          port: p.port,
          address: p.address,
          ...(p.extensions.length > 0 ? { extensions: p.extensions } : {}),
        }),
      );
      return entry;
    };

    for (const pt of kids(root, w, "portType")) {
      const ptName = pt.attrs.name;
      if (ptName === undefined) {
        diag("portType", "a portType has no name; skipped");
        continue;
      }
      const ptClark = clark({ ns: tns, local: ptName });
      const bindings = [...bindingByName.values()].filter((b) => {
        const type = b.attrs.type === undefined ? undefined : resolveQName(b, b.attrs.type);
        return type !== undefined && clark(type) === ptClark;
      });
      const attachedPorts = ports.filter((p) => {
        const b = p.binding === undefined ? undefined : bindingByName.get(clark(p.binding));
        return b !== undefined && bindings.includes(b);
      });
      const ptDoc = docOf(pt);
      groups.push({
        address: [{ kind: "static", name: ptName }],
        meta: {
          ...(ptDoc !== undefined ? { description: ptDoc } : {}),
          wsdl: {
            version,
            portType: ptName,
            ...(tns !== "" ? { targetNamespace: tns } : {}),
            services: attachedPorts.map((p) =>
              compact({
                service: p.service,
                port: p.port,
                binding: p.binding === undefined ? undefined : p.binding.local,
                address: p.address,
              }),
            ),
          },
        },
      });

      const opEls = kids(pt, w, "operation");
      const counts = new Map<string, number>();
      for (const o of opEls)
        counts.set(o.attrs.name ?? "", (counts.get(o.attrs.name ?? "") ?? 0) + 1);
      const ordinals = new Map<string, number>();
      const taken = new Set<string>();

      for (const o of opEls) {
        const name = o.attrs.name;
        const at = `portType[${ptName}]/operation[${name ?? ""}]`;
        if (name === undefined) {
          diag(at, "an operation has no name; skipped");
          continue;
        }
        const seq = o.children.filter(
          (c) => c.ns === w && (c.local === "input" || c.local === "output"),
        );
        const order = seq.map((c) => c.local).join(",");
        const kindByOrder: Record<string, Kind> = {
          input: "one-way",
          "input,output": "request-response",
          "output,input": "solicit-response",
          output: "notification",
        };
        const kind = kindByOrder[order];
        if (kind === undefined) {
          diag(at, `unsupported message sequence "${order}"; skipped`);
          continue;
        }
        const inputEl = seq.find((c) => c.local === "input");
        const outputEl = seq.find((c) => c.local === "output");
        const inputRef = inputEl === undefined ? undefined : messageRef(inputEl, `${at}/input`);
        const outputRef = outputEl === undefined ? undefined : messageRef(outputEl, `${at}/output`);
        const ordinal = (ordinals.get(name) ?? 0) + 1;
        ordinals.set(name, ordinal);
        const key = opKey(
          taken,
          name,
          (counts.get(name) ?? 0) > 1,
          inputEl?.attrs.name,
          ordinal,
          at,
        );

        const faults = kids(o, w, "fault").map((f) => {
          const ref = messageRef(f, `${at}/fault[${f.attrs.name ?? ""}]`);
          return compact({
            name: f.attrs.name,
            message: ref?.message,
            parts: ref?.parts.map(partJson),
          });
        });

        const bindingEntries = bindings.map((b) => {
          const candidates = kids(b, w, "operation").filter((bo) => bo.attrs.name === name);
          const bop =
            candidates.length > 1 && inputEl?.attrs.name !== undefined
              ? (candidates.find((bo) => kid(bo, w, "input")?.attrs.name === inputEl.attrs.name) ??
                candidates[0])
              : candidates[0];
          if (bop === undefined) diag(at, `binding "${b.attrs.name}" has no operation "${name}"`);
          return bindingEntry(b, bop, at);
        });

        const headerNames = (dir: "input" | "output", ref: MessageRef | undefined): Set<string> => {
          const out = new Set<string>();
          if (ref?.message === undefined) return out;
          for (const b of bindings) {
            for (const bo of kids(b, w, "operation").filter((x) => x.attrs.name === name)) {
              for (const h of kid(bo, w, dir)?.children ?? []) {
                if ((h.ns !== NS.soap11 && h.ns !== NS.soap12) || h.local !== "header") continue;
                const m =
                  h.attrs.message === undefined ? undefined : resolveQName(h, h.attrs.message);
                if (m !== undefined && clark(m) === ref.message && h.attrs.part !== undefined) {
                  out.add(h.attrs.part);
                }
              }
            }
          }
          return out;
        };

        const wsdl: Obj = {
          version,
          portType: ptName,
          ...(tns !== "" ? { targetNamespace: tns } : {}),
          operation: name,
          pattern: kind,
          ...(inputRef !== undefined && kind !== "solicit-response"
            ? { input: messageJson(inputRef) }
            : {}),
          ...(outputRef !== undefined ? { output: messageJson(outputRef) } : {}),
          ...(o.attrs.parameterOrder !== undefined
            ? { parameterOrder: words(o.attrs.parameterOrder) }
            : {}),
          ...(faults.length > 0 ? { faults } : {}),
          bindings: bindingEntries,
        };
        if (faults.length > 0) {
          diag(at, "faults are kept under meta.wsdl.faults; error types are not represented");
        }
        const description = docOf(o);
        operations.push(
          buildOperation(
            {
              name,
              at,
              ...(description !== undefined ? { description } : {}),
              pattern: kind,
              kind,
              optionalSecond: false,
              ...(inputRef !== undefined ? { toService: inputRef } : {}),
              ...(outputRef !== undefined ? { fromService: outputRef } : {}),
              headerParts: {
                input: headerNames("input", inputRef),
                output: headerNames("output", outputRef),
              },
              tags: {},
              wsdl,
            },
            [ptName, key],
          ),
        );
      }
      if (attachedPorts.length === 0 && bindings.length === 0) {
        diag(
          `portType[${ptName}]`,
          "no binding refers to this portType; operations have no binding or endpoint details",
        );
      }
    }
    if (kids(root, w, "portType").length === 0)
      diag("", "the document has no portType; only its types were imported");
  }

  // ==========================================================================
  // WSDL 2.0
  // ==========================================================================
  function importV20(): void {
    const MEPS: Readonly<Record<string, { kind: Kind; optional: boolean }>> = {
      "in-only": { kind: "one-way", optional: false },
      "robust-in-only": { kind: "one-way", optional: false },
      "in-out": { kind: "request-response", optional: false },
      "in-opt-out": { kind: "request-response", optional: true },
      "out-only": { kind: "notification", optional: false },
      "robust-out-only": { kind: "notification", optional: false },
      "out-in": { kind: "solicit-response", optional: false },
      "out-opt-in": { kind: "solicit-response", optional: true },
    };
    const MEP_PREFIX = "http://www.w3.org/ns/wsdl/";

    const interfaces = kids(root, w, "interface");
    const interfaceFaults = new Map<string, XmlElement>();
    for (const i of interfaces) {
      for (const f of kids(i, w, "fault")) {
        if (f.attrs.name !== undefined)
          interfaceFaults.set(clark({ ns: tns, local: f.attrs.name }), f);
      }
    }

    const messageOf = (el: XmlElement, at: string): MessageRef => {
      const value = el.attrs.element;
      const label = el.attrs.messageLabel;
      const base = label !== undefined ? { label } : {};
      if (value === "#none") return { ...base, message: "#none", parts: [] };
      if (value === undefined || value === "#any" || value === "#other") {
        const open = value ?? "#other";
        if (open === "#other")
          diag(
            at,
            `content model ${value === undefined ? "is absent" : "is #other"}; treated as unknown`,
          );
        return { ...base, message: open, parts: [{ name: "payload", open }] };
      }
      const name = nameOf(el, value, at);
      if (name === undefined)
        return { ...base, message: value, parts: [{ name: "payload", open: "#other" }] };
      return { ...base, message: clark(name), parts: [{ name: name.local, element: name }] };
    };

    // Services and endpoints.
    type Endpoint = {
      service: string;
      endpoint: string;
      binding: XsdName | undefined;
      address: string | undefined;
      attributes: Obj;
      interfaceName: XsdName | undefined;
    };
    const endpoints: Endpoint[] = [];
    for (const s of kids(root, w, "service")) {
      const sname = s.attrs.name ?? "";
      for (const e of kids(s, w, "endpoint")) {
        const at = `service[${sname}]/endpoint[${e.attrs.name ?? ""}]`;
        endpoints.push({
          service: sname,
          endpoint: e.attrs.name ?? "",
          binding: nameOf(e, e.attrs.binding, at),
          address: e.attrs.address,
          attributes: attrsOf(e, ["name", "binding", "address"]),
          interfaceName: nameOf(s, s.attrs.interface, `service[${sname}]`),
        });
      }
    }

    const bindings = kids(root, w, "binding");
    const bindingClark = (b: XmlElement): string => clark({ ns: tns, local: b.attrs.name ?? "" });
    for (const e of endpoints) {
      if (e.binding !== undefined && !bindings.some((b) => bindingClark(b) === clark(e.binding!))) {
        diag(
          `service[${e.service}]/endpoint[${e.endpoint}]`,
          `binding "${clark(e.binding)}" is not declared`,
        );
      }
    }

    const protocolOf = (type: string | undefined): string =>
      type === NS.wsoap ? "soap" : type === NS.whttp ? "http" : "other";

    const bindingEntry = (b: XmlElement, bop: XmlElement | undefined): Obj => {
      const type = b.attrs.type;
      const protocol = protocolOf(type);
      const entry: Obj = {
        binding: b.attrs.name ?? "",
        ...(type !== undefined ? { type } : {}),
        protocol,
      };
      const attached = endpoints.filter(
        (e) => e.binding !== undefined && clark(e.binding) === bindingClark(b),
      );
      const inNs = protocol === "soap" ? NS.wsoap : protocol === "http" ? NS.whttp : undefined;
      if (inNs !== undefined) {
        const details: Obj = { binding: attrsIn(b, inNs) };
        if (bop !== undefined) {
          details.operation = attrsIn(bop, inNs);
          for (const dir of ["input", "output"] as const) {
            const els = kids(bop, w, dir).map((m) =>
              compact({
                messageLabel: m.attrs.messageLabel,
                ...attrsIn(m, inNs),
                ...(m.children.length > 0 ? { extensions: m.children.map(extJson) } : {}),
              }),
            );
            if (els.length > 0) details[dir] = els;
          }
        }
        entry[protocol] = details;
      }
      if (protocol === "http") reportHttp(b.attrs.name ?? "");
      const extras = [
        ...b.children.filter((c) => c.ns !== w),
        ...(bop?.children ?? []).filter((c) => c.ns !== w),
      ].map(extJson);
      if (extras.length > 0) entry.extensions = extras;
      const rest = attrsOf(b, ["name", "interface", "type"]);
      const otherAttrs = Object.fromEntries(
        Object.entries(rest).filter(([k]) => inNs === undefined || !k.startsWith(`{${inNs}}`)),
      );
      if (!isEmpty(otherAttrs)) entry.attributes = otherAttrs;
      entry.ports = attached.map((e) =>
        compact({
          service: e.service,
          endpoint: e.endpoint,
          address: e.address,
          ...(isEmpty(e.attributes) ? {} : { attributes: e.attributes }),
        }),
      );
      return entry;
    };

    for (const iface of interfaces) {
      const iname = iface.attrs.name;
      if (iname === undefined) {
        diag("interface", "an interface has no name; skipped");
        continue;
      }
      const iClark = clark({ ns: tns, local: iname });
      const ifaceBindings = bindings.filter((b) => {
        const n = b.attrs.interface === undefined ? undefined : resolveQName(b, b.attrs.interface);
        return n !== undefined && clark(n) === iClark;
      });
      const attached = endpoints.filter(
        (e) =>
          e.binding !== undefined &&
          ifaceBindings.some((b) => bindingClark(b) === clark(e.binding!)),
      );
      const extendsNames = words(iface.attrs.extends);
      const idoc = docOf(iface);
      groups.push({
        address: [{ kind: "static", name: iname }],
        meta: {
          ...(idoc !== undefined ? { description: idoc } : {}),
          wsdl: compact({
            version,
            interface: iname,
            ...(tns !== "" ? { targetNamespace: tns } : {}),
            ...(extendsNames.length > 0
              ? {
                  extends: extendsNames.map((n) => {
                    const q = resolveQName(iface, n);
                    return q === undefined ? n : clark(q);
                  }),
                }
              : {}),
            ...(iface.attrs.styleDefault !== undefined
              ? { styleDefault: words(iface.attrs.styleDefault) }
              : {}),
            services: attached.map((e) =>
              compact({
                service: e.service,
                endpoint: e.endpoint,
                binding: e.binding?.local,
                address: e.address,
              }),
            ),
          }),
        },
      });
      if (extendsNames.length > 0) {
        diag(
          `interface[${iname}]`,
          "extends is kept on the group; inherited operations are not repeated on this interface",
        );
      }

      const taken = new Set<string>();
      for (const o of kids(iface, w, "operation")) {
        const name = o.attrs.name;
        const at = `interface[${iname}]/operation[${name ?? ""}]`;
        if (name === undefined) {
          diag(at, "an operation has no name; skipped");
          continue;
        }
        const pattern = o.attrs.pattern ?? `${MEP_PREFIX}in-out`;
        const short = pattern.startsWith(MEP_PREFIX) ? pattern.slice(MEP_PREFIX.length) : undefined;
        let meta_ = short === undefined ? undefined : MEPS[short];
        const inputs = kids(o, w, "input");
        const outputs = kids(o, w, "output");
        if (meta_ === undefined) {
          const derived: Kind =
            inputs.length > 0 && outputs.length > 0
              ? "request-response"
              : outputs.length > 0
                ? "notification"
                : "one-way";
          diag(
            at,
            `message exchange pattern "${pattern}" is not a predefined one; treated as ${derived} from the messages it declares`,
          );
          meta_ = { kind: derived, optional: false };
        }
        if (inputs.length > 1 || outputs.length > 1) {
          diag(at, "more than one message per direction; only the first of each is used");
        }
        const inputRef = inputs[0] === undefined ? undefined : messageOf(inputs[0], `${at}/input`);
        const outputRef =
          outputs[0] === undefined ? undefined : messageOf(outputs[0], `${at}/output`);
        const key = opKey(taken, name, false, undefined, 1, at);

        const faults = [
          ...kids(o, w, "infault").map((f) => ({ f, direction: "in" })),
          ...kids(o, w, "outfault").map((f) => ({ f, direction: "out" })),
        ].map(({ f, direction }) => {
          const ref = nameOf(f, f.attrs.ref, at);
          const decl = ref === undefined ? undefined : interfaceFaults.get(clark(ref));
          return compact({
            ref: ref === undefined ? f.attrs.ref : clark(ref),
            direction,
            messageLabel: f.attrs.messageLabel,
            element: decl?.attrs.element,
          });
        });
        if (faults.length > 0)
          diag(at, "faults are kept under meta.wsdl.faults; error types are not represented");

        const bindingEntries = ifaceBindings.map((b) => {
          const bop = kids(b, w, "operation").find((bo) => {
            const ref = bo.attrs.ref === undefined ? undefined : resolveQName(bo, bo.attrs.ref);
            return ref !== undefined && ref.local === name && ref.ns === tns;
          });
          return bindingEntry(b, bop);
        });

        const safe = attrNs(o, NS.wsdlx, "safe");
        const description = docOf(o);
        const wsdl: Obj = {
          version,
          interface: iname,
          ...(tns !== "" ? { targetNamespace: tns } : {}),
          operation: name,
          pattern,
          ...(o.attrs.style !== undefined ? { style: words(o.attrs.style) } : {}),
          ...(safe !== undefined ? { safe: safe === "true" } : {}),
          ...(inputRef !== undefined && meta_.kind !== "solicit-response"
            ? { input: messageJson(inputRef) }
            : {}),
          ...(outputRef !== undefined ? { output: messageJson(outputRef) } : {}),
          ...(faults.length > 0 ? { faults } : {}),
          bindings: bindingEntries,
        };
        operations.push(
          buildOperation(
            {
              name,
              at,
              ...(description !== undefined ? { description } : {}),
              pattern,
              kind: meta_.kind,
              optionalSecond: meta_.optional,
              headerParts: { input: new Set(), output: new Set() },
              ...(inputRef !== undefined ? { toService: inputRef } : {}),
              ...(outputRef !== undefined ? { fromService: outputRef } : {}),
              tags: safe === "true" ? { readOnly: true } : {},
              wsdl,
            },
            [iname, key],
          ),
        );
      }
    }
    if (interfaces.length === 0)
      diag("", "the document has no interface; only its types were imported");
  }

  return {
    api: { operations, groups, defs: xsd.defs },
    diagnostics: [
      ...diagnostics,
      ...xsd.diagnostics.map((d) => ({ at: `types/${d.at}`, message: d.message })),
    ],
    version,
  };
}
