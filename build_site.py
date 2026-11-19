#!/usr/bin/env python3
"""Build the static site (GitHub Pages) for AI Frontier Desk.

Crawls every feed, merges with the previous build fetched from the live site (so history
accumulates across runs), refreshes market caps and a rolling slice of per-company Google
News, and writes everything as plain JSON under <out>/data for the front end.

  python build_site.py --out site --site-url https://maplesyxy.github.io/ai-frontier-desk
"""
from __future__ import annotations

import argparse
import json
import logging
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

import crawl

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("desk.build")

ROOT = Path(__file__).parent
DATA_PATH = ROOT / "data" / "sectors.json"
CAPS_SEED = ROOT / "data" / "caps_seed.json"
LOCAL_CACHE = ROOT / "cache.json"
KEEP_DAYS = 10
MAX_ITEMS = 1500
COMPANY_NEWS_TTL = 6 * 3600


def fetch_prev(site_url: str | None, path: str):
    """Previous build output from the live site; None if unavailable."""
    if not site_url:
        return None
    url = f"{site_url.rstrip('/')}/{path}"
    try:
        r = httpx.get(url, timeout=30, headers={"Cache-Control": "no-cache", **crawl.UA}, follow_redirects=True)
        if r.status_code == 200:
            return r.json()
        log.info("prev %s: HTTP %s", path, r.status_code)
    except Exception as e:
        log.warning("prev %s failed: %s", path, e)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site")
    ap.add_argument("--site-url", default="")
    ap.add_argument("--no-caps", action="store_true")
    ap.add_argument("--company-news", type=int, default=30, help="companies to refresh this run")
    args = ap.parse_args()
    now = time.time()

    data = json.loads(DATA_PATH.read_text())
    clf = crawl.Classifier(data)

    # ---- previous state: live site, else local server cache, else empty
    prev = fetch_prev(args.site_url, "data/feed.json")
    company_news = fetch_prev(args.site_url, "data/company_news.json") if prev else None
    if prev is None and LOCAL_CACHE.exists():
        try:
            c = json.loads(LOCAL_CACHE.read_text())
            prev = {"items": c.get("items", []), "caps": c.get("caps", {}), "last_caps": c.get("last_caps", 0)}
            company_news = c.get("company_news", {})
            log.info("seeded from local cache.json")
        except Exception as e:
            log.warning("local cache unusable: %s", e)
    prev = prev or {}
    company_news = company_news or {}
    log.info("previous: %d items, %d caps, %d company news", len(prev.get("items", [])), len(prev.get("caps", {})), len(company_news))

    # ---- news
    t0 = time.time()
    items, status = crawl.fetch_all_feeds()
    items += crawl.fetch_arxiv()
    classified = [clf.classify(i) for i in items + prev.get("items", [])]
    merged = crawl.dedupe(classified)
    cutoff = now - KEEP_DAYS * 86400
    items = [i for i in merged if i["ts"] >= cutoff][:MAX_ITEMS]
    log.info("news: %d fetched, %d kept, %d/%d feeds ok, %.1fs", len(classified), len(items),
             sum(1 for s in status.values() if s["ok"]), len(status), time.time() - t0)

    # ---- market caps: seed < previous < fresh
    caps = {}
    if CAPS_SEED.exists():
        caps.update(json.loads(CAPS_SEED.read_text()))
    caps.update(prev.get("caps", {}))
    last_caps = prev.get("last_caps", 0)
    if not args.no_caps:
        tickers = sorted({c["ticker"] for c in data["companies"].values() if c.get("ticker")})
        try:
            got = crawl.fetch_market_caps(tickers)
        except Exception as e:
            got = {}
            log.warning("caps failed: %s", e)
        if got:
            caps.update(got)
            last_caps = now
        log.info("caps: %d fresh / %d total", len(got), len(caps))

    # ---- per-company Google News: refresh the stalest N
    cids = sorted(data["companies"], key=lambda c: company_news.get(c, {}).get("ts", 0))
    todo = [c for c in cids if now - company_news.get(c, {}).get("ts", 0) > COMPANY_NEWS_TTL][: args.company_news]

    def one(cid):
        c = data["companies"][cid]
        try:
            got = crawl.fetch_company_news(c["name"], c.get("keywords", []))
        except Exception as e:
            log.debug("company news %s: %s", cid, e)
            return cid, None
        got = [clf.classify(i) for i in got]
        for i in got:
            if cid not in i["companies"]:
                i["companies"].insert(0, cid)
        return cid, got

    if todo:
        with ThreadPoolExecutor(max_workers=6) as ex:
            for cid, got in ex.map(one, todo):
                if got is None or (not got and company_news.get(cid, {}).get("items")):
                    continue
                company_news[cid] = {"ts": now, "items": got}
    log.info("company news: refreshed %d, %d/%d companies covered", len(todo), len(company_news), len(cids))

    # ---- write site
    out = ROOT / args.out
    if out.exists():
        shutil.rmtree(out)
    (out / "static").mkdir(parents=True)
    (out / "data" / "company").mkdir(parents=True)
    for f in (ROOT / "static").iterdir():
        if f.name == "index.html":
            shutil.copy(f, out / "index.html")
        else:
            shutil.copy(f, out / "static" / f.name)
    (out / ".nojekyll").write_text("")
    dump = lambda p, o: (out / p).write_text(json.dumps(o, separators=(",", ":")))
    dump("data/data.json", {"as_of": data["as_of"], "disclaimer": data["disclaimer"], "sectors": data["sectors"],
                            "companies": data["companies"], "connections": data["connections"], "caps": caps})
    dump("data/feed.json", {"items": items, "feed_status": status, "caps": caps,
                            "last_news": now, "last_caps": last_caps, "built": now})
    dump("data/company_news.json", company_news)
    for cid, v in company_news.items():
        dump(f"data/company/{cid}.json", {"ts": v["ts"], "items": v["items"]})
    dump("data/manifest.json", {"static": True, "built": now, "items": len(items)})
    log.info("wrote %s (%d items)", out, len(items))


if __name__ == "__main__":
    main()
