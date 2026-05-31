// @rhi-zone/fractal-protocol-request-response
// PROTOCOL axis instance — the one-shot request/response protocol form. Unlike
// the duplex `correlation` protocol, each call is its OWN addressed round-trip:
// correlation is implicit (one request = one call), so there is no `id` and no
// multiplexing. The medium is a request-scoped {@link Exchange} (the
// channel-http package supplies the HTTP instance).
//
// The value↔Result mapping that defines this protocol form lives in the kernel
// as the generic `composeRequestResponse` assembler (the request-response
// analogue of `compose`). This package is the NAMED home of that protocol form,
// re-exporting the assembler + its `Exchange`/`ExchangeResponse` interfaces so
// callers select the protocol from a protocol-axis package symmetrically with
// `@rhi-zone/fractal-protocol-correlation`.
//
// NOTE (flag): there is no standalone `requestResponse` Protocol *object* the way
// `correlation` is one — the duplex `Protocol` interface (persistent
// MessageStream) and the one-shot `Exchange` form are different shapes, and the
// one-shot form's whole logic IS the generic kernel assembler. So this package
// is a thin re-export rather than a fresh instance. Kept as a package for naming
// symmetry and a stable import site for the request-response surface.

export {
  composeRequestResponse,
  type Exchange,
  type ExchangeResponse,
} from '@rhi-zone/fractal-transport'
