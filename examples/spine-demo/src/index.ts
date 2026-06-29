// examples/spine-demo/src/index.ts
//
// The entry that turns the protocol-neutral tree into a WHATWG fetch handler.
// Override `encodeErr` so a domain `ApiError` renders at its own status; the
// default would already honour the numeric `status`, but this shows the seam.

import { toFetch } from "@rhi-zone/fractal-http";
import { tree, type ApiError } from "./app.ts";

export const handler = toFetch(tree, {
  encodeErr: (error) => {
    const e = error as Partial<ApiError>;
    const status = typeof e.status === "number" ? e.status : 500;
    return new Response(JSON.stringify({ error: e.error ?? "internal" }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  },
});

// Wire to a runtime when run directly (no socket bound under test).
// import { serveBun } from "@rhi-zone/fractal-http/adapter";
// serveBun(handler, { port: 3000 });
