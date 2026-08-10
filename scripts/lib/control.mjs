/**
 * Connectivity control — "can this runner see anything at all?"
 *
 * Every probe in a run leaves the same CI runner through the same egress path.
 * When that path stalls, each host independently reports a connect timeout at
 * the same instant, and per host that is indistinguishable from the site being
 * down. On 2026-08-08 seven independent whitelabels on four hosting providers
 * in four countries all went "down" inside the same millisecond with
 * UND_ERR_CONNECT_TIMEOUT and recovered on the next tick. Nothing was down.
 *
 * Counting how many hosts failed cannot settle this. It was tried: a fleet-wide
 * share threshold. The share depends on how many hosts happen to be in
 * targets.json and how they split across network paths, so the same stall
 * scores 0.35 on a twenty-host fleet and 0.70 on a ten-host one — the 2026-08-08
 * run itself came to 7/20 and missed a 0.5 threshold. The fleet is the wrong
 * instrument.
 *
 * This module measures the runner's egress directly instead. Several large,
 * unrelated endpoints are polled throughout the run. Any HTTP response at all
 * proves the path works — a 429 or a 500 from them is still a round trip. Only
 * a transport failure counts against them, and only when EVERY control endpoint
 * fails in the same sample do we conclude the runner is blind.
 *
 * That conclusion is direct evidence rather than a guess about ratios:
 *
 *   control answers, sites do not  -> the network is fine, the sites are down.
 *                                     Alert immediately, whether it is one host
 *                                     or the entire fleet.
 *   control does not answer either -> we are blind. Defer transport verdicts and
 *                                     say so out loud, because "I cannot see" is
 *                                     the true statement, not "the sites are down".
 *
 * Failures our egress cannot manufacture — HTTP 4xx/5xx, an authoritative
 * NXDOMAIN, a database-error page in the body — are never suppressed, blind or
 * not. If a response came back, it came back.
 */
import { CONFIG, USER_AGENT } from './config.mjs';
import { hoursSince } from './state.mjs';

/** Failure kinds our own network can manufacture, and therefore may mask. */
export const SUPPRESSIBLE_KINDS = new Set(['transport']);

/**
 * One round trip to a control endpoint.
 *
 * Reachability, not health: any status code means the egress path works. Only a
 * thrown request — connect timeout, reset, DNS unreachable — counts as a miss.
 */
async function reach(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
    });
    return { url, reachable: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return {
      url,
      reachable: false,
      code: err.name === 'AbortError' ? 'TIMEOUT' : err.cause?.code || err.code || err.name,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll every control endpoint once. `blind` means not one of them answered. */
export async function sampleControl(
  endpoints = CONFIG.controlEndpoints,
  timeoutMs = CONFIG.controlTimeoutMs,
  { quiet = false } = {}
) {
  const results = await Promise.all(endpoints.map((url) => reach(url, timeoutMs)));
  const reachable = results.filter((r) => r.reachable).length;
  return {
    at: new Date().toISOString(),
    total: results.length,
    reachable,
    blind: results.length > 0 && reachable === 0,
    // Taken after the fleet probes finished, with nothing else in flight.
    quiet,
    results,
  };
}

/**
 * Sample the control endpoints repeatedly for as long as the caller is probing.
 *
 * A single sample before or after the run would miss a stall that happened in
 * the middle of it, which is exactly when the fleet probes were failing. The
 * sampler covers the same window as the run it accompanies.
 */
export function startControlSampler({
  intervalMs = CONFIG.controlSampleIntervalMs,
  endpoints = CONFIG.controlEndpoints,
  timeoutMs = CONFIG.controlTimeoutMs,
  sample = sampleControl,
} = {}) {
  const samples = [];
  let stopped = false;
  let wake = () => {};

  const pause = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      try {
        samples.push(await sample(endpoints, timeoutMs));
      } catch (err) {
        // The sampler is a diagnostic. It must never be able to fail a run.
        console.error(`[control] sample failed: ${err.name}`);
      }
      if (stopped) break;
      await pause(intervalMs);
    }
  })();

  return {
    /**
     * Stop sampling and take one last reading with the run's load removed.
     *
     * This one matters more than the rest. A run full of failures leaves many
     * connections hanging at once, and that load can starve the control probes
     * by itself — measured here: a fleet of ten unreachable hosts produced five
     * blind samples out of seventeen while the network was demonstrably fine.
     * Without the quiet reading, a genuine fleet-wide outage would manufacture
     * the very evidence used to suppress it. With nothing else in flight, an
     * answer means the path works and the fleet's failures are real.
     */
    async stop() {
      stopped = true;
      wake();
      await loop;
      try {
        samples.push(await sample(endpoints, timeoutMs, { quiet: true }));
      } catch (err) {
        console.error(`[control] quiet sample failed: ${err.name}`);
      }
      return samples;
    },
  };
}

/**
 * Decide whether this run was blind, and whether to say so.
 *
 * Two ways to conclude it, because one alone is not safe:
 *
 *   - the quiet sample, taken once the run's own load is gone, found nothing
 *     reachable. Decisive: no traffic of ours was competing, so the path is
 *     genuinely down.
 *   - most of the during-run samples were blind. A stall that covers the run
 *     shows up in nearly all of them; contention from our own hanging probes
 *     shows up in a minority, which is why this is a share and not "any".
 *
 * Requiring a single blind sample was the first attempt and it was wrong: ten
 * unreachable hosts starved the sampler into five blind readings out of
 * seventeen with the network working fine throughout. On a real fleet-wide
 * outage that would have suppressed the alert using evidence the outage itself
 * created.
 *
 * @param {Array<{blind: boolean, quiet?: boolean}>} samples this run's control samples
 * @param {object} [previous]                        persisted connectivity state
 * @param {{reAlertHours?: number, now?: string, blindRatio?: number}} [options]
 */
export function assessBlindness(samples, previous, options = {}) {
  const {
    reAlertHours = CONFIG.controlReAlertHours,
    blindRatio = CONFIG.controlBlindSampleRatio,
    now = new Date().toISOString(),
  } = options;

  const taken = samples.length;
  const blindSamples = samples.filter((s) => s.blind).length;

  const quiet = samples.filter((s) => s.quiet);
  const quietBlind = quiet.length > 0 && quiet.every((s) => s.blind);

  const during = samples.filter((s) => !s.quiet);
  const duringBlind = during.filter((s) => s.blind).length;
  const duringShare = during.length > 0 ? duringBlind / during.length : 0;

  // No samples at all means the sampler never got to run. That is not evidence
  // of blindness, and must not silence the fleet.
  const blind = taken > 0 && (quietBlind || (during.length > 0 && duringShare >= blindRatio));
  const wasBlind = previous?.blind === true;

  const since = blind ? (wasBlind ? (previous.since ?? now) : now) : null;
  const consecutive = blind ? (previous?.consecutive ?? 0) + 1 : 0;

  // Announce on the way in, then at most once per reAlertHours while it lasts:
  // a runner blind for an hour should keep saying so, without a message every
  // ten minutes.
  const shouldAlert = blind && (!wasBlind || hoursSince(previous?.lastAlertAt) >= reAlertHours);
  const restored = !blind && wasBlind;

  const codes = [
    ...new Set(
      samples
        .filter((s) => s.blind)
        .flatMap((s) => (s.results ?? []).map((r) => r.code))
        .filter(Boolean)
    ),
  ];

  return {
    blind,
    taken,
    blindSamples,
    quietBlind,
    duringShare,
    consecutive,
    since,
    blindSince: blind ? since : (previous?.since ?? null),
    shouldAlert,
    restored,
    codes,
    summary: blind
      ? `раннер ослеп: ни один контрольный адрес не ответил в ${blindSamples} из ${taken} замеров` +
        `${quietBlind ? ', включая контрольный замер без нагрузки' : ''}` +
        `${codes.length ? ` (${codes.join(', ')})` : ''}`
      : blindSamples > 0
        ? `сеть раннера в порядке: ${blindSamples}/${taken} замеров без ответа — это наши же ` +
          `висящие пробы забивали канал, замер без нагрузки прошёл`
        : `сеть раннера в порядке: ${taken - blindSamples}/${taken} замеров с ответом`,
  };
}
