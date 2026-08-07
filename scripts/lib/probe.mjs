import dns from 'node:dns/promises';
import tls from 'node:tls';
import { CONFIG, FAILURE_SIGNATURES, USER_AGENT } from './config.mjs';

/**
 * Public resolvers queried alongside the runner's own. A nameserver
 * misconfiguration often breaks resolution for only some of the internet, so a
 * single resolver cannot tell you the domain is reachable for your customers.
 */
const RESOLVERS = [
  { name: 'system', servers: null },
  { name: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'] },
  { name: 'Google', servers: ['8.8.8.8', '8.8.4.4'] },
  { name: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'] },
];

/** Authoritative "this name does not exist" codes, as opposed to transport noise. */
const AUTHORITATIVE_MISS = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

async function resolveWith(host, servers) {
  const resolver = servers ? new dns.Resolver({ timeout: 5000, tries: 2 }) : dns;
  if (servers) resolver.setServers(servers);
  try {
    const v4 = await resolver.resolve4(host);
    if (v4.length > 0) return { state: 'ok', addresses: v4 };
  } catch (err) {
    if (!AUTHORITATIVE_MISS.has(err.code)) return { state: 'error', code: err.code };
  }
  try {
    const v6 = await resolver.resolve6(host);
    if (v6.length > 0) return { state: 'ok', addresses: v6 };
    return { state: 'miss', code: 'ENODATA' };
  } catch (err) {
    return AUTHORITATIVE_MISS.has(err.code)
      ? { state: 'miss', code: err.code }
      : { state: 'error', code: err.code };
  }
}

/**
 * Resolve the host through every resolver in RESOLVERS.
 *
 * A host that no resolver can find is dead — this is what caught
 * frameless.london-tickets.uk. A host that resolves on some resolvers but not
 * others is a nameserver problem: the site is up for part of the internet and
 * invisible to the rest, which is worse than a clean outage because nobody
 * notices. Transport errors (timeouts, refused) are treated as noise unless
 * every resolver hits one, so a rate-limited public resolver cannot raise a
 * false alarm on its own.
 */
export async function checkDns(host) {
  const results = await Promise.all(
    RESOLVERS.map(async (r) => ({ name: r.name, ...(await resolveWith(host, r.servers)) }))
  );

  const ok = results.filter((r) => r.state === 'ok');
  const missing = results.filter((r) => r.state === 'miss');
  const errored = results.filter((r) => r.state === 'error');

  if (ok.length === 0) {
    const code = missing[0]?.code || errored[0]?.code || 'no records';
    return { ok: false, addresses: [], code, partial: false };
  }

  if (missing.length > 0) {
    return {
      ok: false,
      addresses: ok[0].addresses,
      code: missing[0].code,
      partial: true,
      resolvedBy: ok.map((r) => r.name),
      failedOn: missing.map((r) => r.name),
    };
  }

  return { ok: true, addresses: ok[0].addresses, partial: false, degraded: errored.map((r) => r.name) };
}

/** Read the peer certificate and report days until expiry. */
export function checkSsl(host) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: CONFIG.timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          resolve({ ok: false, reason: 'no certificate presented' });
          return;
        }
        const validTo = new Date(cert.valid_to);
        const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
        resolve({
          ok: daysLeft > 0,
          daysLeft,
          validTo: validTo.toISOString().slice(0, 10),
          issuer: cert.issuer?.O ?? 'unknown',
        });
      }
    );
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, reason: 'TLS handshake timed out' });
    });
    socket.on('error', (err) => {
      resolve({ ok: false, reason: `TLS error: ${err.code || err.message}` });
    });
  });
}

/**
 * Cheap HTTP probe.
 *
 * Satellites on *.platinumlist.net sit behind Cloudflare + Queue-it
 * ("protectallsite"), which 302-redirects datacentre IPs to
 * queue.platinumlist.net for HTML requests. /wp-json/ and /robots.txt are
 * NOT queue-protected, so each target carries its own `probe` path — that
 * keeps the fast tier free of Queue-it false positives.
 */
export async function checkHttp(host, probePath) {
  const url = `https://${host}${probePath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    });
    const ms = Date.now() - started;
    const body = (await res.text()).slice(0, 20000);
    const lower = body.toLowerCase();
    const signature = FAILURE_SIGNATURES.find((s) => lower.includes(s));

    if (res.status >= 500) return { ok: false, status: res.status, ms, reason: `HTTP ${res.status}` };
    if (res.status >= 400) return { ok: false, status: res.status, ms, reason: `HTTP ${res.status}` };
    if (signature) return { ok: false, status: res.status, ms, reason: `страница содержит "${signature}"` };
    if (body.trim().length === 0) return { ok: false, status: res.status, ms, reason: 'пустой ответ' };

    // A satellite whose Queue-it redirect leaked into a non-HTML probe means
    // the probe path is wrong, not that the site is down. Surface it as a config warning.
    if (res.url.includes('queue.platinumlist.net')) {
      return { ok: true, status: res.status, ms, warn: 'probe path попал в Queue-it — нужно поправить targets.json' };
    }

    return { ok: true, status: res.status, ms, bytes: body.length };
  } catch (err) {
    const ms = Date.now() - started;
    const reason =
      err.name === 'AbortError'
        ? `таймаут >${CONFIG.timeoutMs / 1000}с`
        : `сетевая ошибка: ${err.cause?.code || err.code || err.name}`;
    return { ok: false, status: null, ms, reason };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full fast-tier probe for one host.
 *
 * Retries immediately (CONFIG.retriesWithinRun) before reporting a failure.
 * That is what makes "alert on the first run" safe: a single Cloudflare reset
 * or DNS hiccup is absorbed here, within seconds, rather than by waiting for
 * the next hourly tick.
 */
export async function probeHost(target) {
  const attempts = Math.max(1, CONFIG.retriesWithinRun);
  let last;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const dnsResult = await checkDns(target.host);
    if (!dnsResult.ok) {
      const reason = dnsResult.partial
        ? `DNS отвечает не везде: работает через ${dnsResult.resolvedBy.join(', ')}, ` +
          `не находят ${dnsResult.failedOn.join(', ')} (${dnsResult.code}) — часть пользователей сайт не откроет`
        : `DNS не резолвится (${dnsResult.code || 'no records'})`;
      last = {
        host: target.host,
        type: target.type,
        traffic: target.traffic,
        ok: false,
        reason,
        attempts: attempt,
        ssl: null,
      };
    } else {
      const [http, ssl] = await Promise.all([
        checkHttp(target.host, target.probe),
        checkSsl(target.host),
      ]);
      last = {
        host: target.host,
        type: target.type,
        traffic: target.traffic,
        ok: http.ok,
        reason: http.ok ? null : http.reason,
        warn: http.warn ?? null,
        status: http.status,
        ms: http.ms,
        attempts: attempt,
        ssl,
      };
    }

    if (last.ok) return last;
    if (attempt < attempts) await sleep(CONFIG.retryDelayMs);
  }

  last.reason = `${last.reason} (${last.attempts} попытк${last.attempts === 1 ? 'а' : 'и'})`;
  return last;
}

/** Run probes with a bounded worker pool. */
export async function probeAll(targets, concurrency = CONFIG.concurrency) {
  const queue = [...targets];
  const results = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const target = queue.shift();
      results.push(await probeHost(target));
    }
  });
  await Promise.all(workers);
  return results;
}
