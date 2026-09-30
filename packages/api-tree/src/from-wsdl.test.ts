import { describe, expect, test } from "bun:test";
import { toSDL } from "@rhi-zone/fractal-graphql-api-projector";
import { toTools } from "@rhi-zone/fractal-mcp-api-projector";
import { addressKey, type Operation } from "./api-description.ts";
import { fromWsdlDocument, parseXml } from "./from-wsdl.ts";
import { lower, nameKeys, schemaMap, typeRefMap } from "./lower.ts";

const shop = `<?xml version="1.0" encoding="UTF-8"?>
<definitions name="Shop" targetNamespace="urn:shop"
    xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:tns="urn:shop"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
    xmlns:http="http://schemas.xmlsoap.org/wsdl/http/"
    xmlns:mime="http://schemas.xmlsoap.org/wsdl/mime/">
  <documentation>The shop.</documentation>
  <import namespace="urn:other" location="other.wsdl"/>
  <types>
    <xsd:schema targetNamespace="urn:shop" elementFormDefault="qualified">
      <xsd:simpleType name="Currency">
        <xsd:restriction base="xsd:string"><xsd:enumeration value="USD"/><xsd:enumeration value="EUR"/></xsd:restriction>
      </xsd:simpleType>
      <xsd:complexType name="Item">
        <xsd:sequence>
          <xsd:element name="id" type="xsd:int"/>
          <xsd:element name="name" type="xsd:string"/>
          <xsd:element name="price" type="xsd:decimal"/>
          <xsd:element name="currency" type="tns:Currency" minOccurs="0"/>
          <xsd:element name="tag" type="xsd:string" minOccurs="0" maxOccurs="unbounded"/>
        </xsd:sequence>
      </xsd:complexType>
      <xsd:element name="GetItem">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="id" type="xsd:int"/>
          <xsd:element name="locale" type="xsd:string" minOccurs="0"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="GetItemResponse">
        <xsd:complexType><xsd:sequence><xsd:element name="item" type="tns:Item"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="NotFound">
        <xsd:complexType><xsd:sequence><xsd:element name="id" type="xsd:int"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="Ping"><xsd:complexType><xsd:sequence><xsd:element name="text" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="StockChanged"><xsd:complexType><xsd:sequence>
        <xsd:element name="id" type="xsd:int"/><xsd:element name="quantity" type="xsd:int"/>
      </xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="Confirm"><xsd:complexType><xsd:sequence><xsd:element name="orderId" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="ConfirmResponse"><xsd:complexType><xsd:sequence><xsd:element name="ok" type="xsd:boolean"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="AuthToken" type="xsd:string"/>
    </xsd:schema>
  </types>

  <message name="GetItemIn"><part name="parameters" element="tns:GetItem"/><part name="auth" element="tns:AuthToken"/></message>
  <message name="GetItemOut"><part name="parameters" element="tns:GetItemResponse"/></message>
  <message name="NotFoundFault"><part name="fault" element="tns:NotFound"/></message>
  <message name="AddIn"><part name="a" type="xsd:int"/><part name="b" type="xsd:int"/></message>
  <message name="AddOut"><part name="sum" type="xsd:int"/></message>
  <message name="PingIn"><part name="parameters" element="tns:Ping"/></message>
  <message name="StockChangedOut"><part name="parameters" element="tns:StockChanged"/></message>
  <message name="ConfirmOut"><part name="parameters" element="tns:Confirm"/></message>
  <message name="ConfirmIn"><part name="parameters" element="tns:ConfirmResponse"/></message>
  <message name="ByIdIn"><part name="id" type="xsd:int"/></message>
  <message name="ByNameIn"><part name="name" type="xsd:string"/></message>
  <message name="LookupOut"><part name="item" type="tns:Item"/></message>
  <message name="Broken"><part name="x" type="tns:Missing"/></message>

  <portType name="ShopPortType">
    <documentation>Shop operations.</documentation>
    <operation name="GetItem">
      <documentation>Fetch one item.</documentation>
      <input message="tns:GetItemIn"/>
      <output message="tns:GetItemOut"/>
      <fault name="NotFound" message="tns:NotFoundFault"/>
    </operation>
    <operation name="Add" parameterOrder="a b">
      <input message="tns:AddIn"/>
      <output message="tns:AddOut"/>
    </operation>
    <operation name="Ping"><input message="tns:PingIn"/></operation>
    <operation name="StockChanged"><output message="tns:StockChangedOut"/></operation>
    <operation name="Confirm"><output message="tns:ConfirmOut"/><input message="tns:ConfirmIn"/></operation>
    <operation name="Lookup"><input name="ById" message="tns:ByIdIn"/><output message="tns:LookupOut"/></operation>
    <operation name="Lookup"><input name="ByName" message="tns:ByNameIn"/><output message="tns:LookupOut"/></operation>
    <operation name="Broken"><input message="tns:Broken"/><output message="tns:Missing"/></operation>
  </portType>
  <portType name="Legacy">
    <operation name="Search"><input message="tns:ByNameIn"/><output message="tns:LookupOut"/></operation>
  </portType>

  <binding name="ShopSoap11" type="tns:ShopPortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="GetItem">
      <soap:operation soapAction="urn:shop#GetItem"/>
      <input><soap:body use="literal" parts="parameters"/><soap:header message="tns:GetItemIn" part="auth" use="literal"/></input>
      <output><soap:body use="literal"/></output>
      <fault name="NotFound"><soap:fault name="NotFound" use="literal"/></fault>
    </operation>
    <operation name="Add">
      <soap:operation soapAction="urn:shop#Add" style="rpc"/>
      <input><soap:body use="encoded" namespace="urn:shop" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></input>
      <output><soap:body use="encoded" namespace="urn:shop" encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"/></output>
    </operation>
    <operation name="Ping"><soap:operation soapAction="urn:shop#Ping"/><input><soap:body use="literal"/></input></operation>
  </binding>
  <binding name="ShopSoap12" type="tns:ShopPortType">
    <soap12:binding style="document" transport="http://www.w3.org/2003/05/soap/bindings/HTTP/"/>
    <operation name="GetItem"><soap12:operation soapAction="urn:shop#GetItem"/><input><soap12:body use="literal"/></input><output><soap12:body use="literal"/></output></operation>
  </binding>
  <binding name="LegacyHttp" type="tns:Legacy">
    <http:binding verb="GET"/>
    <operation name="Search"><http:operation location="/search"/><input><http:urlEncoded/></input><output><mime:mimeXml part="item"/></output></operation>
  </binding>

  <service name="ShopService">
    <documentation>The endpoints.</documentation>
    <port name="ShopPort11" binding="tns:ShopSoap11"><soap:address location="https://shop.example/soap11"/></port>
    <port name="ShopPort12" binding="tns:ShopSoap12"><soap12:address location="https://shop.example/soap12"/></port>
    <port name="LegacyPort" binding="tns:LegacyHttp"><http:address location="https://shop.example/legacy"/></port>
    <port name="Dangling" binding="tns:Nope"><soap:address location="https://shop.example/x"/></port>
  </service>
</definitions>`;

const hotel = `<?xml version="1.0"?>
<description xmlns="http://www.w3.org/ns/wsdl" targetNamespace="urn:hotel"
    xmlns:tns="urn:hotel" xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:wsoap="http://www.w3.org/ns/wsdl/soap" xmlns:whttp="http://www.w3.org/ns/wsdl/http"
    xmlns:wsdlx="http://www.w3.org/ns/wsdl-extensions">
  <documentation>Hotel reservations.</documentation>
  <types>
    <xs:schema targetNamespace="urn:hotel">
      <xs:element name="checkAvailability"><xs:complexType><xs:sequence>
        <xs:element name="checkInDate" type="xs:date"/>
        <xs:element name="roomType" type="xs:string" minOccurs="0"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="checkAvailabilityResponse" type="xs:double"/>
      <xs:element name="invalidDataError" type="xs:string"/>
      <xs:element name="log" type="xs:string"/>
      <xs:element name="alert" type="xs:string"/>
      <xs:element name="cancel"><xs:complexType><xs:sequence><xs:element name="id" type="xs:string"/></xs:sequence></xs:complexType></xs:element>
    </xs:schema>
  </types>
  <interface name="Reservation">
    <fault name="invalidDataFault" element="tns:invalidDataError"/>
    <operation name="checkAvailability" pattern="http://www.w3.org/ns/wsdl/in-out" style="http://www.w3.org/ns/wsdl/style/iri" wsdlx:safe="true">
      <documentation>Is there a room?</documentation>
      <input messageLabel="In" element="tns:checkAvailability"/>
      <output messageLabel="Out" element="tns:checkAvailabilityResponse"/>
      <outfault ref="tns:invalidDataFault" messageLabel="Out"/>
    </operation>
    <operation name="log" pattern="http://www.w3.org/ns/wsdl/in-only"><input element="tns:log"/></operation>
    <operation name="alert" pattern="http://www.w3.org/ns/wsdl/out-only"><output element="tns:alert"/></operation>
    <operation name="poll"><input element="#none"/><output element="#any"/></operation>
    <operation name="odd" pattern="urn:custom:mep"><input element="tns:log"/></operation>
    <operation name="maybe" pattern="http://www.w3.org/ns/wsdl/in-opt-out"><input element="tns:log"/><output element="tns:log"/></operation>
  </interface>
  <interface name="Extended" extends="tns:Reservation">
    <operation name="cancel" pattern="http://www.w3.org/ns/wsdl/in-out"><input element="tns:cancel"/><output element="tns:log"/></operation>
  </interface>
  <binding name="ReservationSoap" interface="tns:Reservation" type="http://www.w3.org/ns/wsdl/soap"
      wsoap:protocol="http://www.w3.org/2003/05/soap/bindings/HTTP/">
    <operation ref="tns:checkAvailability" wsoap:mep="http://www.w3.org/2003/05/soap/mep/request-response" wsoap:action="urn:hotel#check"/>
  </binding>
  <binding name="ReservationHttp" interface="tns:Reservation" type="http://www.w3.org/ns/wsdl/http" whttp:methodDefault="POST">
    <operation ref="tns:checkAvailability" whttp:method="GET" whttp:location="check/{checkInDate}"/>
  </binding>
  <service name="ReservationService" interface="tns:Reservation">
    <endpoint name="soapEndpoint" binding="tns:ReservationSoap" address="https://hotel.example/soap"/>
    <endpoint name="httpEndpoint" binding="tns:ReservationHttp" address="https://hotel.example/rest/"/>
  </service>
</description>`;

const byAddress = (ops: readonly Operation[]): Record<string, Operation> =>
  Object.fromEntries(ops.map((o) => [addressKey(o.address), o]));

const fieldsOf = (
  op: Operation,
): Record<string, { shape: { kind: string }; meta: Record<string, unknown> }> =>
  (op.input.shape as unknown as { fields: never }).fields;

const wsdlOf = (op: Operation): Record<string, any> => op.meta.wsdl as Record<string, any>;

describe("parseXml", () => {
  test("resolves namespaces and decodes references", () => {
    const el = parseXml(
      `<a xmlns="urn:d" xmlns:p="urn:p" p:x="1&amp;&#65;"><p:b>t&lt;</p:b><!-- c --><![CDATA[<z>]]></a>`,
    );
    expect(el.ns).toBe("urn:d");
    expect(el.attrs).toEqual({ "p:x": "1&A" });
    expect(el.children[0]!.ns).toBe("urn:p");
    expect(el.children[0]!.text).toBe("t<");
    expect(el.text).toBe("<z>");
    expect(el.children[0]!.scope.p).toBe("urn:p");
  });

  test("rejects malformed XML and DOCTYPE", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(/parseXml/);
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(/DOCTYPE/);
  });
});

describe("WSDL 1.1 import", () => {
  const imported = fromWsdlDocument(shop);
  const ops = byAddress(imported.api.operations);
  const messages = imported.diagnostics.map((d) => `${d.at}: ${d.message}`);
  const has = (s: string): boolean => messages.some((m) => m.includes(s));

  test("version and addresses: portType then operation", () => {
    expect(imported.version).toBe("1.1");
    expect(Object.keys(ops).sort()).toEqual(
      [
        "Legacy/Search",
        "ShopPortType/Add",
        "ShopPortType/Broken",
        "ShopPortType/Confirm",
        "ShopPortType/GetItem",
        "ShopPortType/Lookup_ById",
        "ShopPortType/Lookup_ByName",
        "ShopPortType/Ping",
        "ShopPortType/StockChanged",
      ].sort(),
    );
    expect(imported.api.operations.some((o) => "http" in o.meta)).toBe(false);
  });

  test("groups carry documentation, services and endpoints", () => {
    const root = imported.api.groups.find((g) => g.address.length === 0)!;
    expect(root.meta.description).toBe("The shop.");
    expect(root.meta.wsdl).toMatchObject({
      version: "1.1",
      name: "Shop",
      targetNamespace: "urn:shop",
    });
    const pt = imported.api.groups.find((g) => addressKey(g.address) === "ShopPortType")!;
    expect(pt.meta.description).toBe("Shop operations.");
    expect((pt.meta.wsdl as any).services).toEqual([
      {
        service: "ShopService",
        port: "ShopPort11",
        binding: "ShopSoap11",
        address: "https://shop.example/soap11",
      },
      {
        service: "ShopService",
        port: "ShopPort12",
        binding: "ShopSoap12",
        address: "https://shop.example/soap12",
      },
    ]);
  });

  test("a wrapped document/literal operation takes the wrapper's children as params, header parts follow", () => {
    const op = ops["ShopPortType/GetItem"]!;
    expect(op.meta.description).toBe("Fetch one item.");
    expect(Object.keys(fieldsOf(op))).toEqual(["id", "locale", "auth"]);
    expect(fieldsOf(op).locale!.meta.optional).toBe(true);
    expect(fieldsOf(op).auth!.shape.kind).toBe("string");
    expect(op.output).toEqual({ shape: { kind: "ref", target: "GetItemResponse" }, meta: {} });
    expect(op.meta.tags).toEqual({});
  });

  test("SOAP details are kept verbatim per binding, with endpoint addresses", () => {
    const w = wsdlOf(ops["ShopPortType/GetItem"]!);
    expect(w).toMatchObject({
      version: "1.1",
      portType: "ShopPortType",
      operation: "GetItem",
      pattern: "request-response",
    });
    expect(w.input).toEqual({
      message: "{urn:shop}GetItemIn",
      parts: [
        { name: "parameters", element: "{urn:shop}GetItem" },
        { name: "auth", element: "{urn:shop}AuthToken" },
      ],
    });
    const [b11, b12] = w.bindings;
    expect(b11.binding).toBe("ShopSoap11");
    expect(b11.soap.version).toBe("1.1");
    expect(b11.soap.binding).toEqual({
      style: "document",
      transport: "http://schemas.xmlsoap.org/soap/http",
    });
    expect(b11.soap.operation).toEqual({ soapAction: "urn:shop#GetItem" });
    expect(b11.soap.input.body).toEqual({ use: "literal", parts: "parameters" });
    expect(b11.soap.input.headers).toEqual([
      { message: "tns:GetItemIn", part: "auth", use: "literal" },
    ]);
    expect(b11.ports).toEqual([
      { service: "ShopService", port: "ShopPort11", address: "https://shop.example/soap11" },
    ]);
    expect(b12.soap.version).toBe("1.2");
    expect(b12.ports[0].address).toBe("https://shop.example/soap12");
    expect(has("SOAP headers are kept")).toBe(true);
  });

  test("faults are kept verbatim and reported", () => {
    expect(wsdlOf(ops["ShopPortType/GetItem"]!).faults).toEqual([
      {
        name: "NotFound",
        message: "{urn:shop}NotFoundFault",
        parts: [{ name: "fault", element: "{urn:shop}NotFound" }],
      },
    ]);
    expect(wsdlOf(ops["ShopPortType/GetItem"]!).bindings[0].soap.faults).toEqual([
      { name: "NotFound", use: "literal" },
    ]);
    expect(has("faults are kept under meta.wsdl.faults")).toBe(true);
  });

  test("an rpc operation's parts are its params and its single out part is the output", () => {
    const op = ops["ShopPortType/Add"]!;
    expect(Object.keys(fieldsOf(op))).toEqual(["a", "b"]);
    expect(fieldsOf(op).a!.shape.kind).toBe("int32");
    expect(op.output!.shape.kind).toBe("int32");
    const w = wsdlOf(op);
    expect(w.parameterOrder).toEqual(["a", "b"]);
    expect(w.bindings[0].soap.operation).toEqual({ soapAction: "urn:shop#Add", style: "rpc" });
    expect(w.bindings[0].soap.input.body.use).toBe("encoded");
  });

  test("one-way has a void output", () => {
    const op = ops["ShopPortType/Ping"]!;
    expect(Object.keys(fieldsOf(op))).toEqual(["text"]);
    expect(op.output!.shape.kind).toBe("void");
    expect(wsdlOf(op).pattern).toBe("one-way");
  });

  test("notification is a streaming output with no input", () => {
    const op = ops["ShopPortType/StockChanged"]!;
    expect(Object.keys(fieldsOf(op))).toEqual([]);
    expect(op.output!.shape.kind).toBe("stream");
    expect(op.meta.tags).toEqual({ streaming: true });
    expect(wsdlOf(op).pattern).toBe("notification");
    expect(wsdlOf(op).output.parts).toEqual([
      { name: "parameters", element: "{urn:shop}StockChanged" },
    ]);
  });

  test("solicit-response streams the solicit and keeps the reply verbatim", () => {
    const op = ops["ShopPortType/Confirm"]!;
    expect(op.output!.shape.kind).toBe("stream");
    expect(op.meta.tags).toEqual({ streaming: true });
    expect(wsdlOf(op).reply).toEqual({
      message: "{urn:shop}ConfirmIn",
      parts: [{ name: "parameters", element: "{urn:shop}ConfirmResponse" }],
    });
    expect(wsdlOf(op).input).toBeUndefined();
    expect(has("kept under meta.wsdl.reply")).toBe(true);
  });

  test("an overloaded operation is keyed by its input name and reported", () => {
    expect(Object.keys(fieldsOf(ops["ShopPortType/Lookup_ById"]!))).toEqual(["id"]);
    expect(Object.keys(fieldsOf(ops["ShopPortType/Lookup_ByName"]!))).toEqual(["name"]);
    expect(wsdlOf(ops["ShopPortType/Lookup_ByName"]!).operation).toBe("Lookup");
    expect(has('operation "Lookup" is declared more than once; keyed "Lookup_ByName"')).toBe(true);
  });

  test("an unresolvable message or type is unknown and reported", () => {
    const op = ops["ShopPortType/Broken"]!;
    expect(fieldsOf(op).x!.shape.kind).toBe("unknown");
    expect(fieldsOf(op).x!.meta.wsdl).toEqual({ unresolved: "{urn:shop}Missing" });
    expect(op.output!.shape.kind).toBe("void");
    expect(has('message "{urn:shop}Missing" is not declared')).toBe(true);
  });

  test("the HTTP binding is kept verbatim, not turned into meta.http", () => {
    const op = ops["Legacy/Search"]!;
    const b = wsdlOf(op).bindings[0];
    expect(b.http.binding).toEqual({ verb: "GET" });
    expect(b.http.operation).toEqual({ location: "/search" });
    expect(b.http.input.extensions.map((e: { name: string }) => e.name)).toEqual([
      "{http://schemas.xmlsoap.org/wsdl/http/}urlEncoded",
    ]);
    expect(b.http.output.extensions[0]).toEqual({
      name: "{http://schemas.xmlsoap.org/wsdl/mime/}mimeXml",
      attributes: { part: "item" },
    });
    expect(b.ports).toEqual([
      { service: "ShopService", port: "LegacyPort", address: "https://shop.example/legacy" },
    ]);
    expect(op.meta.http).toBeUndefined();
    expect(has("not turned into meta.http")).toBe(true);
  });

  test("schema types become defs", () => {
    expect(imported.api.defs.Currency!.shape).toEqual({ kind: "enum", members: ["USD", "EUR"] });
    expect(Object.keys(imported.api.defs)).toContain("Item");
    expect(Object.keys(imported.api.defs)).toContain("GetItem");
  });

  test("everything else is reported, nothing throws", () => {
    expect(has("import of other.wsdl is not followed")).toBe(true);
    expect(has('binding "{urn:shop}Nope" is not declared')).toBe(true);
  });

  test("the result is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(imported.api))).toEqual(imported.api);
  });
});

describe("WSDL 2.0 import", () => {
  const imported = fromWsdlDocument(hotel);
  const ops = byAddress(imported.api.operations);
  const messages = imported.diagnostics.map((d) => `${d.at}: ${d.message}`);
  const has = (s: string): boolean => messages.some((m) => m.includes(s));

  test("version and addresses: interface then operation", () => {
    expect(imported.version).toBe("2.0");
    expect(Object.keys(ops).sort()).toEqual(
      [
        "Extended/cancel",
        "Reservation/alert",
        "Reservation/checkAvailability",
        "Reservation/log",
        "Reservation/maybe",
        "Reservation/odd",
        "Reservation/poll",
      ].sort(),
    );
  });

  test("in-out with a wrapped element, wsdlx:safe as readOnly, documentation as description", () => {
    const op = ops["Reservation/checkAvailability"]!;
    expect(Object.keys(fieldsOf(op))).toEqual(["checkInDate", "roomType"]);
    expect(fieldsOf(op).checkInDate!.shape.kind).toBe("date");
    expect(fieldsOf(op).roomType!.meta.optional).toBe(true);
    expect(op.output!.shape.kind).toBe("float64");
    expect(op.meta.tags).toEqual({ readOnly: true });
    expect(op.meta.description).toBe("Is there a room?");
    expect(wsdlOf(op)).toMatchObject({
      version: "2.0",
      interface: "Reservation",
      pattern: "http://www.w3.org/ns/wsdl/in-out",
      style: ["http://www.w3.org/ns/wsdl/style/iri"],
      safe: true,
    });
  });

  test("bindings, endpoints and faults are kept verbatim", () => {
    const w = wsdlOf(ops["Reservation/checkAvailability"]!);
    const [soap, http] = w.bindings;
    expect(soap).toMatchObject({ binding: "ReservationSoap", protocol: "soap" });
    expect(soap.soap.binding).toEqual({
      protocol: "http://www.w3.org/2003/05/soap/bindings/HTTP/",
    });
    expect(soap.soap.operation).toEqual({
      mep: "http://www.w3.org/2003/05/soap/mep/request-response",
      action: "urn:hotel#check",
    });
    expect(soap.ports).toEqual([
      {
        service: "ReservationService",
        endpoint: "soapEndpoint",
        address: "https://hotel.example/soap",
      },
    ]);
    expect(http.http.operation).toEqual({ method: "GET", location: "check/{checkInDate}" });
    expect(http.http.binding).toEqual({ methodDefault: "POST" });
    expect(ops["Reservation/checkAvailability"]!.meta.http).toBeUndefined();
    expect(w.faults).toEqual([
      {
        ref: "{urn:hotel}invalidDataFault",
        direction: "out",
        messageLabel: "Out",
        element: "tns:invalidDataError",
      },
    ]);
    expect(has("faults are kept under meta.wsdl.faults")).toBe(true);
    expect(has("not turned into meta.http")).toBe(true);
  });

  test("in-only is void; out-only streams", () => {
    expect(ops["Reservation/log"]!.output!.shape.kind).toBe("void");
    expect(fieldsOf(ops["Reservation/log"]!)).toHaveProperty("log");
    const alert = ops["Reservation/alert"]!;
    expect(alert.output!.shape.kind).toBe("stream");
    expect(alert.meta.tags).toEqual({ streaming: true });
    expect(Object.keys(fieldsOf(alert))).toEqual([]);
  });

  test("a missing pattern is in-out; #none is empty and #any is unknown", () => {
    const poll = ops["Reservation/poll"]!;
    expect(wsdlOf(poll).pattern).toBe("http://www.w3.org/ns/wsdl/in-out");
    expect(Object.keys(fieldsOf(poll))).toEqual([]);
    expect(poll.output!.shape.kind).toBe("unknown");
  });

  test("an unknown pattern is derived from its messages and reported; in-opt-out is reported", () => {
    expect(ops["Reservation/odd"]!.output!.shape.kind).toBe("void");
    expect(has('"urn:custom:mep" is not a predefined one')).toBe(true);
    expect(ops["Reservation/maybe"]!.output!.shape.kind).toBe("string");
    expect(has("the response is optional")).toBe(true);
  });

  test("extends stays on the group and inherited operations are not repeated", () => {
    const g = imported.api.groups.find((x) => addressKey(x.address) === "Extended")!;
    expect((g.meta.wsdl as any).extends).toEqual(["{urn:hotel}Reservation"]);
    expect(Object.keys(ops).filter((k) => k.startsWith("Extended/"))).toEqual(["Extended/cancel"]);
    expect(has("inherited operations are not repeated")).toBe(true);
  });

  test("endpoints are listed on the interface group", () => {
    const g = imported.api.groups.find((x) => addressKey(x.address) === "Reservation")!;
    expect((g.meta.wsdl as any).services).toEqual([
      {
        service: "ReservationService",
        endpoint: "soapEndpoint",
        binding: "ReservationSoap",
        address: "https://hotel.example/soap",
      },
      {
        service: "ReservationService",
        endpoint: "httpEndpoint",
        binding: "ReservationHttp",
        address: "https://hotel.example/rest/",
      },
    ]);
  });
});

describe("input validation", () => {
  test("a non-WSDL root throws", () => {
    expect(() => fromWsdlDocument("<definitions/>")).toThrow(/not a WSDL/);
  });

  test("a document with no portType still imports its types", () => {
    const r = fromWsdlDocument(
      `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:e">
         <types><xsd:schema targetNamespace="urn:e"><xsd:simpleType name="S"><xsd:restriction base="xsd:string"/></xsd:simpleType></xsd:schema></types>
       </definitions>`,
    );
    expect(r.api.operations).toEqual([]);
    expect(Object.keys(r.api.defs)).toEqual(["S"]);
    expect(r.diagnostics.some((d) => d.message.includes("no portType"))).toBe(true);
  });

  test("XSD problems surface as diagnostics under types/", () => {
    const r = fromWsdlDocument(
      `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:e">
         <types><xsd:schema targetNamespace="urn:e"><xsd:include schemaLocation="x.xsd"/></xsd:schema></types>
       </definitions>`,
    );
    expect(
      r.diagnostics.some((d) => d.at.startsWith("types/") && d.message.includes("xs:include")),
    ).toBe(true);
  });
});

describe("lower + projectors", () => {
  const imported = fromWsdlDocument(shop);
  const lowered = lower(imported.api);

  test("the tree mirrors portType/operation", () => {
    expect(Object.keys(lowered.tree.children!).sort()).toEqual(["Legacy", "ShopPortType"]);
    expect(Object.keys(lowered.tree.children!.ShopPortType!.children!)).toContain("GetItem");
    expect(lowered.tree.children!.ShopPortType!.meta.description).toBe("Shop operations.");
  });

  test("mcp tools carry the params and the response schema", () => {
    const tools = toTools(lowered.tree, { schemas: schemaMap(lowered, nameKeys) });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const get = byName.ShopPortType_GetItem!;
    expect(Object.keys((get.inputSchema as { properties: object }).properties)).toEqual([
      "id",
      "locale",
      "auth",
    ]);
    expect((get.inputSchema as { required: string[] }).required).toEqual(["id", "auth"]);
    expect(get.description).toBe("Fetch one item.");
    const out = schemaMap(lowered, nameKeys).ShopPortType_GetItem!.outputSchema as {
      $ref?: string;
      $defs: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(out.$ref).toBe("#/$defs/GetItemResponse");
    expect(Object.keys(out.$defs.GetItemResponse!.properties)).toEqual(["item"]);
    expect(Object.keys(out.$defs)).toContain("Item");
    expect(byName.ShopPortType_StockChanged!.streaming).toBe(true);
  });

  test("graphql: params become arguments and a notification is a subscription", () => {
    const sdl = toSDL(lowered.tree, {
      types: typeRefMap(lowered, nameKeys),
      namedTypes: lowered.defs,
    });
    expect(sdl).toContain("ShopPortTypeAdd(a: Int!, b: Int!)");
    expect(sdl).toMatch(/type Subscription \{[^}]*ShopPortTypeStockChanged/);
  });
});
