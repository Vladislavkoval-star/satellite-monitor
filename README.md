# satellite-monitor

Uptime and render monitoring for a fleet of event-ticketing satellite and whitelabel sites, with Telegram alerts.

The monitored list is generated from analytics traffic rather than hand-maintained, so busy sites are picked up automatically and quiet ones drop off.

## What it checks

| Tier | What it catches |
|------|-----------------|
| **Availability** (`scripts/check.mjs`) | DNS not resolving, or resolving on only some resolvers; timeouts; 4xx/5xx; WordPress and nginx error pages; empty responses; TLS certificates expiring within 14 days |
| **Render** (`scripts/render.mjs`) | the page returns 200 but the storefront is blank, has no title, has nothing to buy, or shows an empty catalogue |

Both tiers run in one job every 30 minutes. At this fleet size render is cheap, so a single job pays the setup cost once per cycle instead of twice — and the render tier reads availability state written seconds earlier, which is what makes cross-tier deduplication exact.

A weekly job (`scripts/refresh_targets.py`) rebuilds `targets.json`: the busiest N satellites and the busiest N whitelabels by 30-day sessions. A fixed count rather than a traffic threshold keeps run time and CI cost predictable as traffic moves around — the fleet cannot quietly grow because a few events went on sale. Resize it with the `TOP_N_PER_TYPE` variable.

Raw session counts never reach the repository. The refresh reduces them to a `traffic: high | low` band, which is the only resolution the alerting logic needs.

## Why the probe paths differ per host

The satellites sit behind Cloudflare with a Queue-it waiting room in front. Any HTML request from a datacentre IP — which is what a CI runner is — gets redirected into the queue, so a naive `curl https://host/` check would report every satellite as broken.

`/wp-json/` and `/robots.txt` are not queue-protected, so each target carries its own `probe` path:

- `/wp-json/` where available — the strongest cheap signal, because it proves WordPress and its database are alive (a database failure returns 500, not 200).
- `/robots.txt` as a fallback for non-WordPress storefronts.
- `/` for whitelabel domains on their own infrastructure, which have no queue in front of them.

The render tier drives a real Chromium, which satisfies the JavaScript challenge and is waved through when the queue is empty. If a genuine queue is active the check reports it as a note, not a failure.

## Alert behaviour

- **One alert, immediately, on the first failing run.**
- **No duplicates.** While a host stays down nothing further is sent. The alert fires on the transition into "down" and not again.
- Blips are absorbed *inside* the run: each host gets two immediate attempts four seconds apart before it is declared down. That keeps first-run alerting honest against edge-network resets without delaying a real outage.
- One recovery message when a host comes back, with how long it was down. Set `notifyOnRecovery: false` to silence it.
- The render tier skips any host the availability tier already reported down, so one incident produces one message.
- An empty catalogue only pages for hosts banded `high`. On a satellite whose event has finished, showing nothing to buy is the correct state, so it is logged rather than alerted.
- SSL warnings are rate-limited to once per host per day.

State lives in `state/` and is committed back by the workflow, giving an audit trail of every transition.

All of the above is tunable in one file, `scripts/lib/config.mjs`.

## What the render tier looks for

Two things about this fleet make a naive render check wrong, both found by running it against the live sites:

- **Purchase affordance is not a selector match.** The busiest satellites are React SPAs with hashed CSS-module class names and `javascript:void(0)` navigation, so href and class-name matching finds nothing on a perfectly healthy storefront that has dozens of working buttons. The check passes if **any** of these hold: price-like text (currency plus digits), call-to-action text, a link containing `event`/`ticket`/`checkout`/`buy`, or at least three buttons.
- **`buy.*` and `checkout.*` are app screens, not pages.** Several ship an empty `<title>` while rendering real product, so the `<title>` assertion applies to storefronts only.

Render concurrency is deliberately low. A CI runner has two cores, and five concurrent Chromium tabs starved each other badly enough that healthy sites on shared hosting blew the navigation timeout and alerted as broken. Two was measured clean — and finished faster than five, because each false timeout had been burning two minutes of retries. Raise it only against a bigger runner, and re-measure.

## DNS is checked through four resolvers

A nameserver misconfiguration often breaks resolution for only part of the internet. Asking one resolver tells you nothing about whether customers can reach the site, so every host is resolved through the runner's own resolver plus Cloudflare, Google and Quad9.

- No resolver finds it → the domain is dead.
- Two or more return NXDOMAIN/NODATA while others succeed → **alerted as a partial DNS failure**, naming which resolvers work and which do not. One dissenting resolver is logged but not alerted, because a single public resolver can blocklist a healthy domain on its own. This is the nastier outage: the site is up for part of the world and invisible to the rest, and nobody notices because it looks fine from the office.
- A resolver times out or refuses → treated as noise and ignored, unless every resolver does. A rate-limited public resolver cannot raise a false alarm on its own.

## Dead man's switch

The monitor cannot report its own death. If the workflow stops running, Telegram goes quiet — which looks exactly like everything being healthy. This is not theoretical: a CI provider outage once left this monitor dead for seven hours and nothing said so. Exhausting the account's Actions allowance would do the same, silently, until the next billing month.

So the job pings `HEARTBEAT_URL` after a successful run, and an external watchdog alerts when that ping stops arriving.

Set it up with any dead-man's-switch service — [healthchecks.io](https://healthchecks.io) has a free tier and needs no card:

1. Create a check with period 30 minutes and grace 90 minutes (two missed runs).
2. Copy its ping URL.
3. Add it as the repository secret `HEARTBEAT_URL`.

Point the check's notifications at the same Telegram chat. The step is skipped when the secret is absent, so the monitor still works without it — you just lose the watchdog. The step is deliberately **not** `if: always()`: a failed run must not report healthy.

## Cost

Measured in CI on a warm cache:

| Step | Time |
|---|---|
| setup-node, caches restored | 18 s |
| availability tier | 4 s |
| render tier (concurrency 2) | 29 s |
| **whole job** | **59 s → billed 1 min** |

Every 30 minutes is roughly 1460 minutes a month. Node modules and the Chromium download are cached, and `--with-deps` only runs on a cache miss; without that the job would exceed a minute and double the bill.

## Configuration

Repository **secrets**:

| Secret | Purpose |
|--------|---------|
| `TELEGRAM_BOT_TOKEN` | bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | destination chat id |
| `GA4_SERVICE_ACCOUNT_JSON` | service-account JSON for the analytics property, as one line |
| `GA4_PROPERTY_ID` | analytics property id |
| `HEARTBEAT_URL` | ping URL of an external dead-man's-switch check |

Repository **variables**:

| Variable | Default | Purpose |
|----------|---------|---------|
| `TOP_N_PER_TYPE` | `5` | how many satellites and whitelabels to monitor |
| `EXCLUDED_HOSTS` | empty | comma-separated hosts that appear in analytics but are not ours to monitor |

Nothing credential-shaped is committed. The Telegram helper deliberately never logs an API response body, because the request path contains the bot token.

## Local development

```bash
npm install
npx playwright install chromium

# Availability check, prints alerts instead of sending them
node scripts/check.mjs --dry-run

# Render check, same. CHROMIUM_PATH reuses an already-installed browser.
node scripts/render.mjs --dry-run

# Rebuild the target list
GA4_SERVICE_ACCOUNT_JSON="$(cat sa.json)" GA4_PROPERTY_ID=... python scripts/refresh_targets.py
```

Behind a TLS-inspecting proxy the SSL tier reports the proxy's certificate rather than the site's, and the expiry numbers are meaningless. Only trust SSL results from CI.

## Files

```
targets.json             monitored hosts, generated from analytics
scripts/check.mjs        availability tier
scripts/render.mjs       render tier
scripts/refresh_targets.py   analytics → targets.json
scripts/lib/             config, probes, state, Telegram
state/                   run state, committed by CI
```
