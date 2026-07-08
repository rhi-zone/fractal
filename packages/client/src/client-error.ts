// packages/client/src/client-error.ts — @rhi-zone/fractal-client
//
// Typed error thrown when the server returns a non-2xx response.

/** Thrown by the fractal runtime client when the server responds with non-2xx. */
export class ClientError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = "ClientError"
    this.status = status
    this.body = body
  }
}
