// examples/dogfood/src/app.ts
//
// A real-shaped feature slice ported to the fractal handler model, to validate
// the framework against the SHAPE of a production CRM resource (a sales-pipeline
// "prospects" resource). It exercises the hard parts a real app
// needs — NOT just CRUD stubs:
//
//   GET    /prospects             list with QUERY FILTERS (?status=&source=)
//   POST   /prospects             validated create -> 201
//   GET    /prospects/{id}        get-by-id (404 if unknown)
//   PATCH  /prospects/{id}        validated update (404)
//   DELETE /prospects/{id}        delete -> 204 (404)
//   PATCH  /prospects/{id}/status status transition: ERROR-CODE -> STATUS map
//                                 (404 / 409 ALREADY_CONVERTED / 422 INVALID_TRANSITION)
//   POST   /prospects/{id}/assign ORCHESTRATION: auth-role check + side effect
//
// The WHOLE resource sits behind `withAuth` (Bearer token). Every handler reads
// `req.ctx.user` typed; the `user` var is invisible to the generated client.
//
// Where fractal has NO first-class story (query-param typing; error-union typing
// in the client), the workaround is INLINE and CALLED OUT with a `GAP:` comment,
// so the findings report is grounded in the code.

import {
  choice,
  methods,
  param,
  paramValue,
  path,
  withAuth,
  type ReqWithCtx,
} from "@rhi-zone/fractal-core";
import { json, returns, status, toFetch, validated } from "@rhi-zone/fractal-http";
import {
  assignProspect,
  createProspect,
  deleteProspect,
  getProspect,
  listProspects,
  STATUSES,
  updateProspect,
  updateProspectStatus,
  type Prospect,
  type ProspectStatus,
} from "./domain.ts";
import { arrayOf, enumOf, object } from "./schema.ts";

// ---------------------------------------------------------------------------
// Auth — a toy authenticator (Bearer <name> -> a User; else 401), same discharge
// protocol as examples/todo-api. The whole /prospects subtree is wrapped.
// ---------------------------------------------------------------------------

export interface User {
  id: string;
}

function authenticate(req: Request): User | Response {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (m === null) return json({ error: "UNAUTHORIZED" }, { status: 401 });
  return { id: m[1]! };
}

// The ctx every prospects handler requires: the authenticated principal,
// discharged by `withAuth` at the subtree root.
type Ctx = { user: User };
// The ctx for a handler that ALSO sits under `param("id", ...)`: it requires the
// `id` path param too. Declaring this is what lets `CtxOf` recover the obligation
// (a bare inline `req => req.ctx.id` infers `any` — see core's CtxOf note).
type IdCtx = { user: User; id: string };

// ---------------------------------------------------------------------------
// Schemas (StandardSchema fixtures, no validator dep)
// ---------------------------------------------------------------------------

const statusSchema = enumOf(...STATUSES);
const createSchema = object({ contactName: "string", source: "string" });
const updateSchema = object({ contactName: "string" });
const assignSchema = object({ userId: "string" });
const prospectSchema = object({
  id: "string",
  contactName: "string",
  source: "string",
  status: "string",
  assignedToUserId: "string",
});
const prospectListSchema = arrayOf(prospectSchema);

// ---------------------------------------------------------------------------
// Error-code -> HTTP-status mapping. The reference pins this PER BINDING
// (`errorStatus: { ALREADY_CONVERTED: 409, INVALID_TRANSITION: 422 }`). fractal
// has no model for it, so we do it by hand at each call site.
// GAP (error-status modeling): there is no combinator to declare a route's error
// codes/statuses, and the generated client types ONLY the 200 body — see report.
// ---------------------------------------------------------------------------

const STATUS_OF: Record<string, number> = {
  NOT_FOUND: 404,
  ALREADY_CONVERTED: 409,
  INVALID_TRANSITION: 422,
  INVALID_ROLE: 422,
};

function errorResponse(code: string): Response {
  return json({ error: code }, { status: STATUS_OF[code] ?? 500 });
}

// ---------------------------------------------------------------------------
// Collection: GET /prospects (filtered list) + POST /prospects (create -> 201)
// ---------------------------------------------------------------------------

const collection = methods({
  // GAP (query params): `param` is PATH-ONLY; there is no `query(...)` combinator
  // and no typed `?status=&source=` story. We read + validate query params by hand
  // off the URL. They do NOT appear in the OpenAPI doc or the generated client
  // signature (`get: () => ...` takes no query arg). See report.
  GET: returns((req: ReqWithCtx<Ctx>) => {
    const url = new URL(req.url);
    const rawStatus = url.searchParams.get("status");
    const source = url.searchParams.get("source") ?? undefined;
    // hand-validate the status query param against the same picklist schema.
    let statusFilter: ProspectStatus | undefined;
    if (rawStatus !== null) {
      const r = statusSchema["~standard"].validate(rawStatus);
      if ("issues" in r && r.issues !== undefined) {
        return json({ error: "BAD_QUERY", issues: r.issues }, { status: 400 });
      }
      statusFilter = (r as { value: ProspectStatus }).value;
    }
    return json(
      listProspects({
        ...(statusFilter !== undefined ? { status: statusFilter } : {}),
        ...(source !== undefined ? { source } : {}),
      }),
    );
  }, prospectListSchema),

  POST: returns(
    validated(createSchema, (value, req) => {
      void (req as ReqWithCtx<Ctx>).ctx.user; // authed create (actor available)
      return status(201, createProspect(value));
    }),
    prospectSchema,
  ),
});

// ---------------------------------------------------------------------------
// /prospects/{id}/... — the NATURAL shape: each dynamic route is its own
// `param("id", ...)` sibling alt in the outer `choice`. A bodied PATCH/POST works
// even though several sibling `param` alts advance the `:id` segment first:
// advancing TEES the request body (`req.clone()` in core's `withSegments`) rather
// than transferring it, so the body stays readable for the matching leaf's
// `req.json()` regardless of how many sibling alts ran. (This used to crash with
// "ReadableStream has already been used" — fixed in @rhi-zone/fractal-core.)
// ---------------------------------------------------------------------------

// /prospects/{id}/status — PATCH a status transition (multi-error -> 404/409/422)
const statusRoute = path({
  status: methods({
    PATCH: returns(
      validated(object({ status: "string" }), (value, req) => {
        const id = paramValue(req, "id")!;
        // re-validate against the picklist (the body fixture types it as string).
        const v = statusSchema["~standard"].validate(value.status);
        if ("issues" in v && v.issues !== undefined) {
          return json({ error: "VALIDATION", issues: v.issues }, { status: 400 });
        }
        const r = updateProspectStatus(id, (v as { value: ProspectStatus }).value);
        return r.ok ? json(r.value) : errorResponse(r.error.code);
      }),
      prospectSchema,
    ),
  }),
});

// /prospects/{id}/assign — POST the orchestration (auth-role check + side effect)
const assignRoute = path({
  assign: methods({
    POST: returns(
      validated(assignSchema, (value, req) => {
        void (req as ReqWithCtx<IdCtx>).ctx.user; // actor (authed)
        const id = paramValue(req, "id")!;
        const r = assignProspect(id, value.userId);
        return r.ok ? json(r.value) : errorResponse(r.error.code);
      }),
      prospectSchema,
    ),
  }),
});

// /prospects/{id} — GET one / PATCH update / DELETE (404 on unknown)
const itemMethods = methods({
  // Declaring `ReqWithCtx<IdCtx>` propagates the `{id, user}` obligation through
  // `CtxOf` so `param`/`withAuth` discharge it. A bare `(req) => ...` would
  // infer `any` ctx and silently drop the obligation.
  GET: returns((req: ReqWithCtx<IdCtx>) => {
    const r = getProspect(req.ctx.id);
    return r.ok ? json(r.value) : errorResponse(r.error.code);
  }, prospectSchema),
  PATCH: returns(
    validated(updateSchema, (value, req) => {
      const id = paramValue(req, "id")!;
      const r = updateProspect(id, value);
      return r.ok ? json(r.value) : errorResponse(r.error.code);
    }),
    prospectSchema,
  ),
  DELETE: returns((req: ReqWithCtx<IdCtx>) => {
    const r = deleteProspect(req.ctx.id);
    return r.ok ? status(204) : errorResponse(r.error.code);
  }, prospectSchema),
});

// `choice` tries the collection first, then each {id} sibling alt in turn. Each
// dynamic route is its OWN `param("id", ...)` — the idiomatic shape. Sibling param
// alts with bodies are safe (advancing tees the body; see the note above).
const prospectsResource = choice(
  collection,
  param("id", statusRoute),
  param("id", assignRoute),
  param("id", itemMethods),
);

// The whole resource sits behind auth. `withAuth` discharges the `user` var for
// every handler beneath it; `user` never reaches the client signature.
const prospects = withAuth(authenticate, prospectsResource);

// The ROUTE TREE — the codegen + drift guard project from this bare tree's .meta.
export const app = path({ prospects });

/** WHATWG fetch handler for the app. */
export const handle = toFetch(app);

export type { Prospect };
