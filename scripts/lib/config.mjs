import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Browser-like UA. Datacentre IPs get challenged less with a normal UA. */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const PATHS = {
  root: ROOT,
  targets: path.join(ROOT, 'targets.json'),
  state: path.join(ROOT, 'state', 'status.json'),
  renderState: path.join(ROOT, 'state', 'render.json'),
};

/** Tunables. Kept in one place so behaviour is auditable. */
export const CONFIG = {
  /**
   * Alert on the first failed run — no waiting for a second hourly tick.
   * Blip protection is handled inside the run instead (see retriesWithinRun),
   * so a genuine outage still pages immediately.
   */
  failuresBeforeAlert: 1,
  /**
   * Immediate retries inside a single run before a host is declared down.
   * Cloudflare and Queue-it produce occasional one-off resets; retrying a few
   * seconds later costs nothing and removes almost all false alarms without
   * delaying a real alert by an hour.
   */
  retriesWithinRun: 2,
  retryDelayMs: 4000,
  /**
   * Reminder alerts while a host stays down. Disabled — one alert per incident.
   */
  remindWhileDown: false,
  /** Send a single message when a host comes back. Set false to go fully silent on recovery. */
  notifyOnRecovery: true,
  /** Per-request timeout, milliseconds. */
  timeoutMs: 20000,
  /** Concurrent probes. */
  concurrency: 8,
  /** Warn when the TLS certificate expires within this many days. Once per host per day. */
  sslWarnDays: 14,
  /**
   * Playwright render check: minimum visible text length for a page to count as
   * rendered. Checkout-style satellites are legitimately terse (~950 chars), so
   * this only has to catch a genuinely blank shell.
   */
  minRenderedTextLength: 200,
  /**
   * An empty catalogue only pages for hosts banded "high" in targets.json.
   * On a satellite whose event has finished, showing nothing to buy is correct
   * behaviour rather than an incident. The band is computed at refresh time so
   * that raw session counts never land in this public repository.
   */
  alertEmptyCatalogueOnLowTraffic: false,
  /**
   * Pages rendered concurrently.
   *
   * A GitHub-hosted runner has two cores. Five concurrent Chromium tabs starved
   * each other badly enough that nine healthy whitelabels on shared hosting blew
   * the navigation timeout and alerted as broken — all of them had rendered
   * fine sequentially. Two is the setting that was measured clean; raise it only
   * against a bigger runner, and re-measure.
   */
  renderConcurrency: 2,
  /**
   * Navigation timeout for the render tier, milliseconds. Generous on purpose:
   * a slow shared-hosting whitelabel is not an outage, and a false "broken"
   * costs more trust than a late alert.
   */
  renderNavTimeoutMs: 90000,
};

/**
 * The site is up and the app works, but there is nothing to buy.
 * Tracked separately from hard failures because on a satellite whose event has
 * finished this is the expected state, not an incident — see
 * CONFIG.alertEmptyCatalogueOnLowTraffic.
 */
export const EMPTY_CATALOGUE_SIGNATURES = [
  'nothing to see here',
  'try adjusting your search',
  'no events found',
];

/** Substrings that mean "HTTP 200 but the site is actually broken". */
export const FAILURE_SIGNATURES = [
  'error establishing a database connection',
  'there has been a critical error on this website',
  '502 bad gateway',
  '503 service unavailable',
  '504 gateway time-out',
  'service temporarily unavailable',
  'account suspended',
  'this domain has expired',
  'domain is for sale',
  'buy this domain',
  'nginx error',
  'application error',
  ...EMPTY_CATALOGUE_SIGNATURES,
];

export async function loadTargets() {
  const raw = JSON.parse(await readFile(PATHS.targets, 'utf8'));
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error('targets.json contains no targets');
  }
  return raw.targets;
}

/**
 * Secrets come from the environment only (GitHub Actions secrets).
 * Never hardcode or log these.
 */
export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
