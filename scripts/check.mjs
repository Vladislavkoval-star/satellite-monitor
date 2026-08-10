/**
 * Availability tier.
 *
 * Checks DNS (through several resolvers), HTTP via a queue-free probe path per
 * host, and TLS expiry. Alerts to Telegram on the FIRST failing run — blips are
 * absorbed by immediate retries inside the run, not by waiting for the next
 * tick. One alert per incident: while a host stays down nothing further is
 * sent, and a single recovery message closes it out.
 *
 * The one exception to "alert on the first run" is a blind runner. Control
 * endpoints are polled throughout the run; if not one of them answered, this
 * runner had no working network and its connect timeouts say nothing about the
 * fleet. Those verdicts are deferred one tick and a МОНИТОРИНГ ОСЛЕП notice is
 * sent instead. While the control endpoints do answer, nothing is suppressed —
 * one host or all twenty, the alert goes out on the first failing run. See
 * lib/control.mjs.
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
import { SUPPRESSIBLE_KINDS, assessBlindness, startControlSampler } from './lib/control.mjs';
import {
  formatBlindAlert,
  formatDownAlert,
  formatRecoveryAlert,
  formatSightRestoredAlert,
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
 * @param {{blind: boolean}} args.vision      connectivity assessment for this run
 * @param {string} args.now                   ISO timestamp for this run
 * @param {object} [args.config]
 */
export function reconcile({ results, state, renderAlreadyDown, vision, now, config = CONFIG }) {
  if (!state.hosts) state.hosts = {};

  // Blindness suppresses a kind of failure, not a list of hosts. A verdict is
  // withheld because we could not see, which is true of every transport failure
  // in the run regardless of how many there were — one is as untrustworthy as
  // twenty. Everything else stands: an HTTP status or an authoritative NXDOMAIN
  // came back over a path that, by definition, worked.
  const blind = vision?.blind === true;
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
    } else if (blind && SUPPRESSIBLE_KINDS.has(result.failureKind)) {
      // Blind: the observation is real, the conclusion is not trustworthy yet.
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

  // The sampler runs for the duration of the fleet probes, so it observes the
  // same window the failures happened in rather than a moment either side of it.
  const sampler = startControlSampler();
  let results;
  let samples;
  try {
    results = await probeAll(targets);
  } finally {
    samples = await sampler.stop();
  }
  const now = new Date().toISOString();

  const vision = assessBlindness(samples, state.connectivity, { now });

  const { pendingDown, recovered, sslWarnings, suppressed } = reconcile({
    results,
    state,
    renderAlreadyDown,
    vision,
    now,
  });

  // Persisted so a suppressed run reads as a deliberate decision in the commit
  // history rather than as a gap where nothing happened, and so the next run
  // knows whether it is entering or leaving the blind state. lastAlertAt is what
  // keeps a long outage from sending a notice every ten minutes.
  const blindDuration = vision.restored ? humaniseDuration(state.connectivity?.since) : null;
  state.connectivity = {
    blind: vision.blind,
    since: vision.since,
    consecutive: vision.consecutive,
    samples: vision.taken,
    blindSamples: vision.blindSamples,
    codes: vision.codes,
    lastRunAt: now,
    lastAlertAt: vision.shouldAlert ? now : (state.connectivity?.lastAlertAt ?? null),
  };
  // Written by an older version; nothing reads it any more.
  delete state.transportStorm;

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
  console.log(`\ncontrol: ${vision.summary}`);
  if (vision.blind) {
    console.log(`  BLIND — ${suppressed.length} транспортных вердиктов отложено до следующего тика`);
    for (const r of suppressed) console.log(`    defer ${r.host}: ${r.reason}`);
  }

  if (DRY_RUN) {
    const preview = [];
    if (vision.shouldAlert) preview.push(formatBlindAlert(vision));
    if (vision.restored) preview.push(formatSightRestoredAlert({ blindFor: blindDuration }));
    if (pendingDown.length) preview.push(formatDownAlert(pendingDown));
    if (recovered.length) preview.push(formatRecoveryAlert(recovered));
    if (sslWarnings.length) preview.push(formatSslAlert(sslWarnings));
    console.log(preview.length ? `\n--- would send ---\n${preview.join('\n\n')}` : '\nno alerts');
    for (const r of pendingDown) markDown(state, r.host);
  } else {
    // Connectivity first: when both go out in one run, "I went blind" is the
    // context for everything under it.
    if (vision.shouldAlert) await sendTelegram(formatBlindAlert(vision));
    if (vision.restored) await sendTelegram(formatSightRestoredAlert({ blindFor: blindDuration }));

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
