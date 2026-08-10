/**
 * Transport-storm detection.
 *
 * Every probe in a run leaves the same CI runner through the same egress path.
 * When that path stalls, each host independently reports a connect timeout at
 * the same instant — and per host that is indistinguishable from the site being
 * down. Looking at one host tells you nothing; looking at the whole fleet at
 * once does, because unrelated sites on unrelated infrastructure do not fail
 * and recover in lockstep to the millisecond.
 *
 * This module holds that judgement and nothing else: no IO, no network, no
 * clock. It is the piece worth unit-testing, and `scripts/storm.test.mjs`
 * covers it against the shape of the 2026-08-08 false alarm.
 *
 * Only transport-class failures are eligible. An HTTP 4xx/5xx, an authoritative
 * NXDOMAIN or a database-error page in the body cannot be produced by our own
 * egress, so those keep alerting immediately even in the middle of a storm.
 */

/** Failure kinds that our own network can manufacture. */
export const SUPPRESSIBLE_KINDS = new Set(['transport']);

/**
 * @param {Array<{host: string, ok: boolean, failureKind?: string|null}>} results
 * @param {object} options
 * @param {number} options.minHosts        absolute floor of transport failures
 * @param {number} options.ratio           share of the fleet that must be affected
 * @param {number} options.maxConsecutiveRuns  storming runs to absorb before alerting
 * @param {{consecutive?: number}} [options.previous]  persisted storm state
 */
export function assessTransportStorm(results, options) {
  const { minHosts, ratio, maxConsecutiveRuns, previous } = options;
  const total = results.length;
  const transport = results.filter((r) => !r.ok && SUPPRESSIBLE_KINDS.has(r.failureKind));
  const hosts = transport.map((r) => r.host);
  const share = total > 0 ? transport.length / total : 0;

  // Both conditions matter. The ratio is what identifies a shared cause, and the
  // absolute floor keeps a two-host fleet — where "half of them" is one site —
  // from suppressing a real outage.
  const storm = total > 0 && transport.length >= minHosts && share >= ratio;

  if (!storm) {
    return {
      storm: false,
      suppress: false,
      escalated: false,
      hosts: [],
      consecutive: 0,
      share,
      total,
      summary: null,
    };
  }

  const consecutive = (previous?.consecutive ?? 0) + 1;
  const suppress = consecutive <= maxConsecutiveRuns;
  const pct = Math.round(share * 100);
  const summary = suppress
    ? `${transport.length}/${total} хостов (${pct}%) упали разом на транспорте — ` +
      `похоже на сеть раннера, а не на сайты. Прогон ${consecutive}/${maxConsecutiveRuns}, ждём следующего тика.`
    : `${transport.length}/${total} хостов (${pct}%) упали на транспорте ${consecutive}-й прогон подряд — ` +
      `это уже не блип, алертим.`;

  return { storm: true, suppress, escalated: !suppress, hosts, consecutive, share, total, summary };
}
