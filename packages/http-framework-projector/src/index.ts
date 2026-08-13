// packages/http-framework-projector/src/index.ts — @rhi-zone/fractal-http-framework-projector
//
// Package root entry point. Idiomatic router codegen for existing HTTP
// frameworks (Express, then Fastify — see
// docs/design/framework-router-codegen.md for the full framework priority
// list), each target living in its own sibling module (`./express`,
// `./fastify`, future `./koa`, ...) — the same one-IR/many-named-target-emitters
// shape `type-ir`'s doc projectors use (docs/reference/type-ir/doc-projectors.md).

export { generateExpressRouter, generateExpressRouterFromNode } from "./express.ts";
export type { ExpressCodegenOptions } from "./express.ts";
export { generateFastifyRoutes, generateFastifyRoutesFromNode } from "./fastify.ts";
export type { FastifyCodegenOptions } from "./fastify.ts";
