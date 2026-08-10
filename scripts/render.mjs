/**
 * Render tier. Runs hourly.
 *
 * Opens each target in a real Chromium so Queue-it's JavaScript challenge is
 * satisfied, then asserts the page actually rendered: non-empty title, real
 * body text, no WordPress/nginx error signature, and at least one purchase
 * affordance (ticket link, price, or buy button).
 *
 * This is the tier that catches "HTTP 200 but the storefront is a white screen"
 * — the Redis-cache class of failure that a status-code check cannot see.
 */
import { chromium } from 'playwright';
import {
  CONFIG,
  EMPTY_CATALOGUE_SIGNATURES,
  FAILURE_SIGNATURES,
  PATHS,
  USER_AGENT,
  loadTargets,
} from './lib/config.mjs';
import { emptyHostState, humaniseDuration, loadState, saveState } from './lib/state.mjs';
import { assessTransportStorm } from './lib/storm.mjs';
import { SUPPRESSIBLE_KINDS, assessBlindness, startControlSampler } from './lib/control.mjs';
import { formatRecoveryAlert, formatRenderAlert, sendTelegram } from './lib/notify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const NAV_TIMEOUT_MS = CONFIG.renderNavTimeoutMs;
const QUEUE_HOST = 'queue.platinumlist.net';

/**
 * Does the page offer something to buy?
 *
 * Deliberately not selector-only. The high-traffic satellites are React SPAs
 * with hashed CSS-module class names (`__btn__o8yUqpBOi6`) and `javascript:void(0)`
 * navigation, so href and class-name matching finds nothing on a perfectly
 * healthy storefront — the busiest satellite in the fleet has dozens of working
 * buttons and zero matchable hrefs. Any one of these signals is enough.
 */
const PRICE_PATTERN = /\b(AED|USD|QAR|OMR|BHD|SAR|KWD|EGP|MAD|GBP|EUR|TRY)\s?\d|[£$€]\s?\d/i;
const PURCHASE_TEXT_PATTERN = /\b(buy|book now|book tickets|get tickets|tickets from|select tickets|add to cart|from\s+[£$€]?\d)/i;
const PURCHASE_LINK_SELECTOR =
  'a[href*="/event"], a[href*="ticket"], a[href*="checkout"], a[href*="buy"], a[href*="/booking"]';

async function hasPurchaseAffordance(page, text) {
  if (PRICE_PATTERN.test(text)) return 'цена в тексте';
  if (PURCHASE_TEXT_PATTERN.test(text)) return 'CTA в тексте';
  if ((await page.locator(PURCHASE_LINK_SELECTOR).count()) > 0) return 'ссылка покупки';
  // An SPA storefront is button-driven. Three or more is well clear of the
  // one-or-two buttons a cookie banner or language switcher would contribute.
  if ((await page.locator('button').count()) >= 3) return 'интерактивные кнопки';
  return null;
}

async function renderCheck(page, host) {
  const url = `https://${host}/`;
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Queue-it bounces the first request; a real browser is waved straight
    // back through when the queue is empty. Give it room to complete.
    if (page.url().includes(QUEUE_HOST)) {
      await page
        .waitForURL((u) => !u.href.includes(QUEUE_HOST), { timeout: 45000 })
        .catch(() => {});
      if (page.url().includes(QUEUE_HOST)) {
        return { host, ok: true, note: 'сидит в Queue-it — очередь активна, не считаем падением' };
      }
    }

    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    const status = response?.status() ?? null;
    if (status && status >= 400) {
      return { host, ok: false, reason: `HTTP ${status} при рендере`, failureKind: 'http' };
    }

    const title = (await page.title()).trim();
    const text = (await page.evaluate(() => document.body?.innerText ?? '')).trim();
    const lower = text.toLowerCase();

    const signature = FAILURE_SIGNATURES.find((s) => lower.includes(s));
    if (signature) {
      return {
        host,
        ok: false,
        reason: `на странице "${signature}"`,
        failureKind: 'content',
        emptyCatalogue: EMPTY_CATALOGUE_SIGNATURES.includes(signature),
      };
    }

    // buy.* and checkout.* are in-app screens, not indexed pages: several ship
    // with an empty <title> while working perfectly
    // (buy.meryal-waterpark.tickets-doha.co renders 2.5k chars of real product).
    // Treating that as an outage would be a false alarm, so the title assertion
    // applies to storefronts only.
    const isCheckoutApp = /^(buy|checkout)\./.test(host);
    if (!isCheckoutApp && title.length === 0) {
      return { host, ok: false, reason: 'пустой <title>', failureKind: 'content' };
    }
    if (text.length < CONFIG.minRenderedTextLength) {
      return {
        host,
        ok: false,
        reason: `почти пустая страница (${text.length} символов текста)`,
        failureKind: 'content',
      };
    }

    const affordance = await hasPurchaseAffordance(page, text);
    if (!affordance) {
      return {
        host,
        ok: false,
        reason: 'нечего купить: ни цены, ни CTA, ни кнопок, ни ссылок на билеты',
        failureKind: 'content',
      };
    }

    return { host, ok: true, title, textLength: text.length, affordance };
  } catch (err) {
    // Navigation never completed, so nothing about the page was observed. On a
    // two-core runner this is also what tab starvation and an egress stall look
    // like, which is why it is transport-class and eligible for storm
    // suppression rather than an immediate alert.
    const reason =
      err.name === 'TimeoutError'
        ? `не отрисовалась за ${NAV_TIMEOUT_MS / 1000}с`
        : `ошибка браузера: ${String(err.message).split('\n')[0].slice(0, 120)}`;
    return { host, ok: false, reason, failureKind: 'transport' };
  }
}

async function main() {
  const targets = await loadTargets();
  const state = await loadState(PATHS.renderState);
  if (!state.hosts) state.hosts = {};

  // CHROMIUM_PATH lets a local run reuse an already-installed Chromium instead of
  // downloading one. CI leaves it unset and uses the browser from `playwright install`.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: 'en-GB',
  });

  // The availability tier runs first in the same job, so its state is current.
  // A host it already reported down must not be alerted a second time here —
  // frameless.london-tickets.uk has no DNS record and would otherwise produce
  // two messages for one incident.
  const availability = await loadState(PATHS.state);
  const alreadyDown = new Set(
    Object.entries(availability.hosts ?? {})
      .filter(([, host]) => host.down)
      .map(([name]) => name)
  );

  const pending = targets.filter((target) => {
    if (alreadyDown.has(target.host)) {
      console.log(`  SKIP ${target.host.padEnd(48)} уже отмечен упавшим на уровне доступности`);
      return false;
    }
    return true;
  });

  async function checkOne(target) {
    let result;
    // Retry once immediately. Rendering is noisier than a status code, and a
    // single retry keeps first-run alerting honest without an hour's delay.
    const attempts = Math.max(1, CONFIG.retriesWithinRun);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const page = await context.newPage();
      result = await renderCheck(page, target.host);
      await page.close();
      if (result.ok) break;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, CONFIG.retryDelayMs));
      else result.reason = `${result.reason} (${attempt} попытки)`;
    }
    result.traffic = target.traffic;
    const flag = result.ok ? 'OK  ' : 'FAIL';
    console.log(
      `  ${flag} ${result.host.padEnd(48)} ` +
        `${result.ok ? result.note ?? `"${result.title}"` : `${result.reason} [${result.failureKind}]`}`
    );
    return result;
  }

  // Bounded worker pool. Each worker owns one page at a time, so peak memory
  // stays at renderConcurrency tabs regardless of fleet size.
  //
  // The control sampler runs alongside it, covering the same window: a stall
  // that happened while these tabs were navigating is the one worth knowing
  // about, and a sample taken before or after would miss it.
  const queue = [...pending];
  const results = [];
  const sampler = startControlSampler();
  let samples;
  try {
    await Promise.all(
      Array.from({ length: Math.min(CONFIG.renderConcurrency, queue.length) }, async () => {
        while (queue.length > 0) {
          results.push(await checkOne(queue.shift()));
        }
      })
    );
  } finally {
    samples = await sampler.stop();
  }

  // Teardown before the alert computation would mean a crashed tab throws away
  // every finding in the run, so it happens after, and failures there are not
  // allowed to lose results either.
  const closeBrowser = async () => {
    try {
      await context.close();
      await browser.close();
    } catch (err) {
      console.error(`[render] teardown: ${err.name}`);
    }
  };

  // Two shared resources can break this tier at once, so it listens to both.
  //
  // The network is one, and lib/control.mjs answers that directly — same signal
  // the availability tier uses.
  //
  // The runner itself is the other, and no control probe can see it: the README
  // records five concurrent Chromium tabs starving each other until nine healthy
  // whitelabels all blew the navigation timeout together, while the network was
  // perfectly fine throughout. Only the fleet-wide view catches that, so the
  // share threshold stays here even though the availability tier has dropped it.
  const vision = assessBlindness(samples, state.connectivity, { now: new Date().toISOString() });
  const storm = assessTransportStorm(results, {
    minHosts: CONFIG.transportStormMinHosts,
    ratio: CONFIG.transportStormRatio,
    maxConsecutiveRuns: CONFIG.transportStormMaxConsecutiveRuns,
    previous: state.transportStorm,
  });
  const suppressedHosts = new Set(storm.suppress ? storm.hosts : []);
  console.log(`\ncontrol: ${vision.summary}`);
  if (storm.storm) {
    console.log(`${storm.suppress ? 'STORM SUPPRESSED' : 'STORM ESCALATED'}: ${storm.summary}`);
    console.log(`  hosts: ${storm.hosts.join(', ')}`);
  }

  const alerts = [];
  const recovered = [];
  for (const result of results) {
    const host = state.hosts[result.host] ?? emptyHostState();

    // An empty catalogue on a low-traffic host means the event is over, which is
    // the expected state rather than an incident. It counts as healthy so the
    // host cannot get wedged into a permanent `down: true` and end up muted the
    // next time it genuinely breaks.
    const staleEmptyCatalogue =
      !result.ok &&
      result.emptyCatalogue &&
      result.traffic !== 'high' &&
      !CONFIG.alertEmptyCatalogueOnLowTraffic;

    if (staleEmptyCatalogue) {
      console.log(`  note ${result.host}: пустой каталог, но трафик низкий — ивент прошёл, не алертим`);
    }

    if (result.ok || staleEmptyCatalogue) {
      if (host.down && CONFIG.notifyOnRecovery) {
        recovered.push({ host: result.host, downFor: humaniseDuration(host.downSince) });
      }
      host.fails = 0;
      host.down = false;
      host.downSince = null;
      host.lastAlertAt = null;
      host.lastReason = null;
      host.lastFailureKind = null;
    } else if (
      suppressedHosts.has(result.host) ||
      (vision.blind && SUPPRESSIBLE_KINDS.has(result.failureKind))
    ) {
      // Observation kept, judgement deferred one tick — and because `down` stays
      // false, no phantom recovery message follows when the next run is clean.
      host.lastReason = result.reason;
      host.lastFailureKind = result.failureKind ?? null;
    } else {
      host.fails += 1;
      host.lastReason = result.reason;
      host.lastFailureKind = result.failureKind ?? null;
      // Queued for alerting; `down` is only set once Telegram confirms delivery.
      if (!host.down && host.fails >= CONFIG.failuresBeforeAlert) alerts.push(result);
    }
    state.hosts[result.host] = host;
  }

  state.transportStorm = {
    consecutive: storm.consecutive,
    lastRunAt: new Date().toISOString(),
    hosts: storm.storm ? storm.hosts : [],
    suppressed: storm.suppress,
    escalated: storm.escalated,
  };

  // Drop state for hosts that have left targets.json; a stale `down: true` would
  // permanently mute them if they were ever monitored again.
  const monitored = new Set(targets.map((t) => t.host));
  for (const name of Object.keys(state.hosts)) {
    if (!monitored.has(name)) {
      delete state.hosts[name];
      console.log(`  prune ${name}: больше не в списке целей, состояние удалено`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nrender: ${okCount}/${results.length} ok`);

  if (DRY_RUN) {
    const preview = [];
    if (alerts.length) preview.push(formatRenderAlert(alerts));
    if (recovered.length) preview.push(formatRecoveryAlert(recovered));
    console.log(preview.length ? `\n--- would send ---\n${preview.join('\n\n')}` : '\nno alerts');
    for (const r of alerts) markDown(state, r.host);
  } else {
    // Only record the incident as reported once Telegram accepted it, otherwise
    // one rate-limited send would bury the outage until it recovers.
    if (alerts.length > 0) {
      const delivered = await sendTelegram(formatRenderAlert(alerts));
      if (delivered) for (const r of alerts) markDown(state, r.host);
      else console.error('[render] alert not delivered — состояние не помечено, повторим в следующем прогоне');
    }
    if (recovered.length > 0) await sendTelegram(formatRecoveryAlert(recovered));
  }

  await saveState(PATHS.renderState, state);
  await closeBrowser();
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
  console.error(`[render] fatal: ${err.message}`);
  process.exit(1);
});
