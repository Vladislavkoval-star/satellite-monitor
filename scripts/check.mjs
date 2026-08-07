/**
 * Availability tier.
 *
 * Checks DNS (through several resolvers), HTTP via a queue-free probe path per
 * host, and TLS expiry. Alerts to Telegram on the FIRST failing run — blips are
 * absorbed by immediate retries inside the run, not by waiting for the next
 * tick. One alert per incident: while a host stays down nothing further is
 * sent, and a single recovery message closes it out.
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
  if (!state.hosts) state.hosts = {};

  // The render tier may already have alerted on a host this cycle. Reading its
  // state makes deduplication work in both directions — without this, a host
  // that fails render first and HTTP second produces two messages for one
  // incident.
  const renderState = await loadState(PATHS.renderState);
  const renderAlreadyDown = new Set(
    Object.entries(renderState.hosts ?? {})
      .filter(([, host]) => host.down)
      .map(([name]) => name)
  );

  const results = await probeAll(targets);

  const pendingDown = [];
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
      if (!host.down && host.fails >= CONFIG.failuresBeforeAlert) {
        if (renderAlreadyDown.has(result.host)) {
          // Same incident, already reported by the other tier.
          console.log(`  dedup ${result.host}: рендер уже сообщил об этом инциденте`);
          host.down = true;
          host.downSince = new Date().toISOString();
          host.lastAlertAt = new Date().toISOString();
        } else {
          pendingDown.push(result);
        }
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

  // Hosts that have left targets.json must not keep a stale `down: true`, or
  // they would be permanently muted if they are ever monitored again.
  const monitored = new Set(targets.map((t) => t.host));
  for (const name of Object.keys(state.hosts)) {
    if (!monitored.has(name)) {
      delete state.hosts[name];
      console.log(`  prune ${name}: больше не в списке целей, состояние удалено`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(
    `checked ${results.length} hosts · ok ${okCount} · new failures ${pendingDown.length}`
  );
  for (const r of results) {
    const flag = r.ok ? 'OK  ' : 'FAIL';
    const extra = r.ok ? `${r.status} ${r.ms}ms` : r.reason;
    console.log(`  ${flag} ${r.host.padEnd(48)} ${extra}${r.warn ? ` [warn: ${r.warn}]` : ''}`);
    if (r.singleResolverMiss) {
      console.log(`       note: ${r.singleResolverMiss} не находит домен — вероятно его блоклист, не наш DNS`);
    }
  }

  if (DRY_RUN) {
    const preview = [];
    if (pendingDown.length) preview.push(formatDownAlert(pendingDown));
    if (recovered.length) preview.push(formatRecoveryAlert(recovered));
    if (sslWarnings.length) preview.push(formatSslAlert(sslWarnings));
    console.log(preview.length ? `\n--- would send ---\n${preview.join('\n\n')}` : '\nno alerts');
    for (const r of pendingDown) markDown(state, r.host);
  } else {
    // A host is only recorded as "reported" once Telegram has actually accepted
    // the message. Marking it first would mean a single 429 silently swallows
    // the incident forever, because nothing re-alerts a host already down.
    if (pendingDown.length > 0) {
      const delivered = await sendTelegram(formatDownAlert(pendingDown));
      if (delivered) {
        for (const r of pendingDown) markDown(state, r.host);
      } else {
        console.error('[check] alert not delivered — состояние не помечено, повторим в следующем прогоне');
      }
    }
    if (recovered.length > 0) await sendTelegram(formatRecoveryAlert(recovered));
    if (sslWarnings.length > 0) await sendTelegram(formatSslAlert(sslWarnings));
  }

  await saveState(PATHS.state, state);

  // A failing host is a monitoring signal, not a workflow failure — exit 0 so
  // the schedule stays green and the next tick still fires.
  process.exit(0);
}

function markDown(state, hostname) {
  const host = state.hosts[hostname] ?? emptyHostState();
  const now = new Date().toISOString();
  host.down = true;
  host.downSince = host.downSince ?? now;
  host.lastAlertAt = now;
  state.hosts[hostname] = host;
}

main().catch((err) => {
  console.error(`[check] fatal: ${err.message}`);
  process.exit(1);
});
