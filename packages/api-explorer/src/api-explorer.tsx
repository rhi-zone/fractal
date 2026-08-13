import { useMemo, useState } from "react";
import { useApiExplorerFetch } from "./fetch-context.tsx";
import { interpolatePath, pathParamNames } from "./path-template.ts";

// ============================================================================
// <ApiExplorer/> — a minimal, functional "make one real request against this
// documented route" widget, embedded per-route by http-route-reference.ts's
// generated Docusaurus/Starlight pages. Deliberately NOT a full Postman clone
// (auth flows, request history, collections, ...) — packages/playground/ is
// the place for a fuller interactive tool (see docs/design/mocked-fetch-
// backend.md's "Use case 1" vs "Use case 2" split); this component's whole
// job is "prove the documented shape works, without leaving the doc page."
//
// Every request goes through `useApiExplorerFetch()` (fetch-context.tsx) — by
// default the ambient global `fetch`, or whatever a site-wide
// `<ApiExplorerFetchProvider>` wires in (e.g. a mocked-fetch-backend
// `toDropInFetch(createFetch(tree))` instance for docs built from a tree that
// has no real deployed server yet). Either way this issues a REAL fetch call
// through that function — nothing here fabricates a response.
// ============================================================================

/** A JSON-Schema-shaped object, same open-bag convention as
 * `OpenApiSchema` (http-api-projector's openapi.ts) — this component doesn't
 * depend on that package, so the type is restated structurally rather than
 * imported. */
export type JsonSchemaLike = Record<string, unknown>;

export type ApiExplorerProps = {
  /** HTTP method, e.g. "GET", "POST". */
  readonly method: string;
  /** Route path template, `{param}` segments included, e.g. "/books/{id}". */
  readonly path: string;
  /** Base URL path/verb params resolve against; defaults to same-origin
   * (empty string — the path is used as-is, matching how `toDropInFetch`'s
   * own default `baseUrl` of `http://localhost` behaves for relative
   * input). */
  readonly baseUrl?: string;
  readonly operationId?: string;
  readonly summary?: string;
  /** Request body JSON Schema — omitted/undefined for a route with no body
   * (GET, DELETE with no input, ...). */
  readonly requestSchema?: JsonSchemaLike;
  readonly responseSchema?: JsonSchemaLike;
};

/** One placeholder value per top-level schema property, keyed by its JSON
 * Schema `type` — enough to give a reader a valid starting shape to edit,
 * not a full JSON Schema example generator (see json-schema.ts's `examples`
 * handling elsewhere in this codebase for the richer, authored-example
 * case this deliberately doesn't duplicate). */
function placeholderFor(schema: JsonSchemaLike | undefined): unknown {
  const type = schema?.type;
  switch (type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

function scaffoldFromSchema(schema: JsonSchemaLike | undefined): unknown {
  if (schema === undefined) return undefined;
  const properties = schema.properties;
  if (schema.type !== "object" || typeof properties !== "object" || properties === null) {
    return placeholderFor(schema);
  }
  const out: Record<string, unknown> = {};
  for (const [key, propSchema] of Object.entries(properties as Record<string, unknown>)) {
    out[key] = placeholderFor(propSchema as JsonSchemaLike);
  }
  return out;
}

type RequestOutcome =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "done";
      readonly httpStatus: number;
      readonly statusText: string;
      readonly bodyText: string;
      readonly contentType: string | null;
    };

const hasBody = (method: string): boolean => !["GET", "HEAD"].includes(method.toUpperCase());

export function ApiExplorer(props: ApiExplorerProps): React.ReactElement {
  const fetchImpl = useApiExplorerFetch();
  const params = useMemo(() => pathParamNames(props.path), [props.path]);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [bodyText, setBodyText] = useState<string>(() =>
    hasBody(props.method) && props.requestSchema !== undefined
      ? JSON.stringify(scaffoldFromSchema(props.requestSchema), null, 2)
      : "",
  );
  const [outcome, setOutcome] = useState<RequestOutcome>({ status: "idle" });

  const resolvedPath = interpolatePath(props.path, paramValues);
  const url = `${props.baseUrl ?? ""}${resolvedPath}`;

  async function send(): Promise<void> {
    setOutcome({ status: "loading" });
    try {
      const init: RequestInit = { method: props.method };
      if (hasBody(props.method) && bodyText.trim().length > 0) {
        init.headers = { "content-type": "application/json" };
        init.body = bodyText;
      }
      const res = await fetchImpl(url, init);
      const text = await res.text();
      setOutcome({
        status: "done",
        httpStatus: res.status,
        statusText: res.statusText,
        bodyText: text,
        contentType: res.headers.get("content-type"),
      });
    } catch (err) {
      setOutcome({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="api-explorer" data-testid="api-explorer">
      <div className="api-explorer-request-line">
        <span className="api-explorer-method">{props.method.toUpperCase()}</span>
        <code className="api-explorer-path">{resolvedPath}</code>
      </div>

      {params.length > 0 && (
        <div className="api-explorer-params">
          {params.map((name) => (
            <label key={name}>
              {name}
              <input
                type="text"
                value={paramValues[name] ?? ""}
                onChange={(e) => {
                  setParamValues((prev) => ({ ...prev, [name]: e.target.value }));
                }}
                placeholder={name}
              />
            </label>
          ))}
        </div>
      )}

      {hasBody(props.method) && props.requestSchema !== undefined && (
        <textarea
          className="api-explorer-body"
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          rows={6}
          spellCheck={false}
        />
      )}

      <button type="button" onClick={() => void send()} disabled={outcome.status === "loading"}>
        {outcome.status === "loading" ? "Sending…" : "Send"}
      </button>

      {outcome.status === "error" && <div className="api-explorer-error">{outcome.message}</div>}

      {outcome.status === "done" && (
        <div className="api-explorer-response" data-testid="api-explorer-response">
          <div className="api-explorer-response-status">
            {outcome.httpStatus} {outcome.statusText}
          </div>
          <pre className="api-explorer-response-body">{outcome.bodyText}</pre>
        </div>
      )}
    </div>
  );
}
