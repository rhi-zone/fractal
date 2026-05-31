# @rhi-zone/fractal-preset-websocket

> **CONVENIENCE SUGAR ONLY — NOT THE ONLY OR BLESSED WAY**
>
> This preset is a thin saved `compose`/closure over the fractal kernel assemblers.
> You can drop to raw `compose`/`attach` at any time to swap the codec or protocol.
> No magic, no lock-in.
>
> **Verbatim equivalents** (copy-paste and adjust as needed):
>
> ```ts
> // CLIENT — use a different codec/protocol by changing the args:
> clientOver(node, compose(wsClientChannel(url), jsonCodec, correlation))
>
> // SERVER — same pattern:
> wsServeBun((ch) => attach(tree, ch, jsonCodec, correlation, opts), opts)
> ```

## API

### `wsClient(node, url, opts?)`

Build a typed client over a WebSocket connection. Equivalent to:

```ts
clientOver(node, compose(wsClientChannel(url, opts), jsonCodec, correlation))
```

### `serveWs(tree, opts?)`

Start a Bun-native WebSocket server serving `tree` over JSON + correlation. Equivalent to:

```ts
wsServeBun((ch) => attach(tree, ch, jsonCodec, correlation, opts), opts)
```

`opts` accepts both `ServeWsOptions` (`port`, `hostname`) and `DispatcherOptions` (`grants`).
