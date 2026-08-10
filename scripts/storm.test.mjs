/**
 * Tests for transport-storm suppression — the render tier's own guard.
 *
 * The availability tier dropped this in favour of lib/control.mjs, which asks
 * the network directly instead of inferring from how many hosts failed. The
 * render tier keeps it because it has a second shared resource a control probe
 * cannot see: the runner's CPU. The README records five concurrent Chromium tabs
 * starving each other until nine healthy whitelabels all blew the navigation
 * timeout together, with the network fine the whole time. Only the fleet-wide
 * view catches that, so the share threshold is still the right instrument here.
 *
 * These tests cover the judgement in isolation. The render tier suppresses on
 * either this or a blind egress; the connectivity half lives in control.test.mjs.
 *
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTransportStorm } from './lib/storm.mjs';

const OPTS = { minHosts: 3, ratio: 0.5, maxConsecutiveRuns: 1 };

const ok = (host) => ({ host, ok: true });
const timedOut = (host) => ({ host, ok: false, failureKind: 'transport' });
const httpFail = (host) => ({ host, ok: false, failureKind: 'http' });

const fleet = (n, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}.example.com`);

test('most of the fleet timing out together is the runner, not the fleet', () => {
  const hosts = fleet(10);
  const results = [...hosts.slice(0, 9).map(timedOut), ...hosts.slice(9).map(ok)];
  const storm = assessTransportStorm(results, OPTS);

  assert.equal(storm.storm, true);
  assert.equal(storm.suppress, true);
  assert.equal(storm.escalated, false);
  assert.equal(storm.hosts.length, 9);
});

test('a second consecutive starving run escalates and alerts', () => {
  const hosts = fleet(10);
  const results = [...hosts.slice(0, 9).map(timedOut), ...hosts.slice(9).map(ok)];

  const first = assessTransportStorm(results, OPTS);
  const second = assessTransportStorm(results, { ...OPTS, previous: first });

  assert.equal(second.suppress, false);
  assert.equal(second.escalated, true, 'still broken on the next tick is no longer a blip');
});

test('a clean run resets the counter so blips do not accumulate', () => {
  const hosts = fleet(10);
  const storming = [...hosts.slice(0, 9).map(timedOut), ...hosts.slice(9).map(ok)];

  const first = assessTransportStorm(storming, OPTS);
  const clean = assessTransportStorm(hosts.map(ok), { ...OPTS, previous: first });
  assert.equal(clean.consecutive, 0);

  const later = assessTransportStorm(storming, { ...OPTS, previous: clean });
  assert.equal(later.suppress, true, 'an unrelated blip hours later is absorbed again');
});

test('one slow page is a normal failure', () => {
  const hosts = fleet(10);
  const results = [timedOut(hosts[0]), ...hosts.slice(1).map(ok)];

  assert.equal(assessTransportStorm(results, OPTS).storm, false);
});

test('the absolute floor stops a tiny fleet from suppressing a real outage', () => {
  // 1 of 2 clears the 50% ratio but not the 3-host floor: on a fleet this small
  // "half of them" is one site, so the shared-cause signal does not exist.
  const results = [ok('a.example.com'), timedOut('b.example.com')];

  assert.equal(assessTransportStorm(results, OPTS).storm, false);
});

test('HTTP failures are not storm-eligible however many there are', () => {
  const hosts = fleet(10);
  const storm = assessTransportStorm(hosts.map(httpFail), OPTS);

  assert.equal(storm.storm, false, 'a status code came back, so the tab was not starved');
});

test('an empty run cannot be a storm', () => {
  const storm = assessTransportStorm([], OPTS);
  assert.equal(storm.storm, false);
  assert.equal(storm.share, 0);
});
