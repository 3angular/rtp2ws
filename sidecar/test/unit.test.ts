import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { matchTarget, resolveTarget } from '../src/routing.js';
import { ByteQueue, deinterleave, interleave, parseRtp } from '../src/rtp.js';

const YAML = `
publicIp: 203.0.113.10
trunk: { host: sip.example.com }
rtpPortStart: 20000
rtpPortEnd: 20100
targets:
  "+00240049":
    stripDigits: 6
    url: "wss://example.com/audio"
    captureMono: false
    endCallOnWsClose: always
  "+0024":
    stripDigits: 6
    url: "wss://default.example.com/audio"
`;

test('config parsing and defaults', () => {
  const cfg = parseConfig(YAML);
  assert.equal(cfg.rtpPortStart, 20000);
  const [a, b] = cfg.targets;
  assert.equal(a.prefix, '+00240049');
  assert.equal(a.captureMono, false); // explicit
  assert.equal(a.injectMono, true); // default
  assert.equal(a.monoWhisperTarget, 'callee'); // default
  assert.equal(a.wideBandAudio, false); // default
  assert.equal(a.endCallOnWsClose, 'always'); // explicit
  assert.equal(b.endCallOnWsClose, 'clean'); // default
  assert.deepEqual(cfg.trunk, { hosts: ['sip.example.com'], port: 5060 }); // string host, default port
  const two = parseConfig(YAML.replace('{ host: sip.example.com }', '{ host: [sbc1.example.com, sbc2.example.com], port: 5070 }'));
  assert.deepEqual(two.trunk, { hosts: ['sbc1.example.com', 'sbc2.example.com'], port: 5070 }); // redundant hosts
  assert.throws(() => parseConfig(YAML.replace('{ host: sip.example.com }', '{ host: [] }'))); // empty host list
  assert.throws(() => parseConfig('rtpPortStart: 1\nrtpPortEnd: 2\ntargets: {}'));
  assert.throws(() => parseConfig(YAML.replace('wss://example.com/audio', 'http://nope')));
});

test('longest-prefix routing (spec §4 example)', () => {
  const cfg = parseConfig(YAML);
  const entry = matchTarget('+00240049151234567', cfg.targets);
  assert.equal(entry?.prefix, '+00240049'); // longest key wins
  assert.equal(resolveTarget('+00240049151234567', entry!), '+49151234567');
  assert.equal(matchTarget('+00241111', cfg.targets)?.prefix, '+0024'); // fallback key
  assert.equal(matchTarget('+4930123', cfg.targets), undefined); // no match → 404
  assert.equal(resolveTarget('+0024', cfg.targets[1]), null); // nothing left after strip
});

test('stereo interleave/deinterleave roundtrip', () => {
  const l = Buffer.from([1, 2, 3, 4]); // 2 samples
  const r = Buffer.from([5, 6, 7, 8]);
  const s = interleave(l, r);
  assert.deepEqual([...s], [1, 2, 5, 6, 3, 4, 7, 8]); // L0 R0 L1 R1
  assert.deepEqual(deinterleave(s), [l, r]);
});

test('rtp parse', () => {
  const pkt = Buffer.alloc(16);
  pkt[0] = 0x80;
  pkt[1] = 118;
  pkt.writeUInt32BE(0xdeadbeef, 12);
  const parsed = parseRtp(pkt)!;
  assert.equal(parsed.pt, 118);
  assert.deepEqual([...parsed.payload], [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(parseRtp(Buffer.alloc(4)), null); // too short
  assert.equal(parseRtp(Buffer.alloc(16)), null); // wrong version
});

test('byte queue bounds and padding', () => {
  const q = new ByteQueue(8);
  assert.ok(q.push(Buffer.from([1, 2, 3, 4, 5, 6])));
  assert.ok(!q.push(Buffer.alloc(4))); // would exceed cap → dropped
  assert.equal(q.dropped, 4);
  assert.deepEqual([...q.pull(4)!], [1, 2, 3, 4]);
  assert.equal(q.pull(4), null); // only 2 left
  assert.deepEqual([...q.pullPadded(4)], [5, 6, 0, 0]); // silence-padded
});
