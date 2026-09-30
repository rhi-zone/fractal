import { describe, expect, test } from "bun:test";
import { toJsonSchema } from "./json-schema.ts";
import { fromXsd, XSD_NS, type XmlElement } from "./from-xsd.ts";

// A small XML reader for test inputs: elements, attributes, text, namespaces.
const decode = (s: string): string =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

function parseXml(xml: string): XmlElement {
  type Draft = {
    name: string;
    attrs: Record<string, string>;
    children: Draft[];
    text: string;
    scope: Record<string, string>;
  };
  const root: Draft = {
    name: "",
    attrs: {},
    children: [],
    text: "",
    scope: { xml: "http://www.w3.org/XML/1998/namespace" },
  };
  const stack: Draft[] = [root];
  const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const cur = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      cur.text += decode(m[5]);
    } else if (m[1] === "/") {
      stack.pop();
    } else {
      const attrs: Record<string, string> = {};
      const scope = { ...cur.scope };
      for (const a of (m[3] ?? "").matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
        const [, k, v] = a as unknown as [string, string, string];
        if (k === "xmlns") scope[""] = decode(v);
        else if (k.startsWith("xmlns:")) scope[k.slice(6)] = decode(v);
        else attrs[k] = decode(v);
      }
      const d: Draft = { name: m[2]!, attrs, children: [], text: "", scope };
      cur.children.push(d);
      if (m[4] !== "/") stack.push(d);
    }
  }
  const finish = (d: Draft): XmlElement => {
    const i = d.name.indexOf(":");
    const prefix = i < 0 ? "" : d.name.slice(0, i);
    return {
      name: d.name,
      local: i < 0 ? d.name : d.name.slice(i + 1),
      ns: d.scope[prefix],
      attrs: d.attrs,
      scope: d.scope,
      children: d.children.map(finish),
      text: d.text,
    };
  };
  return finish(root.children[0]!);
}

const NS = "urn:test";
const schema = (body: string, extra = ""): XmlElement =>
  parseXml(
    `<xs:schema xmlns:xs="${XSD_NS}" xmlns:tns="${NS}" targetNamespace="${NS}" ${extra}>${body}</xs:schema>`,
  );

const convert = (body: string, extra = "") => fromXsd(schema(body, extra));
const obj = (r: {
  shape: unknown;
}): Record<string, { shape: { kind: string; [k: string]: any }; meta: Record<string, any> }> =>
  (r.shape as { fields: never }).fields;

describe("built-in datatypes", () => {
  const out = convert(`
    <xs:complexType name="All"><xs:sequence>
      <xs:element name="s" type="xs:string"/>
      <xs:element name="tok" type="xs:token"/>
      <xs:element name="b" type="xs:boolean"/>
      <xs:element name="i" type="xs:int"/>
      <xs:element name="l" type="xs:long"/>
      <xs:element name="ub" type="xs:unsignedByte"/>
      <xs:element name="big" type="xs:integer"/>
      <xs:element name="pos" type="xs:positiveInteger"/>
      <xs:element name="dec" type="xs:decimal"/>
      <xs:element name="f" type="xs:float"/>
      <xs:element name="d" type="xs:double"/>
      <xs:element name="dt" type="xs:dateTime"/>
      <xs:element name="dd" type="xs:date"/>
      <xs:element name="tm" type="xs:time"/>
      <xs:element name="du" type="xs:duration"/>
      <xs:element name="u" type="xs:anyURI"/>
      <xs:element name="b64" type="xs:base64Binary"/>
      <xs:element name="hex" type="xs:hexBinary"/>
      <xs:element name="ids" type="xs:IDREFS"/>
      <xs:element name="any" type="xs:anyType"/>
      <xs:element name="none"/>
    </xs:sequence></xs:complexType>`);
  const f = obj(out.defs.All!);

  test("maps each built-in to its kind", () => {
    const got = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.shape.kind]));
    expect(got).toEqual({
      s: "string",
      tok: "string",
      b: "boolean",
      i: "int32",
      l: "int64",
      ub: "uint8",
      big: "integer",
      pos: "integer",
      dec: "number",
      f: "float32",
      d: "float64",
      dt: "datetime",
      dd: "date",
      tm: "time",
      du: "duration",
      u: "uri",
      b64: "bytes",
      hex: "bytes",
      ids: "array",
      any: "unknown",
      none: "unknown",
    });
  });

  test("lossy maps keep the XSD name and bounds", () => {
    expect(f.tok!.meta.xsd).toEqual({ builtin: "token" });
    expect(f.pos!.meta.minimum).toBe(1);
    expect(f.big!.meta.format).toBe("bigint");
    expect(f.dec!.meta.format).toBe("bigdecimal");
    expect(f.hex!.meta.xsd).toEqual({ builtin: "hexBinary" });
  });

  test("required elements are not optional", () => {
    expect(f.s!.meta.optional).toBeUndefined();
    expect(out.diagnostics).toEqual([]);
  });
});

describe("simple types", () => {
  const out = convert(`
    <xs:simpleType name="Color"><xs:restriction base="xs:string">
      <xs:enumeration value="red"/><xs:enumeration value="green"/><xs:enumeration value="red"/>
    </xs:restriction></xs:simpleType>
    <xs:simpleType name="Level"><xs:restriction base="xs:int">
      <xs:enumeration value="1"/><xs:enumeration value="2"/>
    </xs:restriction></xs:simpleType>
    <xs:simpleType name="Zip"><xs:annotation><xs:documentation>A zip.</xs:documentation></xs:annotation>
      <xs:restriction base="xs:string"><xs:pattern value="[0-9]{5}"/><xs:length value="5"/></xs:restriction>
    </xs:simpleType>
    <xs:simpleType name="Zip9"><xs:restriction base="tns:Zip"><xs:pattern value="[0-9]+"/></xs:restriction></xs:simpleType>
    <xs:simpleType name="Percent"><xs:restriction base="xs:decimal">
      <xs:minInclusive value="0"/><xs:maxExclusive value="100"/><xs:fractionDigits value="2"/>
    </xs:restriction></xs:simpleType>
    <xs:simpleType name="Names"><xs:list itemType="tns:Color"/></xs:simpleType>
    <xs:simpleType name="Short"><xs:restriction base="tns:Names"><xs:maxLength value="3"/></xs:restriction></xs:simpleType>
    <xs:simpleType name="ColorOrLevel"><xs:union memberTypes="tns:Color tns:Level"><xs:simpleType><xs:restriction base="xs:boolean"/></xs:simpleType></xs:union></xs:simpleType>
    <xs:simpleType name="Anchored"><xs:restriction base="xs:string"><xs:pattern value="^a"/></xs:restriction></xs:simpleType>
    <xs:simpleType name="Digits"><xs:restriction base="xs:string"><xs:pattern value="\\i\\c*"/></xs:restriction></xs:simpleType>
    <xs:simpleType name="Ts"><xs:restriction base="xs:string"><xs:assertion test="$value ne ''"/></xs:restriction></xs:simpleType>
  `);
  const d = out.defs;

  test("enumeration of strings is an enum, deduplicated", () => {
    expect(d.Color!.shape).toEqual({ kind: "enum", members: ["red", "green"] });
    expect(d.Color!.meta.typeName).toBe("Color");
  });

  test("enumeration of integers is a union of literals", () => {
    expect(d.Level!.shape).toEqual({
      kind: "union",
      variants: [
        { shape: { kind: "literal", value: 1 }, meta: {} },
        { shape: { kind: "literal", value: 2 }, meta: {} },
      ],
    });
  });

  test("pattern is anchored, length maps, documentation is the description", () => {
    expect(d.Zip!.shape.kind).toBe("string");
    expect(d.Zip!.meta.pattern).toBe("^(?:[0-9]{5})$");
    expect(d.Zip!.meta.minLength).toBe(5);
    expect(d.Zip!.meta.maxLength).toBe(5);
    expect(d.Zip!.meta.description).toBe("A zip.");
  });

  test("a restriction's pattern intersects its base's", () => {
    const re = new RegExp(d.Zip9!.meta.pattern as string);
    expect(re.test("12345")).toBe(true);
    expect(re.test("123456")).toBe(false);
    expect(re.test("abcde")).toBe(false);
  });

  test("numeric bounds map, digit facets stay verbatim", () => {
    expect(d.Percent!.meta.minimum).toBe(0);
    expect(d.Percent!.meta.exclusiveMaximum).toBe(100);
    expect(d.Percent!.meta.xsd).toMatchObject({ builtin: "decimal", fractionDigits: 2 });
  });

  test("list is an array of its item ref; length facets map to item counts", () => {
    expect(d.Names!.shape).toEqual({
      kind: "array",
      element: { shape: { kind: "ref", target: "Color" }, meta: {} },
    });
    expect(d.Short!.meta.maxItems).toBe(3);
  });

  test("union keeps member refs and inline members in order", () => {
    const v = (d.ColorOrLevel!.shape as unknown as { variants: { shape: { kind: string } }[] })
      .variants;
    expect(v.map((x) => x.shape.kind)).toEqual(["ref", "ref", "boolean"]);
  });

  test("XSD-only regex syntax and assertions are kept verbatim and reported", () => {
    expect(d.Anchored!.meta.pattern).toBeUndefined();
    expect(d.Anchored!.meta.xsd).toMatchObject({ pattern: "^a" });
    expect(d.Digits!.meta.xsd).toMatchObject({ pattern: "\\i\\c*" });
    expect(d.Ts!.meta.xsd).toMatchObject({ assertions: ["$value ne ''"] });
    const messages = out.diagnostics.map((x) => x.message).join("\n");
    expect(messages).toContain("XSD pattern not translated");
    expect(messages).toContain("assertions");
  });
});

describe("complex types", () => {
  const out = convert(`
    <xs:complexType name="Address">
      <xs:sequence>
        <xs:element name="street" type="xs:string"/>
        <xs:element name="line2" type="xs:string" minOccurs="0"/>
        <xs:element name="tag" type="xs:string" maxOccurs="unbounded"/>
        <xs:element name="phone" type="xs:string" minOccurs="2" maxOccurs="5"/>
        <xs:element name="note" type="xs:string" nillable="true" default="none"/>
        <xs:element name="count" type="xs:int" default="3"/>
        <xs:element name="fixedOne" type="xs:string" fixed="x"/>
        <xs:element ref="tns:global"/>
        <xs:group ref="tns:Geo"/>
      </xs:sequence>
      <xs:attribute name="id" type="xs:ID" use="required"/>
      <xs:attribute name="kind" type="xs:string" default="home"/>
      <xs:attribute name="street" type="xs:int"/>
      <xs:attribute name="gone" type="xs:string" use="prohibited"/>
      <xs:attributeGroup ref="tns:Audit"/>
    </xs:complexType>
    <xs:element name="global" type="xs:string" nillable="true"/>
    <xs:group name="Geo"><xs:sequence>
      <xs:element name="lat" type="xs:double"/><xs:element name="lon" type="xs:double" minOccurs="0"/>
    </xs:sequence></xs:group>
    <xs:attributeGroup name="Audit"><xs:attribute name="by" type="xs:string"/></xs:attributeGroup>
  `);
  const f = obj(out.defs.Address!);

  test("element particles become fields with occurrence handling", () => {
    expect(f.street!.meta.optional).toBeUndefined();
    expect(f.line2!.meta.optional).toBe(true);
    expect(f.tag!.shape.kind).toBe("array");
    expect(f.phone!.shape.kind).toBe("array");
    expect(f.phone!.meta.minItems).toBe(2);
    expect(f.phone!.meta.maxItems).toBe(5);
  });

  test("nillable, defaults and fixed", () => {
    expect(f.note!.meta.nullable).toBe(true);
    expect(f.note!.meta.default).toBe("none");
    expect(f.count!.meta.default).toBe(3);
    expect(f.fixedOne!.meta.xsd).toEqual({ fixed: "x" });
  });

  test("element refs and group refs expand in place", () => {
    expect(f.global!.shape.kind).toBe("string");
    expect(f.global!.meta.nullable).toBe(true);
    expect(f.lat!.shape.kind).toBe("float64");
    expect(f.lon!.meta.optional).toBe(true);
  });

  test("attributes are fields, required ones are not optional, prohibited ones vanish", () => {
    expect(f.id!.meta.optional).toBeUndefined();
    expect(f.id!.meta.xsd).toEqual({ attribute: true, builtin: "ID" });
    expect(f.kind!.meta.optional).toBe(true);
    expect(f.kind!.meta.default).toBe("home");
    expect(f.by!.meta.optional).toBe(true);
    expect("gone" in f).toBe(false);
  });

  test("an attribute clashing with an element is renamed and reported", () => {
    expect(f["@street"]!.shape.kind).toBe("int32");
    expect(out.diagnostics.some((x) => x.message.includes('attribute is named "@street"'))).toBe(
      true,
    );
  });

  test("the result is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(out.defs))).toEqual(out.defs);
  });
});

describe("choice", () => {
  const out = convert(`
    <xs:complexType name="Contact">
      <xs:choice>
        <xs:element name="email" type="xs:string"/>
        <xs:sequence><xs:element name="street" type="xs:string"/><xs:element name="city" type="xs:string"/></xs:sequence>
      </xs:choice>
      <xs:attribute name="id" type="xs:int"/>
    </xs:complexType>
    <xs:complexType name="Loose">
      <xs:sequence>
        <xs:element name="head" type="xs:string"/>
        <xs:choice><xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:int"/></xs:choice>
      </xs:sequence>
    </xs:complexType>
    <xs:complexType name="Many">
      <xs:choice maxOccurs="unbounded"><xs:element name="x" type="xs:string"/><xs:element name="y" type="xs:string"/></xs:choice>
    </xs:complexType>
    <xs:complexType name="Sub"><xs:complexContent><xs:extension base="tns:Contact">
      <xs:sequence><xs:element name="extra" type="xs:string"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  `);

  test("a lone choice is a union of one object per alternative, each with the attributes", () => {
    const c = out.defs.Contact!;
    expect(c.shape.kind).toBe("union");
    const variants = (
      c.shape as unknown as { variants: { shape: { fields: Record<string, unknown> } }[] }
    ).variants;
    expect(variants.map((v) => Object.keys(v.shape.fields))).toEqual([
      ["email", "id"],
      ["street", "city", "id"],
    ]);
  });

  test("a nested choice becomes optional fields marked with their group", () => {
    const f = obj(out.defs.Loose!);
    expect(f.head!.meta.optional).toBeUndefined();
    expect(f.a!.meta.optional).toBe(true);
    expect(f.b!.meta.optional).toBe(true);
    expect(f.a!.meta.xsd).toEqual({ choice: 0 });
    expect(
      out.diagnostics.some((x) => x.at.includes("Loose") && x.message.includes("exclusivity")),
    ).toBe(true);
  });

  test("a repeated choice becomes optional array fields", () => {
    const f = obj(out.defs.Many!);
    expect(f.x!.shape.kind).toBe("array");
    expect(f.x!.meta.optional).toBe(true);
  });

  test("extending a choice type flattens it and reports the lost exclusivity", () => {
    const f = obj(out.defs.Sub!);
    expect(Object.keys(f).sort()).toEqual(["city", "email", "extra", "id", "street"]);
    expect(f.email!.meta.optional).toBe(true);
    expect(out.defs.Sub!.meta.xsd).toMatchObject({ extends: "Contact" });
    expect(
      out.diagnostics.some((x) => x.at.includes("Sub") && x.message.includes("extension")),
    ).toBe(true);
  });
});

describe("derivation and simple content", () => {
  const out = convert(`
    <xs:complexType name="Base"><xs:sequence><xs:element name="a" type="xs:string"/></xs:sequence><xs:attribute name="x" type="xs:int"/></xs:complexType>
    <xs:complexType name="Derived"><xs:complexContent><xs:extension base="tns:Base">
      <xs:sequence><xs:element name="b" type="xs:int"/></xs:sequence><xs:attribute name="y" type="xs:int"/>
    </xs:extension></xs:complexContent></xs:complexType>
    <xs:complexType name="Restricted"><xs:complexContent><xs:restriction base="tns:Base">
      <xs:sequence><xs:element name="a" type="xs:string"/></xs:sequence><xs:attribute name="x" use="prohibited"/>
    </xs:restriction></xs:complexContent></xs:complexType>
    <xs:complexType name="Price"><xs:simpleContent><xs:extension base="xs:decimal"><xs:attribute name="currency" type="xs:string" use="required"/></xs:extension></xs:simpleContent></xs:complexType>
    <xs:complexType name="Plain"><xs:simpleContent><xs:extension base="xs:string"/></xs:simpleContent></xs:complexType>
    <xs:complexType name="ValueClash"><xs:simpleContent><xs:extension base="xs:string"><xs:attribute name="value" type="xs:string"/></xs:extension></xs:simpleContent></xs:complexType>
    <xs:complexType name="Empty"/>
    <xs:complexType name="Text" mixed="true"><xs:sequence><xs:element name="b" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType>
    <xs:complexType name="Open"><xs:sequence><xs:any namespace="##other" processContents="lax"/></xs:sequence><xs:anyAttribute/></xs:complexType>
    <xs:complexType name="Loop"><xs:complexContent><xs:extension base="tns:Loop"/></xs:complexContent></xs:complexType>
  `);
  const d = out.defs;

  test("extension flattens base fields first", () => {
    expect(Object.keys(obj(d.Derived!))).toEqual(["a", "b", "x", "y"]);
    expect(d.Derived!.meta.xsd).toMatchObject({ extends: "Base", namespace: NS, name: "Derived" });
  });

  test("restriction restates content and drops prohibited attributes", () => {
    expect(Object.keys(obj(d.Restricted!))).toEqual(["a"]);
  });

  test("simple content with attributes is an object with a value field", () => {
    const f = obj(d.Price!);
    expect(Object.keys(f)).toEqual(["value", "currency"]);
    expect(f.value!.shape.kind).toBe("number");
    expect(f.value!.meta.xsd).toMatchObject({ text: true });
  });

  test("simple content without attributes is the text type", () => {
    expect(d.Plain!.shape.kind).toBe("string");
  });

  test("the text field avoids an attribute called value", () => {
    expect(Object.keys(obj(d.ValueClash!))).toEqual(["$value", "value"]);
  });

  test("empty content is an empty object", () => {
    expect(d.Empty!.shape).toEqual({ kind: "object", fields: {} });
  });

  test("mixed content and wildcards are marked and reported", () => {
    expect(d.Text!.meta.xsd).toMatchObject({ mixed: true });
    expect(d.Open!.meta.xsd).toMatchObject({
      any: { namespace: "##other", processContents: "lax" },
      anyAttribute: { namespace: "##any", processContents: "strict" },
    });
    const messages = out.diagnostics.map((x) => x.message).join("\n");
    expect(messages).toContain("mixed content");
    expect(messages).toContain("xs:any");
    expect(messages).toContain("xs:anyAttribute");
  });

  test("a type derived from itself is reported, not looped on", () => {
    expect(out.diagnostics.some((x) => x.message.includes("derived from itself"))).toBe(true);
  });
});

describe("global elements, naming and resolution", () => {
  const A = "urn:a:common";
  const B = "urn:b:common";
  const out = fromXsd([
    parseXml(`<xs:schema xmlns:xs="${XSD_NS}" xmlns:a="${A}" targetNamespace="${A}">
      <xs:complexType name="Thing"><xs:sequence><xs:element name="fromA" type="xs:string"/></xs:sequence></xs:complexType>
      <xs:element name="Order"><xs:complexType><xs:sequence>
        <xs:element name="id" type="xs:int"/>
        <xs:element name="thing" type="a:Thing"/>
        <xs:element ref="a:Order" minOccurs="0"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="Thing" type="a:Thing"/>
      <xs:element name="Note" type="xs:string" nillable="true"/>
      <xs:element name="Untyped"/>
    </xs:schema>`),
    parseXml(`<xs:schema xmlns:xs="${XSD_NS}" xmlns:b="${B}" xmlns:a="${A}" targetNamespace="${B}">
      <xs:import namespace="${A}"/>
      <xs:complexType name="Thing"><xs:sequence><xs:element name="fromB" type="xs:string"/><xs:element name="other" type="a:Thing"/></xs:sequence></xs:complexType>
      <xs:element name="Wrap"><xs:complexType><xs:sequence><xs:element name="t" type="b:Thing"/></xs:sequence></xs:complexType></xs:element>
    </xs:schema>`),
  ]);

  test("same-named types in two namespaces get disambiguated keys", () => {
    expect(out.keys[`{${A}}Thing`]).toBe("common.Thing");
    expect(out.keys[`{${B}}Thing`]).toBe("common.Thing2");
    expect(Object.keys(obj(out.defs["common.Thing"]!))).toEqual(["fromA"]);
    expect(Object.keys(obj(out.defs["common.Thing2"]!))).toEqual(["fromB", "other"]);
  });

  test("references cross schemas by namespace", () => {
    const other = obj(out.defs["common.Thing2"]!).other!;
    expect(other.shape).toEqual({ kind: "ref", target: "common.Thing" });
  });

  test("a global element with an anonymous type is a def; refs to it are refs", () => {
    expect(Object.keys(obj(out.defs.Order!))).toEqual(["id", "thing", "Order"]);
    expect(out.defs.Order!.meta.xsd).toMatchObject({ element: "Order" });
    const order = out.element({ ns: A, local: "Order" })!;
    expect(order.shape).toEqual({ kind: "ref", target: "Order" });
    expect(obj(out.defs.Order!).Order!.shape).toEqual({ kind: "ref", target: "Order" });
  });

  test("a global element with a named type refers to that type", () => {
    expect(out.element({ ns: A, local: "Thing" })!.shape).toEqual({
      kind: "ref",
      target: "common.Thing",
    });
    expect(out.defs["ThingElement"]).toBeUndefined();
  });

  test("nillable and untyped elements", () => {
    const note = out.element({ ns: A, local: "Note" })!;
    expect(note.shape.kind).toBe("string");
    expect(note.meta.nullable).toBe(true);
    expect(out.element({ ns: A, local: "Untyped" })!.shape.kind).toBe("unknown");
    expect(out.element({ ns: A, local: "Nope" })).toBeUndefined();
  });

  test("type() resolves built-ins and named types", () => {
    expect(out.type({ ns: XSD_NS, local: "int" })!.shape.kind).toBe("int32");
    expect(out.type({ ns: A, local: "Thing" })!.shape).toEqual({
      kind: "ref",
      target: "common.Thing",
    });
    expect(out.type({ ns: A, local: "Missing" })).toBeUndefined();
  });

  test("the def graph converts to JSON Schema", () => {
    const schema = toJsonSchema(out.defs.Order!) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["id", "thing", "Order"]);
    expect(schema.required).toEqual(["id", "thing"]);
  });
});

describe("what is reported", () => {
  const out = convert(
    `
    <xs:import namespace="urn:elsewhere" schemaLocation="other.xsd"/>
    <xs:include schemaLocation="more.xsd"/>
    <xs:redefine schemaLocation="r.xsd"/>
    <xs:notation name="n" public="p"/>
    <xs:complexType name="T">
      <xs:annotation><xs:appinfo>tool data</xs:appinfo><xs:documentation>Doc.</xs:documentation></xs:annotation>
      <xs:sequence>
        <xs:element name="missing" type="tns:Nope"/>
        <xs:element name="badPrefix" type="zz:Foo"/>
        <xs:element name="id" type="xs:int"><xs:key name="k"><xs:selector xpath="."/><xs:field xpath="@a"/></xs:key></xs:element>
        <xs:element name="sub" type="xs:string" substitutionGroup="tns:head"/>
        <xs:element name="dup" type="xs:string"/>
        <xs:element name="dup" type="xs:int"/>
      </xs:sequence>
    </xs:complexType>
    <xs:complexType name="T"/>
    <xs:complexType name="Rep"><xs:sequence maxOccurs="unbounded"><xs:element name="p" type="xs:string"/></xs:sequence></xs:complexType>
  `,
  );
  const messages = out.diagnostics.map((x) => x.message);
  const has = (s: string): boolean => messages.some((m) => m.includes(s));

  test("reports what it cannot follow or represent", () => {
    expect(has("xs:import of namespace")).toBe(true);
    expect(has("xs:include")).toBe(true);
    expect(has("xs:redefine")).toBe(true);
    expect(has("xs:notation")).toBe(true);
    expect(has("xs:appinfo")).toBe(true);
    expect(has("identity constraints")).toBe(true);
    expect(has("substitution group")).toBe(true);
    expect(has("declared more than once")).toBe(true);
    expect(has("occurs twice with different types")).toBe(true);
    expect(has("repeated xs:sequence")).toBe(true);
  });

  test("an unresolved reference is unknown, not a dangling ref", () => {
    const f = obj(out.defs.T!);
    expect(f.missing!.shape.kind).toBe("unknown");
    expect(f.missing!.meta.xsd).toEqual({ unresolved: `{${NS}}Nope` });
    expect(f.badPrefix!.shape.kind).toBe("unknown");
    expect(has('"zz:Foo" uses a namespace prefix that is not declared')).toBe(true);
  });

  test("documentation survives next to an appinfo", () => {
    expect(out.defs.T!.meta.description).toBe("Doc.");
  });

  test("a repeated group flattens to arrays", () => {
    expect(obj(out.defs.Rep!).p!.shape.kind).toBe("array");
  });

  test("a non-schema root is reported and skipped", () => {
    const r = fromXsd(parseXml("<foo/>"));
    expect(r.defs).toEqual({});
    expect(r.diagnostics[0]!.message).toContain("not an xs:schema");
  });
});
