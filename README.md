# RTP2WS

A VoIP appliance that accepts an incoming SIP call, patches it through to its
intended target via a fixed SIP trunk, and mirrors the live call audio to a
per-target WebSocket (stereo or mono, with audio injection back into the call).
Built on Asterisk + ARI with a Node.js/TypeScript sidecar, packaged as two
host-networked containers and configured through a single mounted YAML file.

## Running

```sh
cp rtp2ws.example.yaml rtp2ws.yaml   # then edit: publicIp, trunk, targets
docker compose up --build -d
```

Layout: `asterisk/` (Asterisk 20 image; renders its config from the mounted
YAML at startup), `sidecar/` (TypeScript ARI app + RTP↔WebSocket
bridge; `npm test` runs its unit tests), `docker-compose.yaml` (both containers
on host networking).

## Documentation

- [Specification](docs/spec.md) — architecture, call flow, number routing, media
  topology, configuration, and deployment.
- [WebSocket Integration Guide](docs/websocket-integration.md)
  ([Deutsch](docs/websocket-integration.de.md)) — the protocol for the WebSocket
  recipient: metadata, PCM audio format, and lifecycle.
