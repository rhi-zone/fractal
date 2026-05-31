# Introduction

fractal is an HTTP/RPC/IPC API library where endpoints are plain data composed from a small set of primitives. Transports, validation, and static types are opt-in layers composed onto the core via combinators — not built into it.

## Status

::: info Status: Idea / Skeleton
The node/combinator algebra is not yet designed. This repository is tooling and skeleton only. The next phase defines the primitive set and composition model.
:::

## Motivation

, the ecosystem app this library is built for, runs on Hono — an imperative route/middleware HTTP framework. Hono's API surface is not a reflectable value: routes and middleware are registered procedurally, so the API shape cannot be traversed, transformed, or shared across transports without rewriting. Per-surface re-description and hand-synced types are the result.

fractal makes the API an inert-data structure that multiple interpreters walk to produce artifacts: an HTTP server, a typed client proxy, an OpenAPI document, a test harness. The structure is defined once; the surfaces are derived.

## Design Constraint

The primitive set must be small and uniform. Composed presets ship alongside the primitives.

This constraint is load-bearing: composability alone does not yield a small mental model. A maximally-composable core without presets shifts assembly burden to the user — the failure mode visible in Effect. A deliberately tiny primitive set plus presets makes the common cases simple without foreclosing the general case.

## Packages

| Package | Role |
|---------|------|
| `@rhi-zone/fractal-core` | Inert-data node IR, capability contracts, Context, combinator surface |
| `@rhi-zone/fractal-rpc-dispatch` | Shared dispatch utilities for rpc-style interpreters |
| `@rhi-zone/fractal-http` | HTTP server interpreter |
| `@rhi-zone/fractal-rpc` | RPC transport interpreter |
| `@rhi-zone/fractal-ipc` | IPC transport interpreter |
| `@rhi-zone/fractal-client` | Typed client-proxy interpreter |
| `@rhi-zone/fractal-schema` | OpenAPI/JSON Schema/doc generation (zero runtime deps) |
| `@rhi-zone/fractal-facade` | Aggregator re-export |
