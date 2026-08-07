/**
 * Availability tier. Runs hourly.
 *
 * Checks DNS, HTTP (via a Queue-it-free probe path per host) and TLS expiry.
 * Alerts to Telegram on the FIRST failing run — blips are absorbed by immediate
 * retries inside the run, not by waiting for the next tick. One alert per
 * incident: while a host stays down nothing further is sent, and a single
 * recovery message closes it out.
 */
import { CONFIG, PATHS, loadTargets } from './lib/config.mjs';
import { probeAll } from './lib/probe.mjs';
import {
  emptyHostState,
  hoursSince,
  humaniseDuration,
  loadState,
  saveState,
} from './lib/state.mjs';
import {
  formatDownAlert,
  formatRecoveryAlert,
  formatSslAlert,
  sendTelegram,
} from './lib/notify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const targets = await loadTargets();
  const state = await loadState(PATHS.state);
  const results = await probeAll(targets);

  const newlyDown = [];
  const recovered = [];
  const sslWarnings = [];

  for (const result of results) {
    const host = state.hosts[result.host] ?? emptyHostState();

    if (result.ok) {
      if (host.down && CONFIG.notifyOnRecovery) {
        recovered.push({ host: result.host, downFor: humaniseDuration(host.downSince) });
      }
      host.fails = 0;
      host.down = false;
      host.downSince = null;
      host.lastAlertAt = null;
    } else {
      host.fails += 1;
      // Fire once, on the transition into "down". Staying down sends nothing
      // more, which is what keeps the channel free of duplicates.
      if (!host.down && host.fails >= CONFIG.failuresBeforeAlert) {
        host.down = true;
        host.downSince = new Date().toISOString();
        host.lastAlertAt = new Date().toISOString();
        newlyDown.push(result);
      }
    }

    const ssl = result.ssl;
    if (ssl?.ok && typeof ssl.daysLeft === 'number' && ssl.daysLeft <= CONFIG.sslWarnDays) {
      if (hoursSince(host.lastSslAlertAt) >= 24) {
        host.lastSslAlertAt = new Date().toISOString();
        sslWarnings.push({ host: result.host, daysLeft: ssl.daysLeft, validTo: ssl.validTo });
      }
    }

    state.hosts[result.host] = host;
  }

  const okCount = results.filter((r) => r.ok).length;
  const stillDown = results.filter((r) => !r.ok).length - newlyDown.length;
  console.log(
    `checked ${results.length} hosts · ok ${okCount} · new failures ${newlyDown.length} · already known down ${Math.max(0, stillDown)}`
  );
  for (const r of results) {
    const flag = r.ok ? 'OK  ' : 'FAIL';
    const extra = r.ok ? `${r.status} ${r.ms}ms` : r.reason;
    console.log(`  ${flag} ${r.host.padEnd(48)} ${extra}${r.warn ? ` [warn: ${r.warn}]` : ''}`);
  }

  const messages = [];
  if (newlyDown.length > 0) messages.push(formatDownAlert(newlyDown));
  if (recovered.length > 0) messages.push(formatRecoveryAlert(recovered));
  if (sslWarnings.length > 0) messages.push(formatSslAlert(sslWarnings));

  if (DRY_RUN) {
    console.log(messages.length ? `\n--- would send ---\n${messages.join('\n\n')}` : '\nno alerts');
  } else {
    for (const message of messages) await sendTelegram(message);
  }

  await saveState(PATHS.state, state);

  // A failing host is a monitoring signal, not a workflow failure — exit 0 so
  // the schedule stays green and the next tick still fires.
  process.exit(0);
}

main().catch((err) => {
  console.error(`[check] fatal: ${err.message}`);
  process.exit(1);
});
