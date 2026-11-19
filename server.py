"""AI Frontier Desk - server.

Run:  .venv/bin/python server.py      (http://127.0.0.1:8766)
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import crawl

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("desk.server")

ROOT = Path(__file__).parent
DATA_PATH = ROOT / "data" / "sectors.json"
CACHE_PATH = ROOT / "cache.json"
PORT = 8766
NEWS_EVERY = 15 * 60
CAPS_EVERY = 60 * 60
KEEP_DAYS = 10
MAX_ITEMS = 1500


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.data = json.loads(DATA_PATH.read_text())
        self.data_mtime = DATA_PATH.stat().st_mtime
        self.clf = crawl.Classifier(self.data)
        self.items: list[dict] = []
        self.feed_status: dict = {}
        self.caps: dict = {}
        self.company_news: dict[str, dict] = {}
        self.last_news = 0.0
        self.last_caps = 0.0
        self.refreshing = False
        self._load()

    def _load(self):
        if CACHE_PATH.exists():
            try:
                c = json.loads(CACHE_PATH.read_text())
                self.items = c.get("items", [])
                self.feed_status = c.get("feed_status", {})
                self.caps = c.get("caps", {})
                self.company_news = c.get("company_news", {})
                self.last_news = c.get("last_news", 0)
                self.last_caps = c.get("last_caps", 0)
                self.items = [self.clf.classify(i) for i in self.items]
                log.info("cache: %d items (re-classified)", len(self.items))
            except Exception as e:
                log.warning("cache load failed: %s", e)

    def save(self):
        with self.lock:
            snap = {"items": self.items, "feed_status": self.feed_status, "caps": self.caps,
                    "company_news": self.company_news, "last_news": self.last_news, "last_caps": self.last_caps}
        tmp = CACHE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(snap))
        tmp.replace(CACHE_PATH)

    def maybe_reload_data(self):
        m = DATA_PATH.stat().st_mtime
        if m != self.data_mtime:
            try:
                d = json.loads(DATA_PATH.read_text())
                with self.lock:
                    self.data, self.data_mtime = d, m
                    self.clf = crawl.Classifier(d)
                    self.items = [self.clf.classify(i) for i in self.items]
                log.info("reloaded data/sectors.json")
            except Exception as e:
                log.warning("data reload failed: %s", e)

    def public_tickers(self) -> list[str]:
        return sorted({c["ticker"] for c in self.data["companies"].values() if c.get("ticker")})

    # ---- refresh
    def refresh_news(self):
        if self.refreshing:
            return
        self.refreshing = True
        try:
            t0 = time.time()
            items, status = crawl.fetch_all_feeds()
            items += crawl.fetch_arxiv()
            with self.lock:
                classified = [self.clf.classify(i) for i in items]
                merged = crawl.dedupe(classified + self.items)
                cutoff = time.time() - KEEP_DAYS * 86400
                self.items = [i for i in merged if i["ts"] >= cutoff][:MAX_ITEMS]
                self.feed_status = status
                self.last_news = time.time()
            self.save()
            log.info("news refresh: %d new / %d total in %.1fs", len(items), len(self.items), time.time() - t0)
        except Exception as e:
            log.exception("news refresh failed: %s", e)
        finally:
            self.refreshing = False

    def refresh_caps(self):
        try:
            caps = crawl.fetch_market_caps(self.public_tickers())
            if caps:
                with self.lock:
                    self.caps.update(caps)
                    self.last_caps = time.time()
                self.save()
                log.info("market caps: %d tickers", len(caps))
        except Exception as e:
            log.warning("caps failed: %s", e)

    def get_company_news(self, cid: str) -> list[dict]:
        c = self.data["companies"].get(cid)
        if not c:
            raise HTTPException(404, "unknown company")
        cached = self.company_news.get(cid)
        if cached and time.time() - cached["ts"] < 30 * 60:
            return cached["items"]
        items = crawl.fetch_company_news(c["name"], c.get("keywords", []))
        items = [self.clf.classify(i) for i in items]
        for i in items:
            if cid not in i["companies"]:
                i["companies"].insert(0, cid)
        with self.lock:
            self.company_news[cid] = {"ts": time.time(), "items": items}
        return items


store = Store()
app = FastAPI(title="AI Frontier Desk")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


def scheduler():
    while True:
        try:
            store.maybe_reload_data()
            now = time.time()
            if now - store.last_news > NEWS_EVERY:
                store.refresh_news()
            if now - store.last_caps > CAPS_EVERY:
                threading.Thread(target=store.refresh_caps, daemon=True).start()
        except Exception as e:
            log.exception("scheduler: %s", e)
        time.sleep(30)


threading.Thread(target=scheduler, daemon=True).start()


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/data")
def api_data():
    with store.lock:
        return JSONResponse({"as_of": store.data["as_of"], "disclaimer": store.data["disclaimer"],
                             "sectors": store.data["sectors"], "companies": store.data["companies"],
                             "connections": store.data["connections"], "caps": store.caps})


@app.get("/api/feed")
def api_feed(sector: str | None = None, company: str | None = None, kind: str | None = None,
             q: str | None = None, limit: int = Query(80, le=400)):
    with store.lock:
        items = store.items
    if sector and sector != "all":
        items = [i for i in items if sector in i["sectors"]]
    elif not company and not q:
        items = [i for i in items if i["sectors"] != ["general"]]
    if company:
        items = [i for i in items if company in i["companies"]]
    if kind == "funding":
        items = [i for i in items if i.get("funding")]
    elif kind == "frontier":
        items = [i for i in items if i.get("frontier")]
    elif kind == "news":
        items = [i for i in items if not i.get("frontier") and not i.get("funding")]
    elif kind == "research":
        items = [i for i in items if i["kind"] == "research"]
    if q:
        ql = q.lower()
        items = [i for i in items if ql in i["title"].lower() or ql in i["summary"].lower()]
    return JSONResponse({"items": items[:limit], "total": len(items)})


@app.get("/api/funding")
def api_funding(sector: str | None = None, limit: int = 120):
    with store.lock:
        items = [i for i in store.items if i.get("funding")]
    if sector and sector != "all":
        items = [i for i in items if sector in i["sectors"]]
    total = sum((i["funding"].get("amount_usd_m") or 0) for i in items)
    return JSONResponse({"items": items[:limit], "total_usd_m": round(total), "count": len(items)})


@app.get("/api/company/{cid}/news")
def api_company_news(cid: str):
    return JSONResponse({"items": store.get_company_news(cid)})


@app.get("/api/status")
def api_status():
    with store.lock:
        return JSONResponse({"items": len(store.items), "last_news": store.last_news, "last_caps": store.last_caps,
                             "refreshing": store.refreshing, "feeds": store.feed_status, "caps": len(store.caps)})


@app.post("/api/refresh")
def api_refresh():
    threading.Thread(target=store.refresh_news, daemon=True).start()
    threading.Thread(target=store.refresh_caps, daemon=True).start()
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
