import Ari, { type Channel, type Client, type StasisStart } from 'ari-client';
import { ARI_PASS, ARI_URL, ARI_USER, STASIS_APP, loadConfig } from './config.js';
import { CallSession } from './call.js';
import { PortPool } from './rtp.js';
import { matchTarget, resolveTarget } from './routing.js';

const CONFIG_PATH = process.env.RTP2WS_CONFIG ?? '/config/rtp2ws.yaml';

// Last line of defense (spec §7): log and keep serving other calls.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig(CONFIG_PATH);
  const pool = new PortPool(cfg.rtpPortStart, cfg.rtpPortEnd);

  // Asterisk may still be booting (compose starts it first, but readiness
  // isn't guaranteed) — retry until ARI is reachable.
  let ari: Client;
  for (;;) {
    try {
      ari = await Ari.connect(ARI_URL, ARI_USER, ARI_PASS);
      break;
    } catch (err: any) {
      console.log(`ARI not reachable (${err?.message ?? err}), retrying in 2s`);
      await sleep(2000);
    }
  }
  console.log('connected to ARI');

  // ari-client reconnects on its own; if it gives up, exit and let Docker
  // restart us into the retry loop above. Active calls are dead either way
  // once the Stasis app is gone (spec §7).
  ari.on('WebSocketMaxRetries', () => {
    console.error('ARI connection lost for good, exiting for restart');
    process.exit(1);
  });

  ari.on('StasisStart', (event: StasisStart, channel: Channel) => {
    try {
      // Channels we created ourselves: originated legs are marked with
      // appArgs, snoop/externalMedia channels by their names.
      if (event.args?.[0] === 'dialed') return;
      if (channel.name.startsWith('UnicastRTP/') || channel.name.startsWith('Snoop/')) return;

      const to = channel.dialplan?.exten ?? '';
      const callerNum = channel.caller?.number ?? '';
      const fromNumber = callerNum && callerNum.toLowerCase() !== 'anonymous' ? callerNum : null;
      console.log(`[call ${channel.id}] incoming: from=${fromNumber ?? 'withheld'} to=${to}`);

      const entry = matchTarget(to, cfg.targets);
      const target = entry && resolveTarget(to, entry);
      if (!entry || !target) {
        console.log(`[call ${channel.id}] no target for ${to}, rejecting with 404`);
        channel.hangup({ reason: 'unallocated' }).catch(() => channel.hangup().catch(() => {}));
        return;
      }

      new CallSession(ari, pool, entry, channel, target, fromNumber, cfg.trunk).start().catch((err: any) => {
        console.error(`[call ${channel.id}] failed to start:`, err?.message ?? err);
        channel.hangup().catch(() => {});
      });
    } catch (err) {
      console.error('StasisStart handler error:', err);
      channel.hangup().catch(() => {});
    }
  });

  await ari.start(STASIS_APP);
  console.log(`stasis app '${STASIS_APP}' running, ${cfg.targets.length} target(s) configured`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
