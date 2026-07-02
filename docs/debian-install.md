# Native install on Debian 13

The primary deployment is Docker Compose ([spec §9](spec.md)). This document
describes the secondary mode: a native install on a clean **Debian 13
(trixie)** host, driven by GitHub releases and an `install.sh` script, with
Asterisk and the sidecar running as **systemd services**. Same architecture,
same single YAML config — only the packaging differs.

## How Asterisk is installed (and the AMR-WB question)

Debian 13 itself ships **no `asterisk` package** — it was dropped from stable
releases after bullseye. The Debian **sid** (unstable) repository, however,
carries the current **Asterisk LTS** packages (22.x at the time of writing),
and crucially its `asterisk-modules` package **includes the AMR codec
modules** — `codec_amr.so` and `res_format_attr_amr.so`, covering both AMR
and **AMR-WB**:

- Upstream Asterisk tarballs have *no* AMR support at all; that's why the
  Docker image ([asterisk/Dockerfile](../asterisk/Dockerfile)) compiles
  Asterisk from source with the [traud/asterisk-amr](https://github.com/traud/asterisk-amr)
  patches.
- Debian's packaging carries equivalent patches and links against
  `libopencore-amr` / `libvo-amrwbenc` from Debian main, so **no source build
  is needed** for the native install.

`install.sh` therefore adds sid as an additional apt source, **pinned low**
(priority 100) so the system stays on trixie, with only the Asterisk package
family pinned high (priority 990) to come from sid:

| File                                         | Effect                                                          |
| -------------------------------------------- | --------------------------------------------------------------- |
| `/etc/apt/sources.list.d/debian-sid.sources` | Adds the sid repository (deb822 format, Debian archive keyring) |
| `/etc/apt/preferences.d/90-sid`              | Pins **all** sid packages to priority 100 (never auto-upgrade)  |
| `/etc/apt/preferences.d/91-asterisk-sid`     | Pins `asterisk asterisk-* libasterisk* dahdi* libpri*` to 990   |

The sidecar runs on Debian's own `nodejs` package (20.x — sufficient: the
compiled output targets ES2022 and all runtime dependencies are pure JS), so
no third-party Node repository is needed either.

## Releases

Pushing a semver tag (`vX.Y.Z`) triggers the
[release workflow](../.github/workflows/release.yml), which builds and tests
the sidecar and attaches one artifact to a GitHub release:

```
rtp2ws-vX.Y.Z.tar.gz
└── rtp2ws-vX.Y.Z/
    ├── install.sh                     # the installer
    ├── rtp2ws.example.yaml            # config template
    ├── sidecar/
    │   ├── dist/src/                  # compiled TypeScript
    │   ├── node_modules/              # production dependencies (pure JS)
    │   └── package.json
    ├── asterisk/render-config.py      # YAML → /etc/asterisk renderer
    └── systemd/
        ├── rtp2ws-sidecar.service     # sidecar unit
        └── asterisk-override.conf     # drop-in for Debian's asterisk.service
```

To cut a release:

```sh
git tag v1.2.3
git push origin v1.2.3
```

## Installing

On a clean Debian 13 host, as root:

```sh
tar xzf rtp2ws-vX.Y.Z.tar.gz
cd rtp2ws-vX.Y.Z
./install.sh
```

Then configure and start:

```sh
vi /etc/rtp2ws/rtp2ws.yaml            # publicIp, trunk, targets — see comments
systemctl restart asterisk rtp2ws-sidecar
```

`install.sh` is idempotent — re-run it from a newer release tarball to
**upgrade** (it replaces `/opt/rtp2ws`, never touches an existing
`/etc/rtp2ws/rtp2ws.yaml`, and restarts both services).

## What install.sh does

1. Adds the pinned sid apt source (table above) and installs `asterisk`,
   `asterisk-modules`, the AMR runtime libraries, `nodejs`, and
   `python3-yaml`.
2. Configures Asterisk to run as the `asterisk` user
   (`/etc/default/asterisk`).
3. Copies the pre-built sidecar to `/opt/rtp2ws/sidecar` and the config
   renderer to `/opt/rtp2ws/render-config.py`; creates the unprivileged
   `rtp2ws` system user the sidecar runs as.
4. Seeds `/etc/rtp2ws/rtp2ws.yaml` from the example (mode `0640`,
   group `rtp2ws`) — only if it doesn't exist yet.
5. Installs the systemd units and enables both services. On a fresh install
   it stops there and tells you to edit the config; on an upgrade it restarts
   both services.

## Runtime layout

| Path                                                 | What                                                     |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `/etc/rtp2ws/rtp2ws.yaml`                            | The single config for both services (spec §8)            |
| `/opt/rtp2ws/sidecar/`                               | Compiled sidecar + production `node_modules`             |
| `/opt/rtp2ws/render-config.py`                       | Renders `/etc/asterisk/*` from the YAML                  |
| `/etc/systemd/system/rtp2ws-sidecar.service`         | Sidecar unit (`User=rtp2ws`, `Restart=always`)           |
| `/etc/systemd/system/asterisk.service.d/rtp2ws.conf` | Drop-in: render config via `ExecStartPre` on every start |

The drop-in mirrors the container entrypoint: every `systemctl restart
asterisk` re-renders `pjsip.conf`, `ari.conf`, `http.conf`, `rtp.conf`, and
`extensions.conf` from the YAML, then tightens permissions on the two
credential-bearing files (`pjsip.conf`, `ari.conf` → `0640 root:asterisk`).
The sidecar unit points `RTP2WS_CONFIG` at the same YAML; ordering after
`asterisk.service` is best-effort only, since the sidecar retries the ARI
connection until Asterisk is up.

## Operations

```sh
systemctl status asterisk rtp2ws-sidecar     # health
journalctl -u rtp2ws-sidecar -f              # sidecar logs
journalctl -u asterisk -f                    # Asterisk logs
asterisk -rx 'core show translation' | grep -i amr   # verify AMR-WB is loaded
```

Config changes: edit `/etc/rtp2ws/rtp2ws.yaml`, then
`systemctl restart asterisk rtp2ws-sidecar`. Sidecar-only fields (`targets`,
`rtpPortStart/End`) strictly need only the sidecar restarted, but restarting
both is always safe — in-flight calls are dropped either way.

Uninstall:

```sh
systemctl disable --now rtp2ws-sidecar asterisk
rm -rf /opt/rtp2ws /etc/rtp2ws \
  /etc/systemd/system/rtp2ws-sidecar.service \
  /etc/systemd/system/asterisk.service.d/rtp2ws.conf
systemctl daemon-reload
apt-get purge asterisk asterisk-modules asterisk-config asterisk-core-sounds-en
rm /etc/apt/sources.list.d/debian-sid.sources \
  /etc/apt/preferences.d/90-sid /etc/apt/preferences.d/91-asterisk-sid
```
