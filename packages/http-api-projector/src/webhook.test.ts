// packages/http-api-projector/src/webhook.test.ts — webhook layer tests

import { describe, expect, it } from "bun:test"
import {
  computeWebhookSignature,
  createInMemoryReplayStore,
  replayPreventionLayer,
  webhookSignatureLayer,
} from "./webhook.ts"
import type { ReplayStore } from "./webhook.ts"

const SECRET = "shh-its-a-secret"

const innerFetch = async (req: Request): Promise<Response> =>
  new Response(JSON.stringify({ ok: true, body: await req.text() }), {
    headers: { "Content-Type": "application/json" },
  })

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/webhook", { method: "POST", body, headers })
}

// ============================================================================
// webhookSignatureLayer
// ============================================================================

describe("webhookSignatureLayer", () => {
  it("401s when the signature header is missing", async () => {
    const handler = webhookSignatureLayer({ secret: SECRET })(innerFetch)
    const res = await handler(post("{}"))
    expect(res.status).toBe(401)
  })

  it("accepts a raw hex signature", async () => {
    const body = JSON.stringify({ event: "ping" })
    const sig = await computeWebhookSignature(body, SECRET)
    const handler = webhookSignatureLayer({ secret: SECRET })(innerFetch)
    const res = await handler(post(body, { "X-Webhook-Signature": sig }))
    expect(res.status).toBe(200)
    // body still readable by inner (clone() preserved it)
    const parsed = (await res.json()) as { body: string }
    expect(parsed.body).toBe(body)
  })

  it("accepts a GitHub-style 'sha256=<hex>' prefixed signature", async () => {
    const body = JSON.stringify({ event: "push" })
    const sig = await computeWebhookSignature(body, SECRET)
    const handler = webhookSignatureLayer({ secret: SECRET })(innerFetch)
    const res = await handler(post(body, { "X-Webhook-Signature": `sha256=${sig}` }))
    expect(res.status).toBe(200)
  })

  it("accepts a base64-encoded signature", async () => {
    const body = JSON.stringify({ event: "ping" })
    const hexSig = await computeWebhookSignature(body, SECRET)
    const bytes = new Uint8Array(hexSig.length / 2)
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hexSig.slice(i * 2, i * 2 + 2), 16)
    let binary = ""
    for (const b of bytes) binary += String.fromCharCode(b)
    const b64Sig = btoa(binary)

    const handler = webhookSignatureLayer({ secret: SECRET })(innerFetch)
    const res = await handler(post(body, { "X-Webhook-Signature": b64Sig }))
    expect(res.status).toBe(200)
  })

  it("401s on a mismatched signature", async () => {
    const handler = webhookSignatureLayer({ secret: SECRET })(innerFetch)
    const res = await handler(post("{}", { "X-Webhook-Signature": "0".repeat(64) }))
    expect(res.status).toBe(401)
  })

  it("401s on a malformed signature header (neither hex nor base64)", async () => {
    const handler = webhookSignatureLayer({ secret: SECRET })(innerFetch)
    const res = await handler(post("{}", { "X-Webhook-Signature": "!!!not-a-signature!!!" }))
    expect(res.status).toBe(401)
  })

  it("401s when signed with the wrong secret", async () => {
    const body = "{}"
    const sig = await computeWebhookSignature(body, "wrong-secret")
    const handler = webhookSignatureLayer({ secret: SECRET })(innerFetch)
    const res = await handler(post(body, { "X-Webhook-Signature": sig }))
    expect(res.status).toBe(401)
  })

  it("honors a custom header name", async () => {
    const body = "{}"
    const sig = await computeWebhookSignature(body, SECRET)
    const handler = webhookSignatureLayer({ secret: SECRET, header: "X-Custom-Sig" })(innerFetch)
    const res = await handler(post(body, { "X-Custom-Sig": sig }))
    expect(res.status).toBe(200)
  })

  it("supports a different HMAC algorithm", async () => {
    const body = "{}"
    const sig = await computeWebhookSignature(body, SECRET, "SHA-512")
    const handler = webhookSignatureLayer({ secret: SECRET, algorithm: "SHA-512" })(innerFetch)
    const res = await handler(post(body, { "X-Webhook-Signature": sig }))
    expect(res.status).toBe(200)
  })

  describe("timestamp binding", () => {
    it("401s when the timestamp header is required but missing", async () => {
      const handler = webhookSignatureLayer({
        secret: SECRET,
        timestampHeader: "X-Webhook-Timestamp",
      })(innerFetch)
      const sig = await computeWebhookSignature("{}", SECRET)
      const res = await handler(post("{}", { "X-Webhook-Signature": sig }))
      expect(res.status).toBe(401)
    })

    it("accepts a signature over '<timestamp>.<body>' within tolerance", async () => {
      const body = "{}"
      const ts = "1700000000"
      const sig = await computeWebhookSignature(`${ts}.${body}`, SECRET)
      const handler = webhookSignatureLayer({
        secret: SECRET,
        timestampHeader: "X-Webhook-Timestamp",
        now: () => 1700000000_000,
      })(innerFetch)
      const res = await handler(
        post(body, { "X-Webhook-Signature": sig, "X-Webhook-Timestamp": ts }),
      )
      expect(res.status).toBe(200)
    })

    it("401s when the timestamp is outside the tolerance window", async () => {
      const body = "{}"
      const ts = "1700000000"
      const sig = await computeWebhookSignature(`${ts}.${body}`, SECRET)
      const handler = webhookSignatureLayer({
        secret: SECRET,
        timestampHeader: "X-Webhook-Timestamp",
        toleranceSec: 60,
        now: () => 1700000000_000 + 120 * 1000, // 120s later, tolerance is 60s
      })(innerFetch)
      const res = await handler(
        post(body, { "X-Webhook-Signature": sig, "X-Webhook-Timestamp": ts }),
      )
      expect(res.status).toBe(401)
    })

    it("401s on a signature computed without the timestamp when timestampHeader is configured", async () => {
      const body = "{}"
      const ts = "1700000000"
      const sig = await computeWebhookSignature(body, SECRET) // missing the "<ts>." prefix
      const handler = webhookSignatureLayer({
        secret: SECRET,
        timestampHeader: "X-Webhook-Timestamp",
        now: () => 1700000000_000,
      })(innerFetch)
      const res = await handler(
        post(body, { "X-Webhook-Signature": sig, "X-Webhook-Timestamp": ts }),
      )
      expect(res.status).toBe(401)
    })
  })
})

// ============================================================================
// replayPreventionLayer
// ============================================================================

describe("replayPreventionLayer", () => {
  it("passes through requests with no delivery-id header", async () => {
    const handler = replayPreventionLayer()(innerFetch)
    const res = await handler(post("{}"))
    expect(res.status).toBe(200)
  })

  it("allows the first delivery of a given id", async () => {
    const handler = replayPreventionLayer()(innerFetch)
    const res = await handler(post("{}", { "X-Webhook-Delivery-ID": "evt_1" }))
    expect(res.status).toBe(200)
  })

  it("409s a duplicate delivery id", async () => {
    const handler = replayPreventionLayer()(innerFetch)
    const first = await handler(post("{}", { "X-Webhook-Delivery-ID": "evt_2" }))
    expect(first.status).toBe(200)
    const second = await handler(post("{}", { "X-Webhook-Delivery-ID": "evt_2" }))
    expect(second.status).toBe(409)
  })

  it("honors a custom header name", async () => {
    const handler = replayPreventionLayer({ header: "X-Delivery" })(innerFetch)
    const first = await handler(post("{}", { "X-Delivery": "evt_3" }))
    expect(first.status).toBe(200)
    const second = await handler(post("{}", { "X-Delivery": "evt_3" }))
    expect(second.status).toBe(409)
  })

  it("accepts a pluggable store", async () => {
    const seen = new Set<string>()
    const store: ReplayStore = {
      has: (id) => seen.has(id),
      add: (id) => {
        seen.add(id)
      },
    }
    const handler = replayPreventionLayer({ store })(innerFetch)
    await handler(post("{}", { "X-Webhook-Delivery-ID": "evt_4" }))
    expect(seen.has("evt_4")).toBe(true)
    const res = await handler(post("{}", { "X-Webhook-Delivery-ID": "evt_4" }))
    expect(res.status).toBe(409)
  })

  it("in-memory store entries expire after their TTL", async () => {
    const store = createInMemoryReplayStore()
    await store.add("evt_5", 10) // 10ms TTL
    expect(await store.has("evt_5")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await store.has("evt_5")).toBe(false)
  })

  it("layer allows re-delivery of an id once its TTL has expired", async () => {
    const handler = replayPreventionLayer({ ttlMs: 10 })(innerFetch)
    const first = await handler(post("{}", { "X-Webhook-Delivery-ID": "evt_6" }))
    expect(first.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const second = await handler(post("{}", { "X-Webhook-Delivery-ID": "evt_6" }))
    expect(second.status).toBe(200)
  })
})

// ============================================================================
// Composition — both layers together, plus the core router (payload
// validation is the normal input-schema path — see module doc)
// ============================================================================

describe("webhookSignatureLayer + replayPreventionLayer composed", () => {
  it("rejects a bad signature before replay tracking runs", async () => {
    const handler = webhookSignatureLayer({ secret: SECRET })(
      replayPreventionLayer()(innerFetch),
    )
    const res = await handler(post("{}", { "X-Webhook-Delivery-ID": "evt_7", "X-Webhook-Signature": "bad" }))
    expect(res.status).toBe(401)
  })

  it("valid signature + fresh delivery id passes through", async () => {
    const handler = webhookSignatureLayer({ secret: SECRET })(
      replayPreventionLayer()(innerFetch),
    )
    const body = "{}"
    const sig = await computeWebhookSignature(body, SECRET)
    const res = await handler(
      post(body, { "X-Webhook-Delivery-ID": "evt_8", "X-Webhook-Signature": sig }),
    )
    expect(res.status).toBe(200)
  })

  it("valid signature + duplicate delivery id → 409", async () => {
    const handler = webhookSignatureLayer({ secret: SECRET })(
      replayPreventionLayer()(innerFetch),
    )
    const body = "{}"
    const sig = await computeWebhookSignature(body, SECRET)
    await handler(post(body, { "X-Webhook-Delivery-ID": "evt_9", "X-Webhook-Signature": sig }))
    const res = await handler(
      post(body, { "X-Webhook-Delivery-ID": "evt_9", "X-Webhook-Signature": sig }),
    )
    expect(res.status).toBe(409)
  })
})
