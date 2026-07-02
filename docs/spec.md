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

![RTP2WS architecture: an incoming SIP call reaches Asterisk on the host network; Asterisk exposes ARI to the sidecar and streams externalMedia RTP over UDP to it; the sidecar bridges audio to the target WebSocket (wss://); Asterisk dials the target via the SIP trunk.](architecture.svg)

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
   `+`) and the caller ID (`From`), which may be withheld, anonymous, or absent.
2. **Prefix match.** The `To` number is matched against the configured `targets`
   keys by **longest matching prefix** (keys begin with `+`; see §4). If **no key
   matches**, the incoming call is rejected with SIP **404** (ARI hangup with an
   unallocated-number cause) and the flow ends.
3. **Resolve target number.** From the matched entry, drop the leading `+`, remove
   the first `stripDigits` digits, and prepend `+` (see §4).
4. **Dial the target.** Create an outbound leg `PJSIP/<resolvedTarget>@<trunk>`
   (always `+E.164`; the trunk must accept that format) and a **mixing bridge**; add
   the incoming (caller) channel to the bridge. The **caller's own caller ID is passed
   through** as the outbound CLI, so the carrier must permit presenting it. The caller
   hears normal ringback while the target rings. There is **no separate dial timeout**:
   the target rings until the caller gives up or the inbound INVITE transaction times
   out.
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
`entry.headers` on the handshake (e.g. `Authorization`). For `wss://` targets the
server certificate is verified by default; setting
`dangerouslyIgnoreTlsVerificationErrors: true` on the target disables that check
(insecure — testing only).

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
    "captureChannels": 1,
    "injectChannels": 1,
    "monoWhisperTarget": "callee"
  }
}
```

| Field                     | Meaning                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `callId`                  | Asterisk channel ID (unique ID) of the **incoming** call                              |
| `fromNumber`              | Caller ID as received from the trunk (usually E.164); `null` if withheld or anonymous |
| `toNumber`                | Resolved E.164 target the call was forwarded to (§4)                                  |
| `startedAt`               | UTC ISO-8601 timestamp of target answer (WebSocket open)                              |
| `audio.sampleRate`        | `8000` or `16000` (per `wideBandAudio`)                                               |
| `audio.format`            | Always `"s16le"`                                                                      |
| `audio.captureChannels`   | `2` = stereo (L=caller, R=callee), `1` = mono mix — what the peer **receives**        |
| `audio.injectChannels`    | `2` = stereo (L→caller, R→callee), `1` = mono — what the peer should **send**         |
| `audio.monoWhisperTarget` | Only meaningful when `injectChannels == 1`: `caller` \| `callee` \| `both`            |

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
> the targeted party hears it. Verified against the Asterisk 22 source
> (`res_stasis_snoop.c`): `spy: in` maps to the audiohook READ direction (frames
> coming *from* the party — their own voice) and `whisper: out` maps to WRITE
> (frames going *to* the party — what they hear), matching the intent. Confirm
> once with a live call on first deployment and flip in the sidecar if reversed.

### Stereo L/R timing alignment

In stereo capture, the caller and callee arrive as **two independent RTP streams**
with separate SSRCs and unrelated timestamp bases, so their timestamps cannot be
compared directly. Both are driven by Asterisk's shared 20 ms tick, so the sidecar
aligns them by **arrival / packet order** through a small per-stream jitter buffer
(target ~20–60 ms), tolerating a small fixed L/R skew. Late or lost packets are
filled with silence to keep the two channels sample-aligned.

### RTP port allocation

The sidecar binds UDP listening ports on **`127.0.0.1`** for its `externalMedia`
legs, from the configured pool `rtpPortStart … rtpPortEnd` — one port per
`externalMedia` leg, i.e. 1–3 ports per call depending on the topology row
(see the matrix above: 1 for the all-mono case, 2 for rows sharing snoop legs,
3 where a bridge tap coexists with two snoops). It passes
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

### Codecs

The trunk endpoint's baked codec allow-list is, in order, **`AMR-WB`**
(wideband, preferred) **and `alaw` (PCMA)** — the only two codecs the carrier
supports. Asterisk
transcodes whatever the call negotiates to **`slin`** (8 kHz) or **`slin16`**
(16 kHz) for the `externalMedia` taps, per each target's `wideBandAudio`.
`AMR-WB` is not part of the base Asterisk build; the `asterisk` image compiles
in the third-party codec module ([traud/asterisk-amr](https://github.com/traud/asterisk-amr)).

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

**Sidecar restart / redeploy:** the sidecar *is* the ARI Stasis application, so when
it disconnects (restart, crash, redeploy) Asterisk removes its Stasis-controlled
channels — **all active calls end**. There is no call hand-off across restarts;
redeploy during a maintenance window.

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
    captureMono: true              # true:  WS receives mono mix
                                   # false: WS receives stereo (L=caller, R=callee)
    injectMono: true               # true:  WS sends mono, routed by monoWhisperTarget
                                   # false: WS sends stereo (L→caller, R→callee)
    monoWhisperTarget: callee      # caller | callee | both (only if injectMono: true)
    wideBandAudio: false           # false: 8 kHz (slin); true: 16 kHz (slin16)
    endCallOnWsClose: clean        # never | always | clean  — end call when the WS
                                   # closes (see §7): clean=only on a clean close,
                                   # always=on any close, never=never
    dangerouslyIgnoreTlsVerificationErrors: false  # true = skip wss:// cert checks (insecure)
    headers:                       # optional extra WebSocket handshake headers
      Authorization: "Bearer ..."

  "+0024":                         # shorter fallback key for other +0024... numbers
    stripDigits: 6
    url: "wss://default.example.com/audio"
```

### Field reference

| Field                                                | Type   | Default  | Notes                                                                                                                              |
| ---------------------------------------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `publicIp`                                           | string | —        | Host's public address; Asterisk binds SIP + RTP here. Required.                                                                    |
| `trunk.host`                                         | string | —        | Carrier SIP server. Required.                                                                                                      |
| `trunk.port`                                         | int    | `5060`   |                                                                                                                                    |
| `trunk.username`                                     | string | —        | Trunk auth user.                                                                                                                   |
| `trunk.password`                                     | string | —        | Trunk auth secret.                                                                                                                 |
| `trunk.register`                                     | bool   | `true`   | REGISTER vs. static IP trunk.                                                                                                      |
| `trunk.transport`                                    | enum   | `udp`    | `udp` \| `tcp` \| `tls`.                                                                                                           |
| `rtpPortStart`                                       | int    | —        | First UDP port of the sidecar's externalMedia pool (bound on `127.0.0.1`).                                                         |
| `rtpPortEnd`                                         | int    | —        | Last UDP port (inclusive). Pool size bounds concurrency.                                                                           |
| `targets`                                            | map    | —        | Prefix key (E.164 with `+`) → target config.                                                                                       |
| `targets.<k>.stripDigits`                            | int    | —        | Digits dropped after the To number's leading `+` (dial code + the `00` standing in for `+`); the result is then prefixed with `+`. |
| `targets.<k>.url`                                    | string | —        | Target WebSocket URL (`ws://` or `wss://`).                                                                                        |
| `targets.<k>.captureMono`                            | bool   | `true`   | Mono mix vs. stereo capture (WS receives).                                                                                         |
| `targets.<k>.injectMono`                             | bool   | `true`   | Mono vs. stereo inject (WS sends).                                                                                                 |
| `targets.<k>.monoWhisperTarget`                      | enum   | `callee` | `caller` \| `callee` \| `both`; used only if `injectMono`.                                                                         |
| `targets.<k>.wideBandAudio`                          | bool   | `false`  | 16 kHz vs. 8 kHz PCM.                                                                                                              |
| `targets.<k>.endCallOnWsClose`                       | enum   | `clean`  | `never` \| `always` \| `clean`; end call on WebSocket close (§7).                                                                  |
| `targets.<k>.dangerouslyIgnoreTlsVerificationErrors` | bool   | `false`  | Skip `wss://` TLS certificate verification (insecure; testing only).                                                               |
| `targets.<k>.headers`                                | map    | `{}`     | Extra WebSocket handshake headers.                                                                                                 |

Internal, non-configurable settings baked into the images: ARI HTTP bind
(`127.0.0.1`) and credentials (localhost-only), Asterisk's own `rtp.conf` range, the
sidecar RTP bind address (`127.0.0.1`), and the Stasis app name.

> **Host-loopback trust:** under `network_mode: host`, `127.0.0.1` is the *host's*
> loopback, so ARI (`127.0.0.1:8088`, with its baked credentials) and the sidecar's
> RTP sockets are reachable by **any process on the host**, not only the paired
> container. The design assumes the host is trusted; nothing internal is exposed on
> the public interface.

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

A secondary, container-less deployment — Asterisk from Debian packages and the
sidecar as systemd services on a Debian 13 host, installed from a GitHub
release tarball — is described in [debian-install.md](debian-install.md).

## 10. Out of scope / deferred

- WebSocket reconnect / call-audio resumption after an unexpected drop.
- Multiple trunks or per-target trunks (single fixed trunk only).
- Number rewriting beyond a fixed `stripDigits` digit count (no regex/pattern
  transforms); outbound is always dialed as `+E.164`.
- Configurable dial/answer timeout or maximum call duration (dialing is bounded only
  by the inbound call).
- Raw PJSIP config escape hatch (`rawPjsipInclude`) — add if an exotic carrier option
  is needed.
- Recording, transcription, or any audio processing beyond interleaving/pacing.
- Authentication of *inbound* calls beyond trunk/IP trust.
