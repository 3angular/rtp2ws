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

Alternatively, deploy natively on a clean Debian 13 host from a GitHub release
(pushed semver tags build one automatically): extract the release tarball and
run `install.sh` — Asterisk from Debian packages plus the sidecar, both as
systemd services. See [docs/debian-install.md](docs/debian-install.md).

Layout: `asterisk/` (Asterisk 22 image; renders its config from the mounted
YAML at startup), `sidecar/` (TypeScript ARI app + RTP↔WebSocket
bridge; `npm test` runs its unit tests), `docker-compose.yaml` (both containers
on host networking).

## Documentation

- [Specification](docs/spec.md) — architecture, call flow, number routing, media
  topology, configuration, and deployment.
- [WebSocket Integration Guide](docs/websocket-integration.md)
  ([Deutsch](docs/websocket-integration.de.md)) — the protocol for the WebSocket
  recipient: metadata, PCM audio format, and lifecycle.

## License

This repository's original source code, configuration templates, scripts, and
documentation are licensed under the [Apache License 2.0](LICENSE).

Release artifacts and container images may include third-party components under
their own licenses, including Asterisk under GPLv2. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for distribution notes.
