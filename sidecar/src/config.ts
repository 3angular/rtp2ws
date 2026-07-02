import fs from 'node:fs';
import YAML from 'yaml';

// Baked-in internals shared with the asterisk image (see asterisk/render-config.py).
// ARI binds 127.0.0.1 only; the host is trusted by design (spec §8).
export const ARI_URL = 'http://127.0.0.1:8088';
export const ARI_USER = 'rtp2ws';
export const ARI_PASS = 'rtp2ws-internal';
export const STASIS_APP = 'rtp2ws';

export type WhisperTarget = 'caller' | 'callee' | 'both';
export type WsClosePolicy = 'never' | 'always' | 'clean';

export interface TargetEntry {
  prefix: string; // the map key, e.g. "+00240049"
  stripDigits: number;
  url: string;
  captureMono: boolean;
  injectMono: boolean;
  monoWhisperTarget: WhisperTarget;
  wideBandAudio: boolean;
  endCallOnWsClose: WsClosePolicy;
  dangerouslyIgnoreTlsVerificationErrors: boolean;
  headers: Record<string, string>;
}

export interface Config {
  rtpPortStart: number;
  rtpPortEnd: number;
  targets: TargetEntry[];
}

function fail(msg: string): never {
  throw new Error(`config: ${msg}`);
}

function int(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) fail(`${name} must be an integer`);
  return v;
}

function bool(v: unknown, name: string, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  if (typeof v !== 'boolean') fail(`${name} must be a boolean`);
  return v;
}

function oneOf<T extends string>(v: unknown, name: string, values: T[], dflt: T): T {
  if (v === undefined) return dflt;
  if (typeof v !== 'string' || !values.includes(v as T)) fail(`${name} must be one of ${values.join(', ')}`);
  return v as T;
}

export function parseConfig(text: string): Config {
  const raw = YAML.parse(text);
  if (!raw || typeof raw !== 'object') fail('empty or invalid YAML');

  const rtpPortStart = int(raw.rtpPortStart, 'rtpPortStart');
  const rtpPortEnd = int(raw.rtpPortEnd, 'rtpPortEnd');
  if (rtpPortEnd < rtpPortStart) fail('rtpPortEnd must be >= rtpPortStart');

  if (!raw.targets || typeof raw.targets !== 'object' || Object.keys(raw.targets).length === 0) {
    fail('targets must be a non-empty map');
  }

  const targets: TargetEntry[] = Object.entries(raw.targets as Record<string, any>).map(([prefix, t]) => {
    const name = `targets["${prefix}"]`;
    if (!prefix.startsWith('+')) fail(`${name}: key must start with '+'`);
    if (!t || typeof t !== 'object') fail(`${name} must be a map`);
    if (typeof t.url !== 'string' || !/^wss?:\/\//.test(t.url)) fail(`${name}.url must be a ws:// or wss:// URL`);
    const stripDigits = int(t.stripDigits, `${name}.stripDigits`);
    if (stripDigits < 0) fail(`${name}.stripDigits must be >= 0`);
    const headers = t.headers ?? {};
    if (typeof headers !== 'object' || Array.isArray(headers)) fail(`${name}.headers must be a map`);
    return {
      prefix,
      stripDigits,
      url: t.url,
      captureMono: bool(t.captureMono, `${name}.captureMono`, true),
      injectMono: bool(t.injectMono, `${name}.injectMono`, true),
      monoWhisperTarget: oneOf(t.monoWhisperTarget, `${name}.monoWhisperTarget`, ['caller', 'callee', 'both'], 'callee'),
      wideBandAudio: bool(t.wideBandAudio, `${name}.wideBandAudio`, false),
      endCallOnWsClose: oneOf(t.endCallOnWsClose, `${name}.endCallOnWsClose`, ['never', 'always', 'clean'], 'clean'),
      dangerouslyIgnoreTlsVerificationErrors: bool(
        t.dangerouslyIgnoreTlsVerificationErrors,
        `${name}.dangerouslyIgnoreTlsVerificationErrors`,
        false,
      ),
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
    };
  });

  return { rtpPortStart, rtpPortEnd, targets };
}

export function loadConfig(path: string): Config {
  return parseConfig(fs.readFileSync(path, 'utf8'));
}
