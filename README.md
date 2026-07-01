# RTP2WS

A VoIP appliance that accepts an incoming SIP call, patches it through to its
intended target via a fixed SIP trunk, and mirrors the live call audio to a
per-target WebSocket (stereo or mono, with audio injection back into the call).
Built on Asterisk + ARI with a Node.js/TypeScript sidecar, packaged as two
host-networked containers and configured through a single mounted YAML file.

## Documentation

- [Specification](docs/spec.md) — architecture, call flow, number routing, media
  topology, configuration, and deployment.
- [WebSocket Integration Guide](docs/websocket-integration.md)
  ([Deutsch](docs/websocket-integration.de.md)) — the protocol for the WebSocket
  recipient: metadata, PCM audio format, and lifecycle.
