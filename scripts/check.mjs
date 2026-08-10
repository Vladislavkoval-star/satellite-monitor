/**
 * Availability tier.
 *
 * Checks DNS (through several resolvers), HTTP via a queue-free probe path per
 * host, and TLS expiry. Alerts to Telegram on the FIRST failing run — blips are
 * absorbed by immediate retries inside the run, not by waiting for the next
 * tick. One alert per incident: while a host stays down nothing further is
 * sent, and a single recovery message closes it out.
 *
 * The one exception to "alert on the first run" is a transport storm: when a
 * large share of the fleet fails at the same instant on connect errors alone,
 * the likeliest cause is this runner's egress rather than every site at once, so
 * the run is recorded and the judgement deferred one tick. See lib/storm.mjs.
 */
import { fileURLToPath } from 'node:url';
import { CONFIG, PATHS, loadTargets } from './lib/config.mjs';
import { probeAll } from './lib/probe.mjs';
import {
  emptyHostState,
  hoursSince,
  humaniseDuration,
  loadState,
  saveState,
} from './lib/state.mjs';
import { assessTransportStorm } from './lib/storm.mjs';
import {
  formatDownAlert,
  formatRecoveryAlert,
  formatSslAlert,
  sendTelegram,
} from './lib/notify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Turn a set of probe results into alert decisions, mutating host state.
 *
 * Pure apart from that mutation — no network, no IO, and `now` is injected — so
 * scripts/storm.test.mjs can drive it with synthetic runs.
 *
 * @param {object} args
 * @param {Array<object>} args.results        probe results for this run
 * @param {object} args.state                 availability state (mutated)
 * @param {Set<string>} args.renderAlreadyDown hosts the render tier already reported
 * @param {{suppress: boolean, hosts: string[]}} args.storm storm assessment
 * @param {string} args.now                   ISO timestamp for this run
 * @param {object} [args.config]
 */
export function reconcile({ results, state, renderAlreadyDown, storm, now, config = CONFIG }) {
  if (!state.hosts) state.hosts = {};

  const suppressedHosts = new Set(storm.suppress ? storm.hosts : []);
  const pendingDown = [];
  const recovered = [];
  const sslWarnings = [];
  const suppressed = [];

  for (const result of results) {
    const host = state.hosts[result.host] ?? emptyHostState();

    if (result.ok) {
      if (host.down && config.notifyOnRecovery) {
        recovered.push({ host: result.host, downFor: humaniseDuration(host.downSince) });
      }
      host.fails = 0;
      host.down = false;
      host.downSince = null;
      host.lastAlertAt = null;
      host.lastReason = null;
      host.lastFailureKind = null;
    } else if (suppressedHosts.has(result.host)) {
      // Storm: the observation is real, the conclusion is not trustworthy yet.
      // Record what was seen and leave fails/down untouched, so the host is
      // neither alerted now nor able to send a bogus recovery message next tick
      // (which is what produced the "лежал 25 мин" pair on 2026-08-08).
      host.lastReason = result.reason;
      host.lastFailureKind = result.failureKind ?? null;
      suppressed.push(result);
    } else {
      host.fails += 1;
      host.lastReason = result.reason;
      host.lastFailureKind = result.failureKind ?? null;
      if (!host.down && host.fails >= config.failuresBeforeAlert) {
        if (renderAlreadyDown.has(result.host)) {
          // Same incident, already reported by the other tier.
          host.down = true;
          host.downSince = now;
          host.lastAlertAt = now;
          host.dedupedWithRender = true;
        } else {
          pendingDown.push(result);
        }
      }
    }

    const ssl = result.ssl;
    if (ssl?.ok && typeof ssl.daysLeft === 'number' && ssl.daysLeft <= config.sslWarnDays) {
      if (hoursSince(host.lastSslAlertAt) >= 24) {
        host.lastSslAlertAt = now;
        sslWarnings.push({ host: result.host, daysLeft: ssl.daysLeft, validTo: ssl.validTo });
      }
    }

    state.hosts[result.host] = host;
  }

  return { pendingDown, recovered, sslWarnings, suppressed };
}

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
  const now = new Date().toISOString();

  const storm = assessTransportStorm(results, {
    minHosts: CONFIG.transportStormMinHosts,
    ratio: CONFIG.transportStormRatio,
    maxConsecutiveRuns: CONFIG.transportStormMaxConsecutiveRuns,
    previous: state.transportStorm,
  });

  const { pendingDown, recovered, sslWarnings, suppressed } = reconcile({
    results,
    state,
    renderAlreadyDown,
    storm,
    now,
  });

  // Persisted so the audit trail shows a suppressed run as a deliberate decision
  // rather than as a gap where nothing happened, and so the next run knows how
  // many storming ticks came before it.
  state.transportStorm = {
    consecutive: storm.consecutive,
    lastRunAt: now,
    hosts: storm.storm ? storm.hosts : [],
    suppressed: storm.suppress,
    escalated: storm.escalated,
  };

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
    `checked ${results.length} hosts · ok ${okCount} · new failures ${pendingDown.length}` +
      `${suppressed.length ? ` · suppressed ${suppressed.length}` : ''}`
  );
  for (const r of results) {
    const flag = r.ok ? 'OK  ' : 'FAIL';
    const extra = r.ok ? `${r.status} ${r.ms}ms` : `${r.reason} [${r.failureKind}]`;
    console.log(`  ${flag} ${r.host.padEnd(48)} ${extra}${r.warn ? ` [warn: ${r.warn}]` : ''}`);
    if (r.singleResolverMiss) {
      console.log(`       note: ${r.singleResolverMiss} не находит домен — вероятно его блоклист, не наш DNS`);
    }
  }
  if (storm.storm) {
    console.log(`\n${storm.suppress ? 'STORM SUPPRESSED' : 'STORM ESCALATED'}: ${storm.summary}`);
    console.log(`  hosts: ${storm.hosts.join(', ')}`);
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

// Only sweep when executed directly. Importing this file (tests) must not fire
// a live probe run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[check] fatal: ${err.message}`);
    process.exit(1);
  });
}
