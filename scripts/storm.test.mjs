/**
 * Tests for transport-storm suppression.
 *
 * The first case is the 2026-08-08 false alarm reproduced from the state history:
 * ten monitored hosts, seven independent whitelabels reporting
 * UND_ERR_CONNECT_TIMEOUT inside the same millisecond, all healthy on the next
 * tick. Before this change that run produced a SITE DOWN naming seven sites and,
 * 25 minutes later, a SITE RECOVERED claiming each had been down — while nothing
 * had actually been down at all.
 *
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from './check.mjs';
import { assessTransportStorm } from './lib/storm.mjs';

const STORM_OPTS = { minHosts: 3, ratio: 0.5, maxConsecutiveRuns: 1 };
const CONFIG_STUB = { notifyOnRecovery: true, failuresBeforeAlert: 1, sslWarnDays: 14 };
const NOW = '2026-08-08T17:50:55.869Z';

const SATELLITES = [
  'laperle.platinumlist.net',
  'dubaicomedyfestival.platinumlist.net',
  'esports-world-cup.platinumlist.net',
];
const WHITELABELS = [
  'sportsparkoman.com',
  'www.beattheheatdxb.ae',
  'ibiza-tickets.co',
  'london-musicals.uk',
  'london-tickets.uk',
  'www.spotlightlive.ae',
  'barcelona-tickets.co',
];

const ok = (host) => ({ host, ok: true, status: 200, ms: 120, ssl: null });
const transportFail = (host) => ({
  host,
  ok: false,
  reason: 'сетевая ошибка: UND_ERR_CONNECT_TIMEOUT (2 попытки)',
  failureKind: 'transport',
  ssl: null,
});
const httpFail = (host, status = 500) => ({
  host,
  ok: false,
  reason: `HTTP ${status}`,
  failureKind: 'http',
  ssl: null,
});
const dnsFail = (host) => ({
  host,
  ok: false,
  reason: 'DNS не резолвится (ENOTFOUND)',
  failureKind: 'dns',
  ssl: null,
});

/** One run through the decision path, returning alerts plus the new state. */
function run(results, state = { hosts: {} }, renderDown = new Set()) {
  const storm = assessTransportStorm(results, { ...STORM_OPTS, previous: state.transportStorm });
  const out = reconcile({
    results,
    state,
    renderAlreadyDown: renderDown,
    storm,
    now: NOW,
    config: CONFIG_STUB,
  });
  state.transportStorm = { consecutive: storm.consecutive };
  return { ...out, storm, state };
}

test('the 2026-08-08 run: 7 of 10 hosts fail on transport → suppressed, nothing alerted', () => {
  const results = [...SATELLITES.map(ok), ...WHITELABELS.map(transportFail)];
  const { storm, pendingDown, suppressed, state } = run(results);

  assert.equal(storm.storm, true);
  assert.equal(storm.suppress, true);
  assert.equal(storm.escalated, false);
  assert.equal(pendingDown.length, 0, 'no SITE DOWN alert may be produced');
  assert.equal(suppressed.length, 7);

  for (const host of WHITELABELS) {
    assert.equal(state.hosts[host].down, false, `${host} must not be marked down`);
    assert.equal(state.hosts[host].fails, 0, `${host} fail counter must not advance`);
    // The observation is still kept, which is what was missing from the state
    // file before: the reason only ever existed in the Telegram message.
    assert.match(state.hosts[host].lastReason, /UND_ERR_CONNECT_TIMEOUT/);
    assert.equal(state.hosts[host].lastFailureKind, 'transport');
  }
});

test('the next clean tick sends no phantom SITE RECOVERED', () => {
  const stormRun = run([...SATELLITES.map(ok), ...WHITELABELS.map(transportFail)]);
  const { recovered, pendingDown } = run(
    [...SATELLITES.map(ok), ...WHITELABELS.map(ok)],
    stormRun.state
  );

  assert.equal(pendingDown.length, 0);
  assert.equal(recovered.length, 0, 'nothing was down, so nothing may "recover"');
});

test('a second consecutive storming run escalates and alerts', () => {
  const results = [...SATELLITES.map(ok), ...WHITELABELS.map(transportFail)];
  const first = run(results);
  assert.equal(first.storm.suppress, true);

  const second = run(results, first.state);
  assert.equal(second.storm.suppress, false);
  assert.equal(second.storm.escalated, true);
  assert.equal(second.pendingDown.length, 7, 'a real fleet-wide outage still pages, one tick later');
});

test('a genuine failure mixed into a storm is never suppressed', () => {
  const results = [
    ok(SATELLITES[0]),
    ok(SATELLITES[1]),
    httpFail(SATELLITES[2], 502),
    ...WHITELABELS.map(transportFail),
  ];
  const { pendingDown, suppressed } = run(results);

  assert.deepEqual(
    pendingDown.map((r) => r.host),
    [SATELLITES[2]],
    'the HTTP 502 must alert immediately even mid-storm'
  );
  assert.equal(suppressed.length, 7);
});

test('a single host failing on transport is a normal outage and alerts at once', () => {
  const results = [
    ...SATELLITES.map(ok),
    transportFail(WHITELABELS[0]),
    ...WHITELABELS.slice(1).map(ok),
  ];
  const { storm, pendingDown } = run(results);

  assert.equal(storm.storm, false);
  assert.deepEqual(pendingDown.map((r) => r.host), [WHITELABELS[0]]);
});

test('mass DNS death is not transport-class and still alerts immediately', () => {
  const results = [...SATELLITES.map(ok), ...WHITELABELS.map(dnsFail)];
  const { storm, pendingDown } = run(results);

  assert.equal(storm.storm, false, 'an authoritative NXDOMAIN cannot come from our egress');
  assert.equal(pendingDown.length, 7);
});

test('the absolute floor stops a tiny fleet from suppressing a real outage', () => {
  const results = [ok('a.example.com'), transportFail('b.example.com')];
  const { storm, pendingDown } = run(results);

  // 1 of 2 clears the 50% ratio but not the 3-host floor: on a fleet this small
  // "half of them" is one site, so the shared-cause signal does not exist.
  assert.equal(storm.storm, false);
  assert.equal(pendingDown.length, 1);
});

test('a host already down stays down through a storm, silently', () => {
  const state = {
    hosts: {
      [WHITELABELS[0]]: {
        fails: 3,
        down: true,
        downSince: '2026-08-07T01:09:06.717Z',
        lastAlertAt: '2026-08-07T01:09:06.717Z',
        lastSslAlertAt: null,
        lastReason: 'HTTP 503',
        lastFailureKind: 'http',
      },
    },
  };
  const results = [...SATELLITES.map(ok), ...WHITELABELS.map(transportFail)];
  const { pendingDown, recovered, state: after } = run(results, state);

  assert.equal(pendingDown.length, 0);
  assert.equal(recovered.length, 0);
  assert.equal(after.hosts[WHITELABELS[0]].down, true, 'an open incident is not closed by a storm');
  assert.equal(after.hosts[WHITELABELS[0]].downSince, '2026-08-07T01:09:06.717Z');
});

test('storm state resets after a clean run so blips do not accumulate', () => {
  const stormRun = run([...SATELLITES.map(ok), ...WHITELABELS.map(transportFail)]);
  assert.equal(stormRun.storm.consecutive, 1);

  const clean = run([...SATELLITES.map(ok), ...WHITELABELS.map(ok)], stormRun.state);
  assert.equal(clean.storm.consecutive, 0);

  // A later, unrelated blip is therefore absorbed again rather than escalating
  // on the strength of a storm from hours earlier.
  const later = run([...SATELLITES.map(ok), ...WHITELABELS.map(transportFail)], clean.state);
  assert.equal(later.storm.suppress, true);
});

test('render-tier dedup still marks a host down without a second alert', () => {
  const results = [...SATELLITES.map(ok), httpFail(WHITELABELS[0]), ...WHITELABELS.slice(1).map(ok)];
  const { pendingDown, state } = run(results, { hosts: {} }, new Set([WHITELABELS[0]]));

  assert.equal(pendingDown.length, 0, 'render already reported this incident');
  assert.equal(state.hosts[WHITELABELS[0]].down, true);
});
