/**
 * Tests for the availability tier's connectivity control.
 *
 * The anchor case is the 2026-08-08 false alarm, reproduced against the fleet
 * that was actually in targets.json that day (commit be8497e): twenty hosts, ten
 * satellites and ten whitelabels. Seven whitelabels reported
 * UND_ERR_CONNECT_TIMEOUT inside the same millisecond and were healthy on the
 * next tick, producing a SITE DOWN naming seven sites and, 25 minutes later, a
 * SITE RECOVERED claiming each had been down. Nothing had been down.
 *
 * That fleet shape matters and is the reason this file exists. The first attempt
 * at a fix suppressed on a fleet-wide share of transport failures, and 7/20 is
 * 0.35 — under the 0.5 threshold, so the false alarm would have fired again. Its
 * test passed only because it used a cut-down ten-host fleet where the same
 * seven failures came to 0.70. The tests below therefore assert on the real
 * twenty-host shape, and assert explicitly that the outcome does not depend on
 * the fleet's size or composition at all.
 *
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from './check.mjs';
import { assessBlindness } from './lib/control.mjs';

const CONFIG_STUB = { notifyOnRecovery: true, failuresBeforeAlert: 1, sslWarnDays: 14 };
const NOW = '2026-08-08T17:50:55.869Z';

// targets.json as it stood on 2026-08-08.
const SATELLITES = [
  'laperle', 'dubaicomedyfestival', 'esports-world-cup', 'aseer-experiences', 'meryal-waterpark',
  'museumofillusions', 'aya-universe', 'mastercard', 'maf', 'sportsparkoman',
].map((h) => `${h}.platinumlist.net`);

const WHITELABELS = [
  'www.beattheheatdxb.ae', 'sportsparkoman.com', 'ibiza-tickets.co', 'tickets.expocitydubai.com',
  'london-musicals.uk', 'london-tickets.uk', 'platinumlist.londontheatredirect.com',
  'www.spotlightlive.ae', 'barcelona-tickets.co', 'concert.ibiza-tickets.co',
];

// The seven named in the SITE DOWN message.
const HIT = [
  'sportsparkoman.com', 'www.beattheheatdxb.ae', 'ibiza-tickets.co', 'london-musicals.uk',
  'london-tickets.uk', 'www.spotlightlive.ae', 'barcelona-tickets.co',
];

const ok = (host) => ({ host, ok: true, status: 200, ms: 120, ssl: null });
const transportFail = (host) => ({
  host,
  ok: false,
  reason: 'сетевая ошибка: UND_ERR_CONNECT_TIMEOUT (3 попытки)',
  failureKind: 'transport',
  ssl: null,
});
const httpFail = (host, status = 500) => ({
  host, ok: false, reason: `HTTP ${status}`, failureKind: 'http', ssl: null,
});
const dnsFail = (host) => ({
  host, ok: false, reason: 'DNS не резолвится (ENOTFOUND)', failureKind: 'dns', ssl: null,
});

/** Control samples: every endpoint silent, versus at least one answering. */
const blindSample = () => ({
  blind: true, total: 3, reachable: 0,
  results: [
    { url: 'g', reachable: false, code: 'UND_ERR_CONNECT_TIMEOUT' },
    { url: 'cf', reachable: false, code: 'UND_ERR_CONNECT_TIMEOUT' },
    { url: 'gh', reachable: false, code: 'UND_ERR_CONNECT_TIMEOUT' },
  ],
});
const seeingSample = () => ({ blind: false, total: 3, reachable: 3, results: [] });
/** The reading taken after the run, with the fleet's own load removed. */
const quietBlind = () => ({ ...blindSample(), quiet: true });
const quietSeeing = () => ({ ...seeingSample(), quiet: true });

const AUG8 = [
  ...SATELLITES.map(ok),
  ...WHITELABELS.map((h) => (HIT.includes(h) ? transportFail(h) : ok(h))),
];

/** One run through the real decision path. */
function run(results, samples, state = { hosts: {} }, renderDown = new Set()) {
  const vision = assessBlindness(samples, state.connectivity, { now: NOW });
  const out = reconcile({
    results, state, renderAlreadyDown: renderDown, vision, now: NOW, config: CONFIG_STUB,
  });
  state.connectivity = {
    blind: vision.blind,
    since: vision.since,
    consecutive: vision.consecutive,
    lastAlertAt: vision.shouldAlert ? new Date().toISOString() : (state.connectivity?.lastAlertAt ?? null),
  };
  return { ...out, vision, state };
}

test('the real 2026-08-08 run — 7 of 20 hosts, runner blind → nothing alerted', () => {
  const { vision, pendingDown, suppressed, state } = run(AUG8, [blindSample(), blindSample(), seeingSample(), quietBlind()]);

  assert.equal(vision.blind, true);
  assert.equal(pendingDown.length, 0, 'no SITE DOWN may be produced');
  assert.equal(suppressed.length, 7);

  for (const host of HIT) {
    assert.equal(state.hosts[host].down, false, `${host} must not be marked down`);
    assert.equal(state.hosts[host].fails, 0, `${host} fail counter must not advance`);
    assert.match(state.hosts[host].lastReason, /UND_ERR_CONNECT_TIMEOUT/);
    assert.equal(state.hosts[host].lastFailureKind, 'transport');
  }
});

test('the verdict does not depend on how big the fleet is', () => {
  // The same seven failures, once against twenty hosts (0.35 of the fleet) and
  // once against ten (0.70). A share threshold gives opposite answers here; the
  // control probe gives the same one, because it is not counting hosts.
  const big = run(AUG8, [blindSample(), quietBlind()]);
  const smallFleet = [
    ...SATELLITES.slice(0, 3).map(ok),
    ...WHITELABELS.filter((h) => HIT.includes(h)).map(transportFail),
  ];
  const small = run(smallFleet, [blindSample(), quietBlind()]);

  assert.equal(big.pendingDown.length, 0);
  assert.equal(small.pendingDown.length, 0);
  assert.equal(big.suppressed.length, 7);
  assert.equal(small.suppressed.length, 7);
});

test('control answers → the sites really are down, alert at once', () => {
  const { vision, pendingDown, suppressed } = run(AUG8, [seeingSample(), seeingSample(), quietSeeing()]);

  assert.equal(vision.blind, false);
  assert.equal(suppressed.length, 0);
  assert.equal(pendingDown.length, 7, 'a working network means the failures are real');
});

test('every satellite down at once still pages immediately when control answers', () => {
  // The objection this design has to survive: a shared CDN or host can take out
  // one whole group for real. Nothing about that may be deferred.
  const results = [...SATELLITES.map(transportFail), ...WHITELABELS.map(ok)];
  const { pendingDown } = run(results, [seeingSample(), quietSeeing()]);

  assert.equal(pendingDown.length, 10, 'ten genuinely dead satellites must alert on the first run');
});

test('the entire fleet down at once still pages immediately when control answers', () => {
  const results = [...SATELLITES.map(transportFail), ...WHITELABELS.map(transportFail)];
  const { pendingDown } = run(results, [seeingSample(), quietSeeing()]);

  assert.equal(pendingDown.length, 20, 'no share of the fleet is large enough to be dismissed');
});

test('a single transport failure is deferred while blind, like any other', () => {
  const results = [...SATELLITES.map(ok), transportFail(WHITELABELS[0]), ...WHITELABELS.slice(1).map(ok)];
  const { pendingDown, suppressed } = run(results, [blindSample(), quietBlind()]);

  assert.equal(pendingDown.length, 0, 'one unreachable host is no more trustworthy than twenty');
  assert.equal(suppressed.length, 1);
});

test('HTTP errors are never suppressed, blind or not', () => {
  const results = [
    httpFail(SATELLITES[0], 502),
    ...SATELLITES.slice(1).map(ok),
    ...WHITELABELS.map((h) => (HIT.includes(h) ? transportFail(h) : ok(h))),
  ];
  const { pendingDown, suppressed } = run(results, [blindSample(), quietBlind()]);

  assert.deepEqual(
    pendingDown.map((r) => r.host),
    [SATELLITES[0]],
    'a 502 came back over a path that worked, so it stands'
  );
  assert.equal(suppressed.length, 7);
});

test('authoritative NXDOMAIN is never suppressed either', () => {
  const results = [...SATELLITES.map(ok), ...WHITELABELS.map(dnsFail)];
  const { pendingDown, suppressed } = run(results, [blindSample(), quietBlind()]);

  assert.equal(pendingDown.length, 10, 'the domains are gone; our egress cannot invent that');
  assert.equal(suppressed.length, 0);
});

test('the next clean tick sends no phantom SITE RECOVERED', () => {
  const blindRun = run(AUG8, [blindSample(), quietBlind()]);
  const clean = run(
    [...SATELLITES.map(ok), ...WHITELABELS.map(ok)],
    [seeingSample(), quietSeeing()],
    blindRun.state
  );

  assert.equal(clean.pendingDown.length, 0);
  assert.equal(clean.recovered.length, 0, 'nothing was down, so nothing may "recover"');
});

test('an open incident is not closed by going blind', () => {
  const state = {
    hosts: {
      [HIT[0]]: {
        fails: 3, down: true,
        downSince: '2026-08-07T01:09:06.717Z',
        lastAlertAt: '2026-08-07T01:09:06.717Z',
        lastSslAlertAt: null, lastReason: 'HTTP 503', lastFailureKind: 'http',
      },
    },
  };
  const { pendingDown, recovered, state: after } = run(AUG8, [blindSample()], state);

  assert.equal(pendingDown.length, 0);
  assert.equal(recovered.length, 0);
  assert.equal(after.hosts[HIT[0]].down, true);
  assert.equal(after.hosts[HIT[0]].downSince, '2026-08-07T01:09:06.717Z');
});

test('render-tier dedup still marks a host down without a second alert', () => {
  const results = [...SATELLITES.map(ok), httpFail(WHITELABELS[0]), ...WHITELABELS.slice(1).map(ok)];
  const { pendingDown, state } = run(results, [seeingSample(), quietSeeing()], { hosts: {} }, new Set([WHITELABELS[0]]));

  assert.equal(pendingDown.length, 0, 'render already reported this incident');
  assert.equal(state.hosts[WHITELABELS[0]].down, true);
});

test('no control samples is not evidence of blindness and must not mute the fleet', () => {
  const { vision, pendingDown } = run(AUG8, []);

  assert.equal(vision.blind, false, 'a sampler that never ran proves nothing');
  assert.equal(pendingDown.length, 7);
});

test('one endpoint answering is enough to count as sighted', () => {
  const partial = {
    blind: false, total: 3, reachable: 1,
    results: [{ url: 'g', reachable: true, status: 204 }],
  };
  const { vision, pendingDown } = run(AUG8, [partial, quietSeeing()]);

  assert.equal(vision.blind, false, 'the path works, so the fleet failures are real');
  assert.equal(pendingDown.length, 7);
});

test('the blind notice is sent on the way in, then held back', () => {
  const first = assessBlindness([blindSample(), quietBlind()], undefined, { now: NOW });
  assert.equal(first.shouldAlert, true, 'entering the state always announces it');
  assert.equal(first.consecutive, 1);

  const stillBlind = assessBlindness([blindSample(), quietBlind()], {
    blind: true, since: NOW, consecutive: 1, lastAlertAt: new Date().toISOString(),
  }, { now: NOW });
  assert.equal(stillBlind.shouldAlert, false, 'no repeat message ten minutes later');
  assert.equal(stillBlind.consecutive, 2);
  assert.equal(stillBlind.since, NOW, 'the start of the episode is preserved');
});

test('a long blindness repeats the notice once an hour', () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const v = assessBlindness([blindSample(), quietBlind()], {
    blind: true, since: twoHoursAgo, consecutive: 12, lastAlertAt: twoHoursAgo,
  }, { now: NOW, reAlertHours: 1 });

  assert.equal(v.shouldAlert, true, 'still blind after an hour is worth saying again');
});

test('coming back announces itself and resets the counter', () => {
  const v = assessBlindness([seeingSample(), quietSeeing()], {
    blind: true, since: NOW, consecutive: 3, lastAlertAt: NOW,
  }, { now: NOW });

  assert.equal(v.blind, false);
  assert.equal(v.restored, true);
  assert.equal(v.consecutive, 0);
  assert.equal(v.shouldAlert, false, 'recovery is its own message, not another blind notice');
});

test('the failure codes reach the notice', () => {
  const v = assessBlindness([blindSample(), quietBlind()], undefined, { now: NOW });
  assert.deepEqual(v.codes, ['UND_ERR_CONNECT_TIMEOUT']);
  assert.match(v.summary, /ослеп/);
});

test('our own hanging probes must not manufacture blindness', () => {
  // Measured against ten unreachable hosts: five blind samples out of seventeen
  // while the network was demonstrably fine — the run's own load starving the
  // sampler. A minority like that, with the quiet reading answering, is not
  // blindness, and the fleet's failures must still page.
  const samples = [
    ...Array.from({ length: 5 }, blindSample),
    ...Array.from({ length: 12 }, seeingSample),
    quietSeeing(),
  ];
  const { vision, pendingDown, suppressed } = run(AUG8, samples);

  assert.equal(vision.blind, false, 'a minority of blind samples is contention, not an outage');
  assert.equal(suppressed.length, 0);
  assert.equal(pendingDown.length, 7, 'the outage may not suppress itself');
  assert.match(vision.summary, /висящие пробы/);
});

test('a whole-fleet outage cannot silence itself through contention', () => {
  // The dangerous shape: everything down, and the load that creates starving the
  // control probes for part of the run. The quiet reading settles it.
  const samples = [
    ...Array.from({ length: 6 }, blindSample),
    ...Array.from({ length: 11 }, seeingSample),
    quietSeeing(),
  ];
  const results = [...SATELLITES.map(transportFail), ...WHITELABELS.map(transportFail)];
  const { vision, pendingDown } = run(results, samples);

  assert.equal(vision.blind, false);
  assert.equal(pendingDown.length, 20, 'twenty dead hosts must page on the first run');
});

test('the quiet reading alone is enough to conclude blindness', () => {
  // Nothing of ours in flight and still no answer: the path is genuinely gone,
  // whatever the during-run samples managed to catch.
  const { vision, pendingDown } = run(AUG8, [seeingSample(), seeingSample(), quietBlind()]);

  assert.equal(vision.quietBlind, true);
  assert.equal(vision.blind, true);
  assert.equal(pendingDown.length, 0);
});

test('a stall covering the run is blind even if it clears by the quiet reading', () => {
  const samples = [...Array.from({ length: 8 }, blindSample), quietSeeing()];
  const { vision, pendingDown } = run(AUG8, samples);

  assert.equal(vision.blind, true, 'the whole run happened inside the stall');
  assert.equal(vision.duringShare, 1);
  assert.equal(pendingDown.length, 0);
});
