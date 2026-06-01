# Introduction

fractal is an HTTP/RPC/IPC API library where endpoints are plain data composed from a small set of primitives. Transports, validation, and static types are opt-in layers composed onto the core via combinators — not built into it.

## Status

::: info Status: Idea / Skeleton
The node/combinator algebra is not yet designed. This repository is tooling and skeleton only. The next phase defines the primitive set and composition model.
:::

## Motivation

Hono's API surface is not a reflectable value: routes and middleware are registered procedurally, so the API shape cannot be traversed, transformed, or shared across transports without rewriting. Per-surface re-description and hand-synced types are the result.

fractal makes the API an inert-data structure that multiple interpreters walk to produce artifacts: an HTTP server, a typed client proxy, an OpenAPI document, a test harness. The structure is defined once; the surfaces are derived.

## Design Constraint

The primitive set must be small and uniform. Composed presets ship alongside the primitives.

This constraint is load-bearing: composability alone does not yield a small mental model. A maximally-composable core without presets shifts assembly burden to the user — the failure mode visible in Effect. A deliberately tiny primitive set plus presets makes the common cases simple without foreclosing the general case.

## Packages

| Package | Role |
|---------|------|
| `@rhi-zone/fractal-core` | Inert-data node IR, capability contracts, Context, combinator surface |
| `@rhi-zone/fractal-transport` | Transport kernel: interfaces, assemblers, dispatcher, clientOver |
| `@rhi-zone/fractal-codec-json` | JSON codec axis instance |
| `@rhi-zone/fractal-codec-structured-clone` | Structured-clone codec axis instance |
| `@rhi-zone/fractal-protocol-correlation` | Correlation protocol axis instance (duplex) |
| `@rhi-zone/fractal-channel-http` | HTTP channel axis: request/response exchange + server handlers |
| `@rhi-zone/fractal-channel-websocket` | WebSocket channel axis: pure channel + Bun server factory |
| `@rhi-zone/fractal-channel-worker` | worker_threads (MessagePort) channel axis |
| `@rhi-zone/fractal-channel-stdio` | stdio (line-framed JSON) channel axis |
| `@rhi-zone/fractal-preset-websocket` | WebSocket convenience preset (wsClient / serveWs) |
| `@rhi-zone/fractal-standard-schema` | OpenAPI/JSON Schema/doc generation (zero runtime deps) |
