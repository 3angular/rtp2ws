import WebSocket from 'ws';
import { STASIS_APP, TargetEntry } from './config.js';
import { ByteQueue, PortPool, RtpLeg, deinterleave, interleave } from './rtp.js';

const TICK_MS = 20;
const CAPTURE_QUEUE_MS = 1000; // per-stream stereo-align buffer cap
const INJECT_QUEUE_MS = 5000; // peer→call buffer cap (spec §7: bounded, drop excess)
const WS_BACKPRESSURE_BYTES = 1 << 20; // stop sending capture frames beyond this

// ARI hangup cause (ChannelDestroyed) → ARI hangup reason for the other leg.
const CAUSE_TO_REASON: Record<number, string> = { 1: 'unallocated', 17: 'busy', 19: 'no_answer', 21: 'rejected' };

interface Tap {
  rtp: RtpLeg;
  emChannel: any; // externalMedia channel
  snoopChannel?: any; // paired snoop, for per-party taps
  captureQ?: ByteQueue; // only for stereo capture legs
}

// One live call: caller leg, callee leg, media taps, and the target WebSocket.
// Every entry point is wrapped so a failure here can never escape to the
// process (spec §7 process-level isolation) — see guard().
export class CallSession {
  private outbound: any;
  private bridge: any;
  private snoopBridges: any[] = [];
  private taps: { caller?: Tap; callee?: Tap; bridge?: Tap } = {};
  private ws?: WebSocket;
  private wsOpened = false;
  private timer?: NodeJS.Timeout;
  private injectQ: ByteQueue;
  private injectDropsLogged = 0;
  private captureDrops = 0;
  private ended = false;
  private streaming = false;
  private answered = false;

  private readonly sampleRate: number;
  private readonly frameBytes: number; // one 20 ms mono frame in bytes

  constructor(
    private readonly ari: any,
    private readonly pool: PortPool,
    private readonly entry: TargetEntry,
    private readonly inbound: any,
    private readonly resolvedTarget: string,
    private readonly fromNumber: string | null,
  ) {
    this.sampleRate = entry.wideBandAudio ? 16000 : 8000;
    this.frameBytes = (this.sampleRate / 50) * 2;
    const wsFrameBytes = this.frameBytes * (entry.injectMono ? 1 : 2);
    this.injectQ = new ByteQueue((wsFrameBytes * INJECT_QUEUE_MS) / TICK_MS);
  }

  private log(msg: string): void {
    console.log(`[call ${this.inbound.id}] ${msg}`);
  }

  // Wraps async handlers so one call's failure is logged, not thrown.
  private guard(fn: () => Promise<void> | void): void {
    Promise.resolve()
      .then(fn)
      .catch((err) => this.log(`error: ${err?.message ?? err}`));
  }

  async start(): Promise<void> {
    this.log(`dialing ${this.resolvedTarget} via trunk (target ${this.entry.prefix})`);
    this.inbound.once('StasisEnd', () => this.guard(() => this.endCall('caller hung up')));
    await this.inbound.ring();

    this.bridge = this.ari.Bridge();
    await this.bridge.create({ type: 'mixing' });
    await this.bridge.addChannel({ channel: this.inbound.id });

    this.outbound = this.ari.Channel();
    this.outbound.once('StasisStart', () => this.guard(() => this.onAnswered()));
    this.outbound.once('ChannelDestroyed', (event: any) =>
      this.guard(() => {
        if (!this.answered) return this.rejectInbound(event.cause);
        return this.endCall('callee hung up');
      }),
    );
    this.outbound.once('StasisEnd', () => this.guard(() => this.endCall('callee left')));

    // No dial timeout (spec §3): the target rings until the caller gives up.
    await this.outbound.originate({
      endpoint: `PJSIP/${this.resolvedTarget}@trunk`,
      app: STASIS_APP,
      appArgs: 'dialed',
      callerId: this.fromNumber ?? undefined,
      timeout: -1,
    });
  }

  // Outbound leg never answered: fail the inbound call with the same cause.
  private async rejectInbound(cause: number): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.log(`target did not answer (cause ${cause})`);
    await this.destroyBridges();
    await this.inbound
      .hangup({ reason: CAUSE_TO_REASON[cause] ?? 'congestion' })
      .catch(() => this.inbound.hangup().catch(() => {}));
  }

  private async onAnswered(): Promise<void> {
    if (this.ended) return;
    this.answered = true;
    this.log('target answered');
    await this.inbound.answer();
    await this.bridge.addChannel({ channel: this.outbound.id });
    this.openWebSocket();
  }

  private openWebSocket(): void {
    const ws = new WebSocket(this.entry.url, {
      headers: this.entry.headers,
      rejectUnauthorized: !this.entry.dangerouslyIgnoreTlsVerificationErrors,
    });
    this.ws = ws;

    ws.on('open', () =>
      this.guard(async () => {
        if (this.ended) return ws.close(1000);
        this.wsOpened = true;
        this.log(`websocket open: ${this.entry.url}`);
        ws.send(
          JSON.stringify({
            callId: this.inbound.id,
            fromNumber: this.fromNumber,
            toNumber: this.resolvedTarget,
            startedAt: new Date().toISOString(),
            audio: {
              sampleRate: this.sampleRate,
              format: 's16le',
              captureChannels: this.entry.captureMono ? 1 : 2,
              injectChannels: this.entry.injectMono ? 1 : 2,
              monoWhisperTarget: this.entry.monoWhisperTarget,
            },
          }),
        );
        await this.provisionTaps();
      }),
    );

    ws.on('message', (data, isBinary) => {
      if (!isBinary || !this.streaming) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      if (!this.injectQ.push(buf) && this.injectQ.dropped >= this.injectDropsLogged + 100000) {
        this.injectDropsLogged = this.injectQ.dropped;
        this.log(`inject buffer full, dropped ${this.injectQ.dropped} bytes so far (peer faster than real time?)`);
      }
    });

    ws.on('error', (err) => this.log(`websocket error: ${err.message}`));

    ws.on('close', (code) =>
      this.guard(() => {
        if (this.ended) return;
        // WS failed to open at answer time → plain patched-through call (spec §7).
        if (!this.wsOpened) {
          this.log('websocket failed to open; call continues without streaming');
          return;
        }
        const clean = code !== 1006; // 1006 = abnormal closure (no close frame)
        this.log(`websocket closed (code ${code}, ${clean ? 'clean' : 'unexpected drop'})`);
        const policy = this.entry.endCallOnWsClose;
        if (policy === 'always' || (policy === 'clean' && clean)) return this.endCall('websocket closed');
        return this.stopStreaming();
      }),
    );
  }

  // ---- media taps (spec §6 topology matrix) ----

  private async provisionTaps(): Promise<void> {
    const { captureMono, injectMono, monoWhisperTarget } = this.entry;
    try {
      // Per-party snoop flags. A single snoop does spy and whisper at once,
      // sharing one bidirectional externalMedia leg.
      const spy = !captureMono;
      const callerWhisper = !injectMono || monoWhisperTarget === 'caller';
      const calleeWhisper = !injectMono || monoWhisperTarget === 'callee';
      const bridgeTap = captureMono || (injectMono && monoWhisperTarget === 'both');

      if (spy || callerWhisper) this.taps.caller = await this.snoopTap(this.inbound, spy, callerWhisper);
      if (spy || calleeWhisper) this.taps.callee = await this.snoopTap(this.outbound, spy, calleeWhisper);
      if (bridgeTap) this.taps.bridge = await this.bridgeTap();

      if (this.ended) return;
      this.wireCapture();
      this.streaming = true;
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.log('media taps provisioned, streaming');
    } catch (err: any) {
      this.log(`tap provisioning failed: ${err?.message ?? err}; call continues without streaming`);
      await this.stopStreaming();
    }
  }

  private emFormat(): string {
    return this.entry.wideBandAudio ? 'slin16' : 'slin';
  }

  private async newLeg(): Promise<RtpLeg> {
    const { socket, port } = await this.pool.bind();
    return new RtpLeg(socket, port, this.entry.wideBandAudio ? 118 : 11);
  }

  // Waits for a channel we created to actually enter the Stasis app before we
  // bridge it; the POST returns before StasisStart fires.
  private stasisStarted(channel: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`channel ${channel.id} never entered Stasis`)), 5000);
      channel.once('StasisStart', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private async externalMedia(rtp: RtpLeg): Promise<any> {
    const em = this.ari.Channel();
    const started = this.stasisStarted(em);
    await em.externalMedia({
      app: STASIS_APP,
      external_host: `127.0.0.1:${rtp.port}`,
      format: this.emFormat(),
    });
    await started;
    const address = await em.getChannelVar({ variable: 'UNICASTRTP_LOCAL_ADDRESS' }).catch(() => null);
    const port = await em.getChannelVar({ variable: 'UNICASTRTP_LOCAL_PORT' });
    rtp.dest = { address: address?.value || '127.0.0.1', port: Number(port.value) };
    return em;
  }

  // Snoop on one party bridged with its own externalMedia leg: spy captures
  // that party's own voice, whisper injects audio only that party hears.
  // ponytail: spy/whisper in-out orientation follows spec §6; the spec itself
  // flags it as needing verification against live Asterisk — flip here if reversed.
  private async snoopTap(party: any, spy: boolean, whisper: boolean): Promise<Tap> {
    const rtp = await this.newLeg();
    try {
      const snoop = this.ari.Channel();
      const started = this.stasisStarted(snoop);
      await this.ari.channels.snoopChannelWithId({
        channelId: party.id,
        snoopId: snoop.id,
        app: STASIS_APP,
        spy: spy ? 'in' : 'none',
        whisper: whisper ? 'out' : 'none',
      });
      await started;
      const em = await this.externalMedia(rtp);
      const bridge = this.ari.Bridge();
      await bridge.create({ type: 'mixing' });
      this.snoopBridges.push(bridge);
      await bridge.addChannel({ channel: [snoop.id, em.id] });
      return { rtp, emChannel: em, snoopChannel: snoop };
    } catch (err) {
      rtp.close();
      this.pool.release(rtp.port);
      throw err;
    }
  }

  // externalMedia directly on the main mixing bridge: captures the mono mix,
  // and anything we send is heard by both parties.
  private async bridgeTap(): Promise<Tap> {
    const rtp = await this.newLeg();
    try {
      const em = await this.externalMedia(rtp);
      await this.bridge.addChannel({ channel: em.id });
      return { rtp, emChannel: em };
    } catch (err) {
      rtp.close();
      this.pool.release(rtp.port);
      throw err;
    }
  }

  // ---- capture path (call → websocket) ----

  private wireCapture(): void {
    if (this.entry.captureMono) {
      // Mono mix: forward as it arrives (spec §5 pacing).
      this.taps.bridge!.rtp.onPayload = (p) => this.sendCapture(p);
    } else {
      // Stereo: two independent RTP streams, aligned by arrival order through
      // small per-stream queues; gaps are filled with silence in tick().
      for (const tap of [this.taps.caller!, this.taps.callee!]) {
        const q = new ByteQueue((this.frameBytes * CAPTURE_QUEUE_MS) / TICK_MS);
        tap.captureQ = q;
        tap.rtp.onPayload = (p) => q.push(p);
      }
    }
  }

  private sendCapture(frame: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > WS_BACKPRESSURE_BYTES) {
      if (++this.captureDrops % 500 === 1) this.log(`peer not keeping up, dropped ${this.captureDrops} capture frames`);
      return;
    }
    this.ws.send(frame);
  }

  // ---- 20 ms tick: stereo interleave out, paced injection in ----

  private tick(): void {
    try {
      if (!this.entry.captureMono) {
        const lq = this.taps.caller!.captureQ!;
        const rq = this.taps.callee!.captureQ!;
        if (lq.length >= this.frameBytes || rq.length >= this.frameBytes) {
          this.sendCapture(interleave(lq.pullPadded(this.frameBytes), rq.pullPadded(this.frameBytes)));
        }
      }

      const wsFrame = this.injectQ.pull(this.frameBytes * (this.entry.injectMono ? 1 : 2));
      if (!wsFrame) return;
      if (!this.entry.injectMono) {
        const [l, r] = deinterleave(wsFrame);
        this.taps.caller!.rtp.send(l);
        this.taps.callee!.rtp.send(r);
      } else if (this.entry.monoWhisperTarget === 'both') {
        this.taps.bridge!.rtp.send(wsFrame);
      } else {
        this.taps[this.entry.monoWhisperTarget]!.rtp.send(wsFrame);
      }
    } catch (err: any) {
      this.log(`tick error: ${err?.message ?? err}`);
    }
  }

  // ---- teardown (spec §7) ----

  // Stops streaming but leaves the call up (ws-close policy says continue,
  // or tap provisioning failed): remove taps, free ports, close the socket.
  private async stopStreaming(): Promise<void> {
    this.streaming = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closeWs();
    await this.releaseTaps();
  }

  // Full teardown: hang up both legs, remove taps, close bridge + websocket.
  private async endCall(why: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.streaming = false;
    this.log(`ending call: ${why}`);
    if (this.timer) clearInterval(this.timer);
    this.closeWs();
    await this.releaseTaps();
    await this.destroyBridges();
    await this.inbound.hangup().catch(() => {});
    await this.outbound?.hangup().catch(() => {});
    this.log('call ended');
  }

  private closeWs(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    ws.removeAllListeners();
    ws.on('error', () => {});
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close(1000);
  }

  private async releaseTaps(): Promise<void> {
    for (const key of ['caller', 'callee', 'bridge'] as const) {
      const tap = this.taps[key];
      if (!tap) continue;
      this.taps[key] = undefined;
      tap.rtp.close();
      this.pool.release(tap.rtp.port);
      await tap.emChannel.hangup().catch(() => {});
      await tap.snoopChannel?.hangup().catch(() => {});
    }
    for (const b of this.snoopBridges.splice(0)) await b.destroy().catch(() => {});
  }

  private async destroyBridges(): Promise<void> {
    await this.bridge?.destroy().catch(() => {});
    this.bridge = undefined;
  }
}
