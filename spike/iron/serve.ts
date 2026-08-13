// The only Bun touch in this module tree: a handler is the app, and this
// binds the WHATWG fetch handler from `toHandler` to Bun.serve. http.ts and
// core.ts are Bun-free; this tiny adapter is the single runtime seam.

import type { Handler } from "./core.ts";
import { type Ctx, type Reply, toHandler } from "./http.ts";

declare const Bun: {
  serve(opts: { port: number; fetch: (req: Request) => Promise<Response> }): unknown;
};

export function serve<P>(app: Handler<Ctx<P>, Reply | null, unknown>, port = 3000): unknown {
  return Bun.serve({ port, fetch: toHandler(app) });
}
