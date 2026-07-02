import dgram from 'node:dgram';

// UDP port pool for externalMedia legs, bound on 127.0.0.1 (spec §6).
export class PortPool {
  private free: number[] = [];

  constructor(start: number, end: number) {
    for (let p = start; p <= end; p++) this.free.push(p);
  }

  // Binds a socket on the next free loopback port; skips ports that are in use.
  async bind(): Promise<{ socket: dgram.Socket; port: number }> {
    while (this.free.length > 0) {
      const port = this.free.shift()!;
      try {
        const socket = dgram.createSocket('udp4');
        await new Promise<void>((resolve, reject) => {
          socket.once('error', reject);
          socket.bind(port, '127.0.0.1', () => {
            socket.removeAllListeners('error');
            resolve();
          });
        });
        return { socket, port };
      } catch {
        // in use by someone else on loopback — burn it and try the next
      }
    }
    throw new Error('RTP port pool exhausted');
  }

  release(port: number): void {
    this.free.push(port);
  }
}

// RTP fixed header (RFC 3550 §5.1), 12 bytes:
//   byte 0: V(2 bits) P(1) X(1) CC(4)   byte 1: M(1) PT(7)
//   bytes 2-3: sequence number          bytes 4-7: timestamp
//   bytes 8-11: SSRC, then CC × 32-bit CSRCs and an optional extension.
const RTP_VERSION = 2;
const RTP_HEADER_BYTES = 12;
const VERSION_SHIFT = 6; // version is the top 2 bits of byte 0
const PADDING_FLAG = 0x20;
const EXTENSION_FLAG = 0x10;
const CSRC_COUNT_MASK = 0x0f;
const PAYLOAD_TYPE_MASK = 0x7f; // byte 1; the top (marker) bit is ignored
const CSRC_BYTES = 4;
const EXTENSION_HEADER_BYTES = 4; // profile id + length, before the extension words

export interface RtpPacket {
  pt: number;
  payload: Buffer;
}

export function parseRtp(buf: Buffer): RtpPacket | null {
  if (buf.length < RTP_HEADER_BYTES || buf[0] >> VERSION_SHIFT !== RTP_VERSION) return null;
  let off = RTP_HEADER_BYTES + (buf[0] & CSRC_COUNT_MASK) * CSRC_BYTES;
  if (buf[0] & EXTENSION_FLAG) {
    if (buf.length < off + EXTENSION_HEADER_BYTES) return null;
    off += EXTENSION_HEADER_BYTES + buf.readUInt16BE(off + 2) * 4;
  }
  const pad = buf[0] & PADDING_FLAG ? buf[buf.length - 1] : 0;
  if (buf.length < off + pad) return null;
  return { pt: buf[1] & PAYLOAD_TYPE_MASK, payload: buf.subarray(off, buf.length - pad) };
}

// One externalMedia RTP leg: receives captured RTP from Asterisk on a loopback
// socket and sends injected RTP back to the port Asterisk reported.
export class RtpLeg {
  dest?: { address: string; port: number };
  onPayload?: (payload: Buffer) => void;

  // Asterisk's static payload map: 11 = slin@8k (L16 mono), 118 = slin16.
  // We echo whatever PT Asterisk actually sends; the default only matters for
  // inject-only legs that may never receive a packet.
  private pt: number;
  private seq = Math.floor(Math.random() * 0x10000);
  private ts = Math.floor(Math.random() * 0x100000000);
  private readonly ssrc = Math.floor(Math.random() * 0x100000000);

  constructor(
    readonly socket: dgram.Socket,
    readonly port: number,
    defaultPt: number,
  ) {
    this.pt = defaultPt;
    socket.on('message', (msg) => {
      const pkt = parseRtp(msg);
      if (!pkt || pkt.payload.length === 0) return;
      this.pt = pkt.pt;
      this.onPayload?.(pkt.payload);
    });
  }

  // Sends one PCM frame; samples = payload.length / 2 (s16 mono).
  send(payload: Buffer): void {
    if (!this.dest) return;
    const buf = Buffer.alloc(RTP_HEADER_BYTES + payload.length);
    buf[0] = RTP_VERSION << VERSION_SHIFT; // no padding/extension/CSRCs
    buf[1] = this.pt; // marker bit unset
    buf.writeUInt16BE(this.seq, 2); // sequence number
    buf.writeUInt32BE(this.ts, 4); // timestamp
    buf.writeUInt32BE(this.ssrc, 8); // SSRC
    payload.copy(buf, RTP_HEADER_BYTES);
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + payload.length / 2) >>> 0;
    this.socket.send(buf, this.dest.port, this.dest.address);
  }

  close(): void {
    this.socket.removeAllListeners('message');
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

// Bounded FIFO of raw PCM bytes. push() drops when full (backpressure, spec §7).
export class ByteQueue {
  private chunks: Buffer[] = [];
  length = 0;
  dropped = 0;

  constructor(private readonly max: number) {}

  push(b: Buffer): boolean {
    if (this.length + b.length > this.max) {
      this.dropped += b.length;
      return false;
    }
    this.chunks.push(b);
    this.length += b.length;
    return true;
  }

  // Exactly n bytes, or null if fewer are buffered.
  pull(n: number): Buffer | null {
    if (this.length < n) return null;
    const out = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - got);
      head.copy(out, got, 0, take);
      got += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.length -= n;
    return out;
  }

  // Whatever is buffered (up to n), silence-padded to exactly n bytes.
  pullPadded(n: number): Buffer {
    const avail = Math.min(this.length, n) & ~1; // whole s16 samples only
    const got = avail > 0 ? this.pull(avail)! : Buffer.alloc(0);
    return got.length === n ? got : Buffer.concat([got, Buffer.alloc(n - got.length)]);
  }
}

// L/R sample interleaving for stereo WebSocket frames (s16le).
export function interleave(l: Buffer, r: Buffer): Buffer {
  const out = Buffer.alloc(l.length + r.length);
  for (let i = 0; i * 2 < l.length; i++) {
    out[i * 4] = l[i * 2];
    out[i * 4 + 1] = l[i * 2 + 1];
    out[i * 4 + 2] = r[i * 2];
    out[i * 4 + 3] = r[i * 2 + 1];
  }
  return out;
}

export function deinterleave(s: Buffer): [Buffer, Buffer] {
  const half = s.length >> 1;
  const l = Buffer.alloc(half);
  const r = Buffer.alloc(half);
  for (let i = 0; i * 4 < s.length; i++) {
    l[i * 2] = s[i * 4];
    l[i * 2 + 1] = s[i * 4 + 1];
    r[i * 2] = s[i * 4 + 2];
    r[i * 2 + 1] = s[i * 4 + 3];
  }
  return [l, r];
}
