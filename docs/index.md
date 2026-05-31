---
layout: home

hero:
  name: fractal
  text: HTTP/RPC/IPC API library with composition via combinators
  tagline: The API is inert data. Transports, validation, and types are opt-in layers composed onto the core.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/rhi-zone/fractal

features:
  - title: Inert-data API tree
    details: Endpoints are plain data composed from a small set of primitives — not registered procedures. The structure is traversable and reflectable.
  - title: Many interpreters, one structure
    details: HTTP server, typed client, OpenAPI schema, and test runner all walk the same tree. Define once, derive all surfaces.
  - title: Open capability composition
    details: Transports, validation, and auth are opt-in combinators. The core mandates nothing — features advertise capabilities and interpreters filter by them.
---
