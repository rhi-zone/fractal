// Worked example app, composed entirely from `path` / `methods` / `choice`.
// No Route/Router/Ctx types exist; params are read off the Request via
// `segments(req)`. Path consumption is proven by the nested `/users/:id/posts`
// route, reached purely by advancing the Request URL.

import {
  choice,
  json,
  methods,
  path,
  rest,
  segments,
  text,
  type Handler,
} from "./std.ts";

// In-memory data so responses are observable.
const users = [
  { id: "1", name: "ada" },
  { id: "2", name: "alan" },
];

// GET /users  and  POST /users
const usersCollection: Handler = methods({
  GET: () => json(users),
  POST: () => json({ created: true }, { status: 201 }),
});

// GET /users/:id  — the id is read DIRECTLY off the request (no params arg, no
// capture combinator). The inner `methods` requires the path to be fully
// consumed, so we capture the id with segments(req)[0] *before* advancing past
// it with rest(req).
//
// Note: the id is read BEFORE `rest` advances, and the GET closure closes over
// it. This is the "read params directly off the Request" pattern.
const userItem: Handler = (req) => {
  const id = segments(req)[0]; // read the dynamic segment off the Request
  if (id === undefined) return undefined;
  return methods({
    GET: () => {
      const user = users.find((u) => u.id === id);
      return user
        ? json(user)
        : json({ error: "no such user" }, { status: 404 });
    },
  })(rest(req)); // advance past the id so methods sees an empty path
};

// GET /users/:id/posts  — nested resource. We read the id, advance past it,
// then `path({ posts })` consumes the literal "posts" segment, after which the
// inner `methods` sees an empty path.
const userPosts: Handler = (req) => {
  const id = segments(req)[0];
  if (id === undefined) return undefined;
  const posts = methods({
    GET: () => json({ user: id, posts: [`hello from ${id}`] }),
  });
  return path({ posts })(rest(req));
};

// /users/:id  vs  /users/:id/posts: try the nested route first; if "posts"
// does not follow, fall through to the item route. Both read the id off the
// Request independently.
const userById: Handler = choice(userPosts, userItem);

// /users : the collection (path fully consumed) OR an id branch.
const usersResource: Handler = choice(usersCollection, userById);

// A second top-level resource, to prove top-level composition.
const health: Handler = methods({
  GET: () => text("ok"),
});

export const app: Handler = path({
  users: usersResource,
  health,
});
