# satellite-monitor

Uptime and render monitoring for a fleet of event-ticketing satellite and whitelabel sites, with Telegram alerts.

The monitored list is generated from analytics traffic rather than hand-maintained, so busy sites are picked up automatically and quiet ones drop off.

## What it checks

| Tier | What it catches |
|------|-----------------|
| **Availability** (`scripts/check.mjs`) | DNS not resolving, or resolving on only some resolvers; timeouts; 4xx/5xx; WordPress and nginx error pages; empty responses; TLS certificates expiring within 14 days |
| **Render** (`scripts/render.mjs`) | the page returns 200 but the storefront is blank, has no title, has nothing to buy, or shows an empty catalogue |

Both tiers run in one job every 10 minutes. At this fleet size render is cheap, so a single job pays the setup cost once per cycle instead of twice — and the render tier reads availability state written seconds earlier, which is what makes cross-tier deduplication exact.

A weekly job (`scripts/refresh_targets.py`) rebuilds `targets.json`: the 10 busiest satellites and the 10 busiest whitelabels by 30-day sessions. A fixed count rather than a traffic threshold keeps run time and CI cost predictable as traffic moves around — the fleet cannot quietly grow because a few events went on sale. Resize it with the `TOP_N_PER_TYPE` variable.

Two hygiene filters keep the tail clean: test, staging and preview hostnames are skipped outright, and where both `example.com` and `www.example.com` appear only the busier one takes a slot — the pair serves the same storefront, so monitoring both spends a slot and doubles the alert for one incident.

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
- **A transport failure hitting most of the fleet at once is treated as our own network, not theirs** — see below.

State lives in `state/` and is committed back by the workflow, giving an audit trail of every transition. Each host also carries `lastReason` and `lastFailureKind`, so a past incident can be explained from the commit history alone rather than from Telegram scrollback and Actions logs that age out.

## When the runner is the outage

Every probe in a run leaves the same CI runner through the same egress path. When that path stalls, each host independently reports a connect timeout — and per host that is indistinguishable from the site being down.

This is not theoretical. On 8 August 2026 seven independent whitelabels, on four different hosting providers in four countries, all went "down" inside the same millisecond with `UND_ERR_CONNECT_TIMEOUT`, and all "recovered" on the next tick. The alert claimed each had been down for 25 minutes. Nothing had been down at all: the runner's network hiccuped for longer than the gap between the two in-run retries. The `*.platinumlist.net` satellites in the same run stayed green, which is the tell — a real incident does not respect the boundary between "external hosts" and "our CDN".

### Counting hosts does not work

The first attempt at a fix suppressed when transport failures cleared an absolute floor and a share of the fleet. It did not fire on the run it was written for. The fleet that day held twenty hosts, seven failed, and 7/20 = 0.35 fell under the 0.5 threshold — the alert would have gone out again. Its test passed only because it used a cut-down ten-host fleet, where the same seven failures came to 0.70.

The share depends on how many hosts happen to be in `targets.json` and how they split across network paths, neither of which has anything to do with whether the runner can see. Worse, the stall reached only the whitelabels — the satellites sit behind a different path and stayed green — so the affected group could never exceed half the fleet however bad it got. The fleet is the wrong instrument.

### Asking the network instead

`scripts/lib/control.mjs` measures the runner's egress directly. Three large, unrelated endpoints — Google, Cloudflare, GitHub — are polled throughout the run. Any HTTP response counts as reachable: we are testing our own path, not their health, so a 429 from them is still a round trip. Only when every one fails at once does the runner count as blind.

| Control | Fleet | Conclusion |
|---|---|---|
| answers | failing | the network is fine, the sites are down → **alert immediately**, one host or all twenty |
| silent | failing | we are blind → defer transport verdicts, send `МОНИТОРИНГ ОСЛЕП` |

This does not care how big the fleet is, how it splits across providers, or how many hosts failed. One unreachable host is exactly as untrustworthy as twenty when we cannot see.

Blindness is announced rather than kept quiet. Silence would leave the same gap the false alarm did — something happened, no message explains it. Entering the state sends one notice, leaving it sends another, and a runner blind for longer repeats at most once per `controlReAlertHours`.

### The trap in measuring your own network

A run where the whole fleet is unreachable leaves many connections hanging at once, and that load can starve the control probes by itself. Measured, with ten dead hosts: five blind samples out of seventeen while the network was demonstrably fine. Suppressing on any single blind sample would let a genuine fleet-wide outage manufacture the evidence used to bury it — a worse bug than the one being fixed.

So a run counts as blind only if the reading taken **after** the fleet probes finish, with nothing else in flight, found nothing reachable — or if most of the during-run samples were blind (`controlBlindSampleRatio`). A real stall covers the run and shows up in nearly every sample; contention from our own probes shows up in a minority and clears the moment the load stops.

The second guard is unchanged and works at a different level:

- **A third attempt, transport failures only** (`transportRetryDelayMs`, 12s). The standard two attempts are ~4s apart, which is inside the length of a typical stall, so on their own they cannot separate one from a dead host. This attempt is free on a healthy fleet — it only runs for a host that already failed twice on transport — and never fires for an HTTP error or a real NXDOMAIN, where waiting buys nothing.

What is deliberately **never** suppressed, because our own egress cannot manufacture it:

| Failure | Kind | Behaviour |
|---|---|---|
| HTTP 4xx / 5xx | `http` | alerts immediately, even while blind |
| Error page in the body (`database connection`, `nginx error`, …) | `content` | alerts immediately |
| Blank render, no title, nothing to buy | `content` | alerts immediately |
| Authoritative NXDOMAIN / NODATA from any resolver | `dns` | alerts immediately |
| Every resolver merely timing out or refusing | `transport` | eligible for suppression — that is our DNS path, not the domain |
| Connect timeout, reset, socket hang up, navigation timeout | `transport` | eligible for suppression |

If a response came back, it came back: the path worked, and the verdict stands.

### The render tier keeps the share threshold

`scripts/lib/storm.mjs` still guards the render tier, because there the shared resource is the runner's CPU as much as its network. Five concurrent Chromium tabs once starved each other until nine healthy whitelabels all blew the navigation timeout together — with the network fine throughout, which is exactly what a control probe would have reported. Only the fleet-wide view catches that, so the render tier suppresses on either signal: blind egress, or most of the fleet timing out at once.

The same guard runs in the render tier, where the shared resource is the runner's CPU as much as its network — the README section below records five concurrent tabs starving each other until nine healthy whitelabels all blew the navigation timeout in one run.

`npm test` covers this: the suite drives the real decision path with synthetic runs, including the 8 August shape.

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

1. Create a check with period 10 minutes and grace 30 minutes (two missed runs).
2. Copy its ping URL.
3. Add it as the repository secret `HEARTBEAT_URL`.

Point the check's notifications at the same Telegram chat. The step is skipped when the secret is absent, so the monitor still works without it — you just lose the watchdog. The step is deliberately **not** `if: always()`: a failed run must not report healthy.

## Cost

Measured in CI on a warm cache:

| Step | Time |
|---|---|
| setup-node, caches restored | 18 s |
| availability tier, 20 hosts | 8 s |
| render tier, 20 hosts (concurrency 2) | 60 s |
| **whole job** | **~90 s** |

The repository is public, so Actions minutes are **free and unmetered** — this is the reason a 10-minute interval is affordable at all. On a private repo the same schedule would be roughly 4400 minutes a month against a 2000-minute allowance.

Node modules and the Chromium download are cached, and `--with-deps` only runs on a cache miss, which is what keeps the job inside a minute.

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
| `TOP_N_PER_TYPE` | `10` | how many satellites and whitelabels to monitor |
| `EXCLUDED_HOSTS` | empty | comma-separated hosts that appear in analytics but are not ours to monitor |

Alerting thresholds live in `scripts/lib/config.mjs`, not in repository variables. Connectivity control, used by both tiers:

| Setting | Default | Purpose |
|---|---|---|
| `controlEndpoints` | Google, Cloudflare, GitHub | unrelated endpoints that answer "can we reach anything?" |
| `controlSampleIntervalMs` | `8000` | how often they are polled during a run |
| `controlTimeoutMs` | `8000` | per-control-request timeout |
| `controlBlindSampleRatio` | `0.5` | share of during-run samples that must be blind, when the quiet reading disagrees |
| `controlReAlertHours` | `1` | how often to repeat the notice while blindness lasts |

Share-threshold suppression, now render-tier only:

| Setting | Default | Purpose |
|---|---|---|
| `transportStormMinHosts` | `3` | absolute floor of simultaneous transport failures |
| `transportStormRatio` | `0.5` | share of the fleet that must be affected |
| `transportStormMaxConsecutiveRuns` | `1` | storming runs absorbed before alerting anyway |
| `transportRetryDelayMs` | `12000` | pause before the transport-only third attempt (`0` disables) |

The control endpoints must stay unrelated to the monitored fleet. Anything sharing a CDN or a registrar with the sites would fail alongside a real outage and suppress it.

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
