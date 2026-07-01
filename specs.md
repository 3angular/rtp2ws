# RTP2WS — Specification

## 1. Overview

RTP2WS is a VoIP appliance. It accepts an incoming SIP call, forwards
it to the call's intended target through a fixed SIP trunk, and — once the target
answers — mirrors the live call audio to a per-target **WebSocket** endpoint. The
WebSocket peer receives call metadata followed by an uncompressed PCM audio stream,
and may send PCM audio back, which is injected into the live call.

Audio can be mirrored as **stereo** (left = caller, right = callee) or as a **mono
mix**, and injected audio can likewise be **stereo** (left → caller, right → callee)
or **mono** (routed to caller, callee, or both). All of this is configured per
target.

The appliance runs via Docker Compose as **two containers** on the host network
(`network_mode: host`), configured entirely through a single mounted YAML file.

## 2. Architecture

Two containers, one process each, both on `network_mode: host`:

1. **`asterisk`** — handles SIP/PJSIP signalling, RTP media, codec transcoding, and
   exposes **ARI** (Asterisk REST Interface) on `127.0.0.1`. Its entrypoint renders
   `pjsip.conf` / `ari.conf` / `rtp.conf` / dialplan from the mounted YAML at startup.
   SIP and its own RTP bind to the configured **`publicIp`**.
2. **`sidecar`** — a Node.js / TypeScript program that is both:
   - the **ARI Stasis application** orchestrating the call flow, and
   - the **RTP ↔ WebSocket bridge** moving PCM audio between Asterisk and the
     target WebSocket. Its RTP sockets bind to **`127.0.0.1`** (never exposed).

Both containers share the host's network namespace, so the sidecar reaches ARI on
`127.0.0.1`, and Asterisk streams `externalMedia` **RTP over UDP** to `127.0.0.1`.
Because Asterisk binds `publicIp` while the sidecar binds `127.0.0.1`, their RTP port
ranges may freely overlap (§6). Service-name DNS is unavailable under host
networking — communication is by loopback address, not container name.

```
   PSTN/SIP          ┌────────────── host network — network_mode: host ───────────────┐
   caller ──SIP──────┤  Asterisk ── ARI (REST+WS, 127.0.0.1) ──► Sidecar (Node/TS)    │
          ◄──audio───┤    │  ▲                                     │  ▲               │
                     │    │  │  RTP (externalMedia, UDP)           │  │               │
   target ──SIP──────┤    ▼  │                                     ▼  │               │
   (via trunk)◄─audio┤  media taps                         target WebSocket (wss://)  │
                     └────────────────────────────────────────────────────────────────┘
```

**Why TypeScript:** the workload is I/O-bound (shuffling PCM buffers between UDP and
a WebSocket, plus light L/R interleaving) — Asterisk does all heavy media work.
Node's ARI ecosystem is the most mature (`ari-client` was Asterisk's reference
library) and is more than fast enough for this load.

**Lifecycle:** Docker Compose owns each container's lifecycle, restarts, and log
separation — there is no in-image supervisor. `depends_on` starts `asterisk` first,
and the sidecar **retries the ARI connection on startup** (and on ARI drop) rather
than assuming it is up.

## 3. Call flow

1. **Incoming call → Stasis.** The dialplan hands every inbound call to the sidecar's
   Stasis application. The sidecar reads the call's `To` number (E.164 with leading
   `+`) and the caller ID (`From`).
2. **Prefix match.** The `To` number is matched against the configured `targets`
   keys by **longest matching prefix** (keys begin with `+`; see §4). If **no key
   matches**, the incoming call is rejected with SIP **404** (ARI hangup with an
   unallocated-number cause) and the flow ends.
3. **Resolve target number.** From the matched entry, strip its `stripDigits` from
   the `To` number, then convert the remaining leading `00` to `+` (see §4).
4. **Dial the target.** Create an outbound leg `PJSIP/<resolvedTarget>@<trunk>` and a
   **mixing bridge**; add the incoming (caller) channel to the bridge. The caller
   hears normal ringback while the target rings.
5. **On answer (200 OK).** When the outbound (callee) leg is answered and joins the
   bridge, the caller↔callee call is live. The sidecar then:
   - opens the target **WebSocket** (URL + optional `headers` from the entry),
   - sends the **metadata** text frame (§5),
   - provisions the media taps (§6) and begins streaming PCM.
6. **Streaming.** Captured audio flows call → sidecar → WebSocket; injected audio
   flows WebSocket → sidecar → call, per the capture/inject configuration (§6).
7. **Teardown** (§7): a clean WebSocket close ends the call; either party hanging up
   tears down all channels and closes the WebSocket; an unexpected WebSocket drop
   leaves the call up.

If the target never answers (busy, no-answer, rejected), the WebSocket is **never**
opened and the call simply fails as a normal SIP call — no special handling.

## 4. Number routing

Incoming `To` numbers have the shape `+<dial-code><intended-target>`, where the dial
code is a non-existent routing prefix and the intended target is an E.164 number
written with a `00` prefix instead of `+`.

**Example:** `+00240049151234567`
- `stripDigits` = `6` (the `0024` dial code **plus** the `00` that stands in for `+`)
- after dropping `+` and the first 6 digits → `49151234567`
- resolved E.164 target (prepend `+`) = `+49151234567`

### Algorithm

Given incoming `To` number `N` (starts with `+`):

1. **Longest-prefix match.** Find the `targets` key `K` that is a prefix of `N` and
   is the longest such key. Keys are compared as literal strings including the
   leading `+`. Ties are impossible (a key is either a prefix or not; the longest
   wins).
   - Prefix keys may include part of the intended target, e.g. both `+0024` and
     `+00240049` are valid keys; `+00240049…` matches the longer one.
2. **No match → reject** the call with SIP `404`.
3. **Resolve target.** Let `entry` be the matched key's config. Drop the leading `+`
   from `N`, remove the first `entry.stripDigits` digits, and prepend `+`. This is the
   `resolvedTarget`. (`stripDigits` covers both the dial code and the `00` that stands
   in for `+`.)
4. **Dial** `PJSIP/<resolvedTarget>@<trunk>`.

> Note: matching is a straight string longest-prefix scan over the configured keys.
> A trie is an optimization, not a requirement, at expected key counts.

## 5. WebSocket protocol

The sidecar is a WebSocket **client**, connecting to `entry.url` with any configured
`entry.headers` on the handshake (e.g. `Authorization`).

### Framing

- **First frame (text):** a JSON metadata object (below), sent immediately after the
  connection opens.
- **All subsequent frames (binary):** raw PCM audio, **16-bit signed
  little-endian** (`s16le`), at 8 kHz or 16 kHz per `wideBandAudio`. Stereo is
  standard interleaving: `L₀ R₀ L₁ R₁ …`.
- **Peer → sidecar (binary):** raw PCM in the same format the peer is told to send
  via metadata (`injectChannels`). The peer sends no metadata frame.

Metadata vs. audio is distinguished purely by **text vs. binary** frame type; no
custom in-band header is used.

### Metadata object

```json
{
  "callId": "1720000000.42",
  "fromNumber": "+49301234567",
  "toNumber": "+49151234567",
  "startedAt": "2026-07-01T12:00:00.000Z",
  "audio": {
    "sampleRate": 8000,
    "format": "s16le",
    "captureChannels": 2,
    "injectChannels": 2,
    "monoWhisperTarget": "callee"
  }
}
```

| Field                     | Meaning                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `callId`                  | Asterisk channel ID (unique ID) of the **incoming** call                       |
| `fromNumber`              | Caller ID (E.164)                                                              |
| `toNumber`                | Resolved E.164 target the call was forwarded to (§4)                           |
| `startedAt`               | UTC ISO-8601 timestamp of target answer (WebSocket open)                       |
| `audio.sampleRate`        | `8000` or `16000` (per `wideBandAudio`)                                        |
| `audio.format`            | Always `"s16le"`                                                               |
| `audio.captureChannels`   | `2` = stereo (L=caller, R=callee), `1` = mono mix — what the peer **receives** |
| `audio.injectChannels`    | `2` = stereo (L→caller, R→callee), `1` = mono — what the peer should **send**  |
| `audio.monoWhisperTarget` | Only meaningful when `injectChannels == 1`: `caller` \| `callee` \| `both`     |

### Audio pacing

Asterisk delivers RTP in ~20 ms packets (160 samples @ 8 kHz = 320 bytes/channel;
320 samples @ 16 kHz = 640 bytes/channel). The sidecar forwards captured audio to
the WebSocket as it arrives. On the return path the sidecar buffers peer audio and
paces it out to Asterisk in 20 ms RTP packets; the peer SHOULD send audio at
roughly real-time rate. Excess buffering is bounded (see §7).

## 6. Media topology (capture & injection)

All taps use ARI `externalMedia` channels (RTP/UDP, format `slin` @ 8 kHz or
`slin16` @ 16 kHz), optionally combined with ARI `Snoop` channels for per-party
separation. `externalMedia` channels are bidirectional (`direction: both`): Asterisk
sends captured RTP to the sidecar's listening UDP port and receives injected RTP
from the sidecar.

The sidecar provisions the **minimal** set of taps for the entry's
`captureMono` / `injectMono` / `monoWhisperTarget` combination:

### Per-party tap (Snoop + externalMedia)

For a given party (caller or callee), a `Snoop` channel on that party's channel,
bridged with its own `externalMedia` channel:

- **Capture that party's own voice:** `spy: in` (audio the party sends).
- **Inject so only that party hears it:** `whisper: out` (audio written to the
  party's channel).

A single snoop can do both `spy: in` **and** `whisper: out` simultaneously, sharing
one bidirectional `externalMedia` leg.

### Bridge-level tap (externalMedia on the main mixing bridge)

An `externalMedia` channel added directly to the caller↔callee mixing bridge:

- **Captures the mono mix** of both parties (a bridge member receives everyone
  else's audio).
- **Injects to both parties** (audio it sends into the bridge is heard by all).

### Topology matrix

| `captureMono` | `injectMono` | `monoWhisperTarget` | Channels provisioned                                                                                                                                                                       |
| :-----------: | :----------: | :-----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|    `false`    |   `false`    |          —          | caller snoop (`spy:in`+`whisper:out`) + callee snoop (`spy:in`+`whisper:out`), one `externalMedia` each. Sidecar interleaves capture to L/R and de-interleaves inject L→caller / R→callee. |
|    `false`    |    `true`    |        `both`       | 2 snoops for **stereo capture** (`spy:in`) + 1 bridge-level `externalMedia` for **mono inject to both**.                                                                                   |
|    `false`    |    `true`    |  `caller`/`callee`  | 2 snoops for stereo capture; the named party's snoop also does `whisper:out` for mono inject.                                                                                              |
|     `true`    |   `false`    |          —          | 1 bridge-level `externalMedia` for **mono-mix capture** + 2 snoops (`whisper:out`) for **stereo inject** L→caller / R→callee.                                                              |
|     `true`    |    `true`    |        `both`       | **1** bidirectional bridge-level `externalMedia` (mono-mix capture **and** inject-to-both) — simplest case.                                                                                |
|     `true`    |    `true`    |  `caller`/`callee`  | 1 bridge-level `externalMedia` for mono capture + 1 named-party snoop (`whisper:out`) for mono inject.                                                                                     |

> **Snoop direction caveat:** Asterisk's `spy`/`whisper` in/out conventions are easy
> to invert. The intent above is: capture each party's *own* voice; inject so *only*
> the targeted party hears it. The exact `in`/`out` values MUST be verified against
> live Asterisk behavior during implementation and corrected if reversed.

### Stereo L/R timing alignment

In stereo capture, the caller and callee arrive as **two independent RTP streams**.
Asterisk does not synchronize them. The sidecar maintains a small per-stream jitter
buffer (target ~20–60 ms) and aligns the two streams by RTP timestamp before
interleaving, so left and right stay coherent. Late/lost packets are filled with
silence to preserve alignment.

### RTP port allocation

The sidecar binds UDP listening ports on **`127.0.0.1`** for its `externalMedia`
legs, from the configured pool `rtpPortStart … rtpPortEnd` (one port per
`externalMedia` leg: 1 for mono-only topologies, 2 for stereo). It passes
`external_host = 127.0.0.1:<port>` to Asterisk. Asterisk sends captured RTP there;
the sidecar sends injected RTP back to the local RTP port Asterisk reports for each
`externalMedia` channel (via the channel's `UNICASTRTP_LOCAL_ADDRESS` /
`UNICASTRTP_LOCAL_PORT` variables).

Binding on `127.0.0.1` keeps these raw-PCM media sockets off the public interface.
Because the sidecar binds `127.0.0.1` and Asterisk binds `publicIp` (its own RTP
range from `rtp.conf`), the two RTP port ranges are on **different addresses and may
freely overlap** — no disjointness is required. The sidecar's pool must only be free
on `127.0.0.1`. Pool size bounds the number of concurrent calls
(≈ `(rtpPortEnd − rtpPortStart) / channelsPerCall`).

## 7. Lifecycle & error handling

**WebSocket-close policy (`endCallOnWsClose`, per target):** governs what happens
when a **successfully opened** WebSocket closes. Two kinds of close are
distinguished — a **clean** close (a proper WebSocket closing handshake initiated by
the peer) and an **unexpected drop** (network failure, peer crash, TCP reset — not a
clean close).

| `endCallOnWsClose`  | Clean close      | Unexpected drop  |
| ------------------- | ---------------- | ---------------- |
| `clean` *(default)* | **End the call** | Call continues   |
| `always`            | **End the call** | **End the call** |
| `never`             | Call continues   | Call continues   |

When a close does **not** end the call, streaming and injection simply stop; there is
**no reconnect**, and the caller↔callee conversation continues normally. The audio
tap can never kill a live conversation unless the policy explicitly says so.

**Call/WebSocket lifecycle:**

- **WebSocket close** → apply the `endCallOnWsClose` policy above. Ending the call
  means: hang up both legs, remove taps, close the bridge.
- **Either party hangs up** → tear down all channels (caller, callee, snoops,
  externalMedia), close the bridge, and close the WebSocket. (Independent of
  `endCallOnWsClose`.)
- **WebSocket fails to open** at answer time → the call continues as a normal
  patched-through call with no streaming. (`endCallOnWsClose` applies only to a
  socket that opened successfully, so a failed open never ends the call.)

**Process-level isolation (single Node process):** every per-call handler — ARI
events, RTP sockets, WebSocket callbacks — MUST be wrapped so that a thrown error or
a failed WebSocket on one call cannot crash the process or affect other calls. A
process-wide `uncaughtException` / `unhandledRejection` guard is the last line of
defense, logging and continuing rather than exiting.

**Backpressure:** the outbound (peer → call) buffer is bounded; if the peer sends
audio far faster than real time, excess is dropped (with a log) rather than growing
unbounded. Captured audio to the peer relies on WebSocket backpressure; if the peer
cannot keep up, frames are dropped rather than buffered without limit.

**Resource cleanup:** on any teardown path, all provisioned ARI channels and bound
UDP ports are released. Ports return to the pool for reuse.

## 8. Configuration

A single YAML file, mounted into **both** containers (path fixed by the images, e.g.
`/config/rtp2ws.yaml`); each entrypoint reads the parts it needs.

```yaml
# --- Public bind address for Asterisk SIP + RTP (ARI stays on 127.0.0.1) ---
publicIp: 203.0.113.10             # the host's public interface address

# --- SIP trunk (rendered into Asterisk pjsip.conf at startup) ---
trunk:
  host: sip.mycarrier.example      # carrier SIP server (host or IP)
  port: 5060
  username: "12345"
  password: "secret"
  register: true                   # REGISTER to carrier; false = static/IP-based trunk
  transport: udp                   # udp | tcp | tls

# --- Sidecar RTP listening pool (bound to 127.0.0.1; may overlap Asterisk's range) ---
rtpPortStart: 20000
rtpPortEnd: 20100

# --- Prefix → WebSocket target map ---
# Keys are matched against the incoming To number (leading '+' included);
# longest matching key wins. No match → SIP 404.
targets:
  "+00240049":
    stripDigits: 6                 # digits dropped after the '+' (dial code + the 00
                                   # that stands in for '+'); then prepend '+'.
                                   # +00240049151… - 6 digits → 49151… → +49151…
    url: "wss://example.com/audio" # target WebSocket
    captureMono: false             # false: WS receives stereo (L=caller, R=callee)
                                   # true:  WS receives mono mix
    injectMono: false              # false: WS sends stereo (L→caller, R→callee)
                                   # true:  WS sends mono, routed by monoWhisperTarget
    monoWhisperTarget: callee      # caller | callee | both (only if injectMono: true)
    wideBandAudio: false           # false: 8 kHz (slin); true: 16 kHz (slin16)
    endCallOnWsClose: clean        # never | always | clean  — end call when the WS
                                   # closes (see §7): clean=only on a clean close,
                                   # always=on any close, never=never
    headers:                       # optional extra WebSocket handshake headers
      Authorization: "Bearer ..."

  "+0024":                         # shorter fallback key for other +0024... numbers
    stripDigits: 6
    url: "wss://default.example.com/audio"
```

### Field reference

| Field                           | Type   | Default  | Notes                                                                                                                              |
| ------------------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `publicIp`                      | string | —        | Host's public address; Asterisk binds SIP + RTP here. Required.                                                                    |
| `trunk.host`                    | string | —        | Carrier SIP server. Required.                                                                                                      |
| `trunk.port`                    | int    | `5060`   |                                                                                                                                    |
| `trunk.username`                | string | —        | Trunk auth user.                                                                                                                   |
| `trunk.password`                | string | —        | Trunk auth secret.                                                                                                                 |
| `trunk.register`                | bool   | `true`   | REGISTER vs. static IP trunk.                                                                                                      |
| `trunk.transport`               | enum   | `udp`    | `udp` \| `tcp` \| `tls`.                                                                                                           |
| `rtpPortStart`                  | int    | —        | First UDP port of the sidecar's externalMedia pool (bound on `127.0.0.1`).                                                         |
| `rtpPortEnd`                    | int    | —        | Last UDP port (inclusive). Pool size bounds concurrency.                                                                           |
| `targets`                       | map    | —        | Prefix key (E.164 with `+`) → target config.                                                                                       |
| `targets.<k>.stripDigits`       | int    | —        | Digits dropped after the To number's leading `+` (dial code + the `00` standing in for `+`); the result is then prefixed with `+`. |
| `targets.<k>.url`               | string | —        | Target WebSocket URL (`ws://` or `wss://`).                                                                                        |
| `targets.<k>.captureMono`       | bool   | `false`  | Mono mix vs. stereo capture (WS receives).                                                                                         |
| `targets.<k>.injectMono`        | bool   | `false`  | Mono vs. stereo inject (WS sends).                                                                                                 |
| `targets.<k>.monoWhisperTarget` | enum   | `callee` | `caller` \| `callee` \| `both`; used only if `injectMono`.                                                                         |
| `targets.<k>.wideBandAudio`     | bool   | `false`  | 16 kHz vs. 8 kHz PCM.                                                                                                              |
| `targets.<k>.endCallOnWsClose`  | enum   | `clean`  | `never` \| `always` \| `clean`; end call on WebSocket close (§7).                                                                  |
| `targets.<k>.headers`           | map    | `{}`     | Extra WebSocket handshake headers.                                                                                                 |

Internal, non-configurable settings baked into the images: ARI HTTP bind
(`127.0.0.1`) and credentials (localhost-only), Asterisk's own `rtp.conf` range, the
sidecar RTP bind address (`127.0.0.1`), and the Stasis app name.

## 9. Deployment

**Two images:**

- **`asterisk`** — Asterisk plus an entrypoint that renders `pjsip.conf` (trunk),
  `ari.conf`/`http.conf` (ARI on `127.0.0.1`), `rtp.conf`, transport/RTP binds
  (`publicIp`), and the dialplan routing inbound calls into the Stasis app — all from
  the mounted YAML — then execs Asterisk in the foreground.
- **`sidecar`** — the Node.js runtime + compiled TypeScript. Reads the same YAML,
  connects to ARI on `127.0.0.1` (retrying until reachable), and runs the
  RTP↔WebSocket bridge.

**Compose** (both on host networking, same config mounted into each, restart policy):

```yaml
services:
  asterisk:
    image: rtp2ws-asterisk:latest
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./rtp2ws.yaml:/config/rtp2ws.yaml:ro
  sidecar:
    image: rtp2ws-sidecar:latest
    network_mode: host
    restart: unless-stopped
    depends_on: [ asterisk ]
    volumes:
      - ./rtp2ws.yaml:/config/rtp2ws.yaml:ro
```

`network_mode: host` is required so Asterisk owns the host's SIP and RTP ports
directly (no NAT for RTP) and the two containers can talk over `127.0.0.1`. Asterisk
binds SIP + RTP to `publicIp`; the sidecar's `rtpPortStart…rtpPortEnd` pool binds
`127.0.0.1`. The SIP port and Asterisk's RTP range must be free on the host's public
address; the sidecar pool must be free on loopback (it may numerically overlap
Asterisk's range — different bind addresses). Deployment remains one
`docker compose up`.

## 10. Out of scope / deferred

- WebSocket reconnect / call-audio resumption after an unexpected drop.
- Multiple trunks or per-target trunks (single fixed trunk only).
- Per-target `stripDigits` variations beyond a literal prefix strip.
- Raw PJSIP config escape hatch (`rawPjsipInclude`) — add if an exotic carrier option
  is needed.
- Recording, transcription, or any audio processing beyond interleaving/pacing.
- Authentication of *inbound* calls beyond trunk/IP trust.
