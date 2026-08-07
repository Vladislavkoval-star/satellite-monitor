#!/usr/bin/env python3
"""Rebuild targets.json from GA4.

Runs weekly. Pulls hostname-level sessions from the configured GA4 property,
picks the busiest satellites and whitelabels, drops geo subdomains of the main
platform and any excluded host, then works out the cheapest queue-free probe
path for each one.

Configuration comes from the environment: GA4_SERVICE_ACCOUNT_JSON and
GA4_PROPERTY_ID are secrets, EXCLUDED_HOSTS is a repository variable. Session
counts are reduced to a coarse band before anything is written to disk, so no
per-site traffic figure is ever committed.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import (
    DateRange,
    Dimension,
    Metric,
    OrderBy,
    RunReportRequest,
)
from google.oauth2 import service_account

ROOT = Path(__file__).resolve().parent.parent
TARGETS_FILE = ROOT / "targets.json"

# Monitor the N busiest satellites and the N busiest whitelabels by 30-day
# traffic. A fixed count rather than a traffic threshold keeps the fleet size —
# and therefore the CI cost and the run time — predictable as traffic moves.
TOP_N_PER_TYPE = int(os.environ.get("TOP_N_PER_TYPE", "5"))
# buy.* and checkout.* subdomains are excluded: they are checkout screens rather
# than storefronts, and are not monitored in this configuration.
EXCLUDE_MONEY_PATH = os.environ.get("EXCLUDE_MONEY_PATH", "1") == "1"
GA4_PROPERTY_ID = os.environ.get("GA4_PROPERTY_ID", "")

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Geo subdomains of the main platform. Monitored by the infrastructure team,
# not by this repo — keeping them out avoids duplicate paging.
GEO_SUBDOMAINS = set(
    """dubai abu-dhabi sharjah ajman rak uaq fujairah al-ain riyadh jeddah abha khobar dammam
    taif aljubail madina makkah tabuk hail jizan buraydah yanbu arar dhahran al-qatif al-ahsa
    alqunfudhah albaha alhada namas tanomah al-haridhah oniza alula khobarseason doha manama
    muscat salalah nizwa sur khasab kuwait beirut byblos amman jordan cairo giza sharm hurghada
    alexandria istanbul antalya ankara izmir bursa trabzon samsun cappadocia eskisehir-turkey
    paris madrid barcelona malaga milan amsterdam rotterdam the-hague zandvoort kaatsheuvel
    kinderdijk london london-shows edinburgh birmingham manchester liverpool bath york oxford
    cambridge brighton westminster towcester united-kingdom europe america asia germany hungary
    serbia malta cyprus limassol marrakesh casablanca rabat fez dakhla morocco ibiza baku yerevan
    almaty tbilisi montreal sao-paulo metromanila mumbaimaharashtra kualalumpur bangkok hongkong
    macau colombo hochiminhcity spielberg monza suzuka""".split()
)


def classify(host: str) -> str:
    if host.startswith("(") or not host.strip():
        return "skip"
    if host.endswith(".loc") or "translate.goog" in host or "workable.com" in host:
        return "skip"
    if host in {"platinumlist.net", "www.platinumlist.net"}:
        return "main"
    if host.startswith("queue."):
        return "infra"
    if host.endswith(".platinumlist.net"):
        sub = host[: -len(".platinumlist.net")]
        return "geo" if sub in GEO_SUBDOMAINS else "satellite"
    return "whitelabel"


def fetch_sessions(client: BetaAnalyticsDataClient, days: int) -> dict[str, int]:
    request = RunReportRequest(
        property=f"properties/{GA4_PROPERTY_ID}",
        dimensions=[Dimension(name="hostName")],
        metrics=[Metric(name="sessions")],
        date_ranges=[DateRange(start_date=f"{days}daysAgo", end_date="yesterday")],
        order_bys=[OrderBy(metric=OrderBy.MetricOrderBy(metric_name="sessions"), desc=True)],
        limit=1000,
    )
    report = client.run_report(request)
    return {row.dimension_values[0].value: int(row.metric_values[0].value) for row in report.rows}


QUEUE_HOST = "queue.platinumlist.net"


def probe_once(host: str, path: str) -> tuple[object, str, str]:
    """Return (status, content-type, final-url), following redirects.

    Redirects must be followed: several satellites 301 to a canonical host, and
    treating that as a failure would pin a wrong probe path. What matters is
    whether the request ends up in the Queue-it waiting room.
    """
    context = ssl.create_default_context()
    try:
        response = urllib.request.urlopen(
            urllib.request.Request(f"https://{host}{path}", headers={"User-Agent": USER_AGENT}),
            timeout=20,
            context=context,
        )
        return response.status, response.headers.get("content-type", ""), response.geturl()
    except urllib.error.HTTPError as exc:
        return exc.code, "", ""
    except Exception as exc:  # noqa: BLE001 - any transport failure means "try next path"
        return f"ERR:{type(exc).__name__}", "", ""


def pick_probe_path(target: dict) -> dict:
    """Prefer /wp-json/ (proves WordPress and its DB are alive), then /, then /robots.txt.

    HTML requests to *.platinumlist.net are Queue-it protected, so a plain /
    check would 302 into the waiting room and read as a false failure.
    """
    host = target["host"]
    # Retry each candidate path: a transient blip during generation would
    # otherwise pin a bad probe path into targets.json until the next refresh.
    for path in ("/wp-json/", "/", "/robots.txt"):
        for _ in range(2):
            status, content_type, final_url = probe_once(host, path)
            if status != 200 or QUEUE_HOST in final_url:
                continue
            if path == "/wp-json/" and "json" not in content_type:
                continue
            target["probe"] = path
            return target
    target["probe"] = "/"
    target["probe_unverified"] = True
    return target


HIGH_TRAFFIC_SESSIONS_30D = int(os.environ.get("HIGH_TRAFFIC_SESSIONS_30D", "500"))


def strip_traffic_figures(target: dict) -> dict:
    """Replace raw GA4 session counts with a coarse band before writing to disk.

    Per-site session numbers are commercial data and the repository is public.
    The only thing the monitor needs them for is deciding whether an empty
    catalogue is worth paging about, and a two-value band answers that.
    """
    cleaned = {k: v for k, v in target.items() if k not in ("s30", "s90")}
    cleaned["traffic"] = "high" if target.get("s30", 0) >= HIGH_TRAFFIC_SESSIONS_30D else "low"
    return cleaned


def main() -> int:
    raw_credentials = os.environ.get("GA4_SERVICE_ACCOUNT_JSON")
    if not raw_credentials:
        print("Missing required environment variable: GA4_SERVICE_ACCOUNT_JSON", file=sys.stderr)
        return 1
    if not GA4_PROPERTY_ID:
        print("Missing required environment variable: GA4_PROPERTY_ID", file=sys.stderr)
        return 1

    credentials = service_account.Credentials.from_service_account_info(
        json.loads(raw_credentials),
        scopes=["https://www.googleapis.com/auth/analytics.readonly"],
    )
    client = BetaAnalyticsDataClient(credentials=credentials)

    sessions_30d = fetch_sessions(client, 30)
    sessions_90d = fetch_sessions(client, 90)

    # Hosts that appear in the analytics property but are not ours to monitor.
    # Kept in a repository variable rather than a committed file so the list is
    # configuration, not source.
    denylist = {h.strip() for h in os.environ.get("EXCLUDED_HOSTS", "").split(",") if h.strip()}

    by_kind: dict[str, list[dict]] = {"satellite": [], "whitelabel": []}
    for host in set(sessions_30d) | set(sessions_90d):
        kind = classify(host)
        if kind not in by_kind or host in denylist:
            continue
        if EXCLUDE_MONEY_PATH and host.startswith(("buy.", "checkout.")):
            continue
        by_kind[kind].append(
            {
                "host": host,
                "type": kind,
                "s30": sessions_30d.get(host, 0),
                "s90": sessions_90d.get(host, 0),
            }
        )
    # Raw session counts are commercial data and must not survive into the
    # committed file — see strip_traffic_figures below.

    candidates = []
    for kind, hosts in by_kind.items():
        hosts.sort(key=lambda item: -item["s30"])
        candidates.extend(hosts[:TOP_N_PER_TYPE])
    candidates.sort(key=lambda item: -item["s30"])
    with ThreadPoolExecutor(max_workers=8) as pool:
        targets = list(pool.map(pick_probe_path, candidates))

    payload = {
        "generated_from": "GA4",
        "rule": f"top {TOP_N_PER_TYPE} satellites + top {TOP_N_PER_TYPE} whitelabels by 30-day sessions",
        "targets": [strip_traffic_figures(t) for t in targets],
    }
    TARGETS_FILE.write_text(f"{json.dumps(payload, indent=1)}\n")

    satellites = sum(1 for t in targets if t["type"] == "satellite")
    whitelabels = sum(1 for t in targets if t["type"] == "whitelabel")
    print(f"targets: {len(targets)} (satellites {satellites}, whitelabels {whitelabels})")
    for t in payload["targets"]:
        print(f"  {t['traffic']:<6} {t['type']:<10} {t['host']:<48} probe={t['probe']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
