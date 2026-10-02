# Native Gateway transport

[中文](README.md)

This package carries native `Request`, `Response`, and mux text over one authenticated outbound node WebSocket. The caller owns node and Runtime routing, authentication, heartbeat, and reconnect. Each `GatewayTunnel` uses only its supplied connection; requests are never retried on disconnect.

The server uses `new GatewayTunnel(ws)`, `fetch(request)`, `openMux(sendToBrowser, signal?)`, and `close()`. `openMux` returns `send(text)` and `close()`. The node uses `serveSurface(ws, surface)`, where `surface` implements `handle(request)` and `openMux(send, signal)`; node muxes return `receive(text)` and `close()`. `serveSurface` returns a handle with `close()` and `health`. `GatewayTunnel.health` reports connection state, request count, and mux count; `isOpen` reports connection state.

The transport does not interpret URL paths, query parameters, or mux text. HTTP methods, status, response headers, and binary bodies pass through native Web APIs; HEAD and bodyless statuses do not create body streams. Request cancellation cancels the node request and streams; cancelling a response body also releases the request.

## Bounds

- Protocol version is 1. JSON control frames carry version, channel identifier, and operation; binary body frames contain a 1-byte version, a 4-byte big-endian channel identifier, and at most 32768 body bytes.
- Each body direction permits at most 32768 unconsumed bytes. Receivers grant byte credit when reading; senders wait for credit before reading their source streams. Individual chunks produced by the source itself are not allocated or limited by this package.
- Defaults permit 128 combined request and mux channels, control frames up to 262144 bytes, and an 8 MiB WebSocket write buffer. Exceeded bounds or invalid protocol fail and release resources. Configure both WebSocket endpoints with `maxPayload: 262144` to bound memory during frame assembly; disabling compression is recommended.
- `requestTimeoutMs` defaults to 120000 and covers the entire request and response stream; callers can configure a larger finite value for long streams. Mux lifetime is governed by its signal, explicit close, or connection loss.
- `GatewayTransportError.code` is `DISCONNECTED`, `TIMEOUT`, `PROTOCOL`, `REMOTE`, or `CAPACITY`; `status` is 504 for timeouts and 502 for other transport errors. Browser cancellation preserves its abort reason. Errors after response headers are returned propagate through the body stream.

Real local WebSocket tests cover large binary uploads and downloads, backpressure, two-node and multi-mux isolation, cancellation, disconnects, timeouts, bodyless responses, and protocol error cleanup.
