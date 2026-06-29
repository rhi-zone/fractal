// examples/spine-demo/src/app.ts
//
// A small app authored in the resolved D-syntax — the vertical slice the doc's
// example mirrors. A `classes` resource indexed by `param("id")`, wrapped in a
// `group` capability that produces an authenticated `user`, with GET/POST leaves
// (a `from` query field; the POST also takes a typed body), plus a `health`
// route. The handlers are pure, provenance-blind functions of a flat `options`
// record — they cannot tell a path-param from a capability from a query field.

import {
  app,
  group,
  methods,
  obj,
  ok,
  param,
  path,
  route,
  str,
  type Result,
} from "@rhi-zone/fractal-core";

// A capability value and a domain error, both ordinary typed data.
export interface User {
  readonly id: string;
}
export interface ApiError {
  readonly status: number;
  readonly error: string;
}

/** A server-side capability producer: authenticate via a bearer token. A
 *  missing/invalid token short-circuits the whole subtree with a 401. */
function currentUser(req: Request): Result<User, ApiError> {
  const auth = req.headers.get("authorization");
  if (auth === null || !auth.startsWith("Bearer ")) {
    return { ok: false, error: { status: 401, error: "unauthorized" } };
  }
  return ok({ id: auth.slice("Bearer ".length) });
}

export const tree = app(
  path({
    classes: param(
      "id",
      group(
        "user",
        currentUser,
        methods({
          GET: route({
            query: { from: str() },
            // options = { id (param), user (capability), from (query) }
            handler: ({ id, from, user }) =>
              ok({ id, from, userId: user.id }),
          }),
          POST: route({
            query: { from: str() },
            body: obj({ title: str() }),
            // options = { id, user, from, body }
            handler: ({ id, from, body, user }) =>
              ok({ id, from, title: body.title, userId: user.id }),
          }),
        }),
      ),
    ),
    health: methods({
      GET: route({ handler: () => ok("up") }),
    }),
  }),
);
