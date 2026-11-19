"""AI Frontier Desk - crawler.

Pulls RSS/Atom feeds (news, research, funding, company blogs), the arXiv API and
Google News per company, classifies every item into sectors and companies using
the curated keyword lists in data/sectors.json, and extracts funding events.
"""
from __future__ import annotations

import html
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import feedparser
import httpx

log = logging.getLogger("desk.crawl")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) ai-frontier-desk/0.1 (personal research dashboard)"}

# id, source name, url, kind (news|research|funding|company), default sectors
FEEDS = [
    ("techcrunch_ai", "TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/", "news", []),
    ("techcrunch_startups", "TechCrunch Startups", "https://techcrunch.com/category/startups/feed/", "funding", []),
    ("techcrunch_venture", "TechCrunch Venture", "https://techcrunch.com/category/venture/feed/", "funding", ["capital"]),
    ("crunchbase", "Crunchbase News", "https://news.crunchbase.com/feed/", "funding", ["capital"]),
    ("gnews_funding", "Google News: AI funding", "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=(AI+OR+%22artificial+intelligence%22)+startup+(raises+OR+raised+OR+valuation)+when:3d", "funding", ["capital"]),
    ("verge_ai", "The Verge AI", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", "news", []),
    ("venturebeat_ai", "VentureBeat AI", "https://venturebeat.com/category/ai/feed/", "news", []),
    ("mit_tr", "MIT Technology Review", "https://www.technologyreview.com/feed/", "news", []),
    ("ars_ai", "Ars Technica AI", "https://arstechnica.com/ai/feed/", "news", []),
    ("wired_ai", "Wired AI", "https://www.wired.com/feed/tag/ai/latest/rss", "news", []),
    ("ft_ai", "Financial Times AI", "https://www.ft.com/artificial-intelligence?format=rss", "news", []),
    ("bloomberg_tech", "Bloomberg Technology", "https://feeds.bloomberg.com/technology/news.rss", "news", []),
    ("cnbc_tech", "CNBC Technology", "https://www.cnbc.com/id/19854910/device/rss/rss.html", "news", []),
    ("247", "24/7 Wall St.", "https://247wallst.com/feed/", "news", []),
    ("hn", "Hacker News (100+ pts)", "https://hnrss.org/frontpage?points=100", "news", []),
    ("semianalysis", "SemiAnalysis", "https://semianalysis.com/feed/", "research", ["chips", "cloud"]),
    ("import_ai", "Import AI", "https://importai.substack.com/feed", "research", ["foundation"]),
    ("ieee_ai", "IEEE Spectrum AI", "https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss", "news", []),
    ("robotreport", "The Robot Report", "https://www.therobotreport.com/feed/", "news", ["robotics"]),
    ("statnews", "STAT News", "https://www.statnews.com/feed/", "news", ["health"]),
    ("tomshw", "Tom's Hardware", "https://www.tomshardware.com/feeds/all", "news", ["chips"]),
    ("openai", "OpenAI", "https://openai.com/news/rss.xml", "company", ["foundation"]),
    ("deepmind", "Google DeepMind", "https://deepmind.google/blog/rss.xml", "company", ["foundation"]),
    ("google_ai", "Google AI Blog", "https://blog.google/technology/ai/rss/", "company", ["foundation"]),
    ("nvidia", "NVIDIA Blog", "https://blogs.nvidia.com/feed/", "company", ["chips"]),
    ("microsoft", "Microsoft Blog", "https://blogs.microsoft.com/feed/", "company", ["enterprise"]),
    ("aws_ml", "AWS ML Blog", "https://aws.amazon.com/blogs/machine-learning/feed/", "company", ["cloud"]),
    ("hf_blog", "Hugging Face Blog", "https://huggingface.co/blog/feed.xml", "research", ["foundation"]),
    ("gnews_anthropic", "Google News: Anthropic", "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=Anthropic+Claude+when:3d", "news", ["foundation"]),
    ("gnews_meta", "Google News: Meta AI", "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=%22Meta+AI%22+OR+Llama+OR+%22Superintelligence+Labs%22+when:3d", "news", ["foundation"]),
    ("gnews_robotics", "Google News: humanoids & robotaxis", "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=humanoid+OR+robotaxi+OR+%22Physical+AI%22+when:3d", "news", ["robotics"]),
    ("gnews_health", "Google News: AI health", "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=(%22AI%22+OR+%22artificial+intelligence%22)+(FDA+OR+hospital+OR+%22drug+discovery%22+OR+clinical)+when:3d", "news", ["health"]),
    ("gnews_chips", "Google News: AI chips", "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=(Nvidia+OR+TSMC+OR+HBM+OR+%22AI+chip%22)+when:2d", "news", ["chips"]),
]

ARXIV_URL = ("https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL+OR+cat:cs.RO+OR+cat:cs.CV"
             "&sortBy=submittedDate&sortOrder=descending&max_results=60")

SECTOR_KEYWORDS = {
    "foundation": ["LLM", "large language model", "frontier model", "foundation model", "GPT", "Claude", "Gemini", "Llama", "Grok", "reasoning model", "open-weight", "open weights", "benchmark", "AGI", "superintelligence", "model release", "pretraining", "post-training", "transformer", "tokens"],
    "chips": ["GPU", "chip", "semiconductor", "accelerator", "TPU", "HBM", "foundry", "wafer", "lithography", "CoWoS", "Blackwell", "Rubin", "ASIC", "silicon", "Nvidia", "TSMC", "export control", "inference chip", "NPU"],
    "cloud": ["datacenter", "data center", "cloud", "neocloud", "compute capacity", "gigawatt", "GW", "Azure", "AWS", "Google Cloud", "OCI", "inference platform", "lakehouse", "GPU cloud", "hyperscaler", "capex", "power purchase"],
    "enterprise": ["enterprise", "copilot", "agent", "agentic", "coding assistant", "developer tool", "SaaS", "workflow", "automation", "CRM", "customer service", "legal AI", "vibe coding", "IDE", "MCP"],
    "robotics": ["robot", "humanoid", "robotaxi", "autonomous vehicle", "self-driving", "driverless", "autonomy", "FSD", "Waymo", "Optimus", "warehouse robot", "physical AI", "embodied", "drone", "lidar", "manipulation"],
    "health": ["health", "clinical", "hospital", "FDA", "drug", "biotech", "pharma", "patient", "medical", "protein", "molecule", "diagnos", "radiology", "oncology", "genomic", "EHR", "physician", "therapeutic"],
    "consumer": ["ChatGPT", "consumer", "app store", "chatbot", "assistant", "Siri", "Alexa", "image generation", "video generation", "voice", "music", "companion", "search engine", "browser", "subscribers", "users", "creator", "deepfake", "smart glasses"],
    "capital": ["raises", "raised", "funding", "Series A", "Series B", "Series C", "Series D", "Series E", "seed round", "valuation", "venture", "VC", "investors", "led by", "IPO", "acquisition", "acquires", "acquired", "term sheet", "secondary", "tender offer", "SPAC"],
}

MONEY = r"(?:(?:US)?[$€£]\s?\d|\d+(?:\.\d+)?\s?(?:million|billion|mn|bn|crore)\b|Rs\.?\s?\d)"
FUNDING_RE = re.compile(
    r"\b(?:raises|raised|raising|secures|secured|lands|nabs|bags|banks|closes|closed|pulls in|brings in)\s+(?:a\s+|an\s+|another\s+|fresh\s+|new\s+)?(?:" + MONEY + r"|\$|funding|seed|Series\s[A-H]\b|round|pre-seed|extension)"
    r"|\b(?:valuation|valued at|at a\s+" + MONEY + r"[^.]{0,20}valuation)"
    r"|\bSeries\s[A-H]\b|\bseed round\b|\bmega-?round\b|\bfunding round\b|\bled by\b|\btender offer\b|\bIPO\b|\bgoes public\b|\bfiles to go public\b"
    r"|\b(?:acquires|acquired|to acquire|acquisition of|buys)\b", re.I)
NOT_FUNDING_RE = re.compile(r"\braises? (?:questions?|concerns?|alarms?|doubts?|eyebrows|the bar|stakes|fears|red flags|prices?|rates?|forecast|guidance|outlook|target)\b|\bcloses? (?:below|above|at|down|up|higher|lower)\b", re.I)
AMOUNT_RE = re.compile(r"(?:US)?([$€£])\s?(\d{1,4}(?:[.,]\d{1,3})?)\s?(billion|million|bn|mn|B|M)\b", re.I)
ROUND_RE = re.compile(r"\b(pre-seed|seed|Series [A-H](?:\+| extension)?|growth round|bridge|mega-?round|tender offer|secondary|debt|IPO|acquisition)\b", re.I)
FRONTIER_RE = re.compile(r"\b(launches|launched|introduces|introducing|unveils|unveiled|releases|released|announces|debuts|open-sources|open sources|new model|state-of-the-art|SOTA|benchmark|breakthrough|paper|preprint|research|frontier|outperforms|beats|record)\b", re.I)
TAG_RE = re.compile(r"<[^>]+>")


def _clean(s: str | None, limit: int = 320) -> str:
    if not s:
        return ""
    s = html.unescape(TAG_RE.sub(" ", s))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit] + ("…" if len(s) > limit else "")


def _ts(entry) -> float:
    for k in ("published_parsed", "updated_parsed", "created_parsed"):
        v = entry.get(k)
        if v:
            try:
                return time.mktime(v) - time.timezone
            except Exception:
                pass
    for k in ("published", "updated"):
        v = entry.get(k)
        if v:
            try:
                return parsedate_to_datetime(v).timestamp()
            except Exception:
                try:
                    return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
                except Exception:
                    pass
    return time.time()


def _fetch(url: str, timeout: float = 25.0) -> bytes | None:
    try:
        r = httpx.get(url, headers=UA, timeout=timeout, follow_redirects=True)
        if r.status_code == 200:
            return r.content
        log.warning("%s -> HTTP %s", url[:80], r.status_code)
    except Exception as e:
        log.warning("%s -> %s", url[:80], e)
    return None


def _parse(content: bytes, source: str, kind: str, feed_id: str, default_sectors: list[str], limit: int = 40) -> list[dict]:
    feed = feedparser.parse(content)
    out = []
    for e in feed.entries[:limit]:
        link = e.get("link") or ""
        title = _clean(e.get("title"), 220)
        if not title or not link:
            continue
        summary = _clean(e.get("summary") or e.get("description") or (e.get("content") or [{}])[0].get("value"))
        src = source
        # Google News puts the real publisher in the source tag and appends " - Publisher" to titles
        if "news.google.com" in link or feed_id.startswith("gnews"):
            pub = (e.get("source") or {}).get("title")
            if pub:
                src = pub
                title = re.sub(r"\s+-\s+" + re.escape(pub) + r"$", "", title)
        out.append({
            "id": feed_id + ":" + str(abs(hash(link)) % 10**10),
            "title": title, "link": link, "summary": summary, "source": src, "feed": feed_id,
            "kind": kind, "ts": _ts(e), "sectors": [], "feed_sectors": list(default_sectors), "companies": [],
        })
    return out


def fetch_all_feeds(feeds=FEEDS) -> tuple[list[dict], dict]:
    items, status = [], {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(_fetch, url): (fid, name, url, kind, secs) for fid, name, url, kind, secs in feeds}
        for fut in as_completed(futs):
            fid, name, url, kind, secs = futs[fut]
            content = fut.result()
            if content:
                try:
                    got = _parse(content, name, kind, fid, secs)
                    items.extend(got)
                    status[fid] = {"name": name, "ok": True, "n": len(got)}
                except Exception as e:
                    status[fid] = {"name": name, "ok": False, "n": 0, "err": str(e)}
            else:
                status[fid] = {"name": name, "ok": False, "n": 0}
    return items, status


def fetch_arxiv() -> list[dict]:
    content = _fetch(ARXIV_URL)
    if not content:
        return []
    feed = feedparser.parse(content)
    out = []
    for e in feed.entries:
        cats = [t.get("term") for t in e.get("tags", [])]
        authors = ", ".join(a.get("name", "") for a in e.get("authors", [])[:4])
        out.append({
            "id": "arxiv:" + e.get("id", "").rsplit("/", 1)[-1],
            "title": _clean(e.get("title"), 220), "link": e.get("link"),
            "summary": _clean(e.get("summary"), 400), "source": "arXiv " + "/".join(c for c in cats[:2] if c),
            "feed": "arxiv", "kind": "research", "ts": _ts(e), "sectors": [], "feed_sectors": [], "companies": [], "authors": authors,
        })
    return out


def fetch_company_news(name: str, keywords: list[str], limit: int = 25) -> list[dict]:
    from urllib.parse import quote_plus
    q = " OR ".join(f'"{k}"' for k in keywords[:3]) if keywords else f'"{name}"'
    url = "https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q=" + quote_plus(q + " when:14d")
    content = _fetch(url, timeout=15)
    if not content:
        return []
    return _parse(content, "Google News", "news", "gnews_company", [], limit=limit)


# ---------- classification

class Classifier:
    def __init__(self, data: dict):
        self.data = data
        self.company_patterns: list[tuple[str, re.Pattern]] = []
        for cid, c in data["companies"].items():
            kws = sorted(set([c["name"]] + c.get("keywords", [])), key=len, reverse=True)
            kws = [k for k in kws if len(k) >= 3]
            # word-boundary match, case-sensitive for short/ambiguous tokens, else case-insensitive
            pats = []
            for k in kws:
                flags = 0 if (len(k) <= 5 or k.isupper()) else re.I
                pats.append((re.compile(r"(?<![\w$])" + re.escape(k) + r"(?![\w-])", flags), k))
            self.company_patterns.append((cid, pats))
        self.company_sectors: dict[str, list[str]] = {}
        for s in data["sectors"]:
            for m in s["members"]:
                self.company_sectors.setdefault(m["id"], []).append(s["id"])
        self.sector_patterns = {sid: [re.compile(r"(?<![\w])" + re.escape(k) + r"(?![\w])", 0 if k.isupper() or len(k) <= 3 else re.I) for k in kws]
                                for sid, kws in SECTOR_KEYWORDS.items()}

    def primary_sector(self, cid: str) -> str | None:
        best, best_share = None, -1
        for s in self.data["sectors"]:
            for m in s["members"]:
                if m["id"] == cid and s["id"] != "capital" and (m["share"] or 0) > best_share:
                    best, best_share = s["id"], (m["share"] or 0)
        return best or (self.company_sectors.get(cid) or [None])[0]

    def classify(self, item: dict) -> dict:
        text = f"{item.get('title','')} . {item.get('summary','')}"
        title = item.get("title", "")
        companies, hits = [], {}
        for cid, pats in self.company_patterns:
            for p, k in pats:
                if p.search(text):
                    companies.append(cid)
                    hits[cid] = 2 if p.search(title) else 1
                    break
        # ambiguous names: require stronger context
        for amb in ("apple", "meta", "oracle", "index", "accel", "writer", "cursor", "1x", "figure", "scale", "generate", "chai", "pika", "luma", "harvey", "sierra", "glean", "lambda", "baseten", "vast"):
            if amb in companies and hits.get(amb, 0) < 2:
                name = self.data["companies"][amb]["name"].split(" (")[0]
                if not re.search(r"\b(AI|A\.I\.|artificial intelligence|model|startup|robot|chip|cloud|funding|raises|valuation)\b", text, re.I) and name.lower() not in title.lower():
                    companies.remove(amb)
        # sector keyword scores
        score = {}
        for sid, pats in self.sector_patterns.items():
            n = sum(1 for p in pats if p.search(text))
            if n:
                score[sid] = n
        sectors = set()
        feed_secs = item.get("feed_sectors") or []
        is_gnews = str(item.get("feed", "")).startswith("gnews")
        for sid in feed_secs:
            if not is_gnews or score.get(sid, 0) >= 1 or any(sid in self.company_sectors.get(c, []) for c in companies):
                sectors.add(sid)
        for sid, n in score.items():
            if n >= 2 or (n >= 1 and not sectors and not companies):
                if sid != "capital":
                    sectors.add(sid)
        for cid in companies:
            mine = [x for x in self.company_sectors.get(cid, []) if x != "capital"]
            supported = [x for x in mine if score.get(x, 0) >= 1]
            if supported:
                sectors.update(supported)
            else:
                ps = self.primary_sector(cid)
                if ps:
                    sectors.add(ps)
        # funding
        fund = None
        t_hit = FUNDING_RE.search(title) and not NOT_FUNDING_RE.search(title)
        s_hit = item.get("kind") == "funding" and FUNDING_RE.search(text) and not NOT_FUNDING_RE.search(text) and ROUND_RE.search(text)
        if t_hit or s_hit:
            amts = [a for a in AMOUNT_RE.finditer(title)] or [a for a in AMOUNT_RE.finditer(text)]
            # prefer the round size over the valuation figure
            non_val = [a for a in amts if not re.search(r"^\s*(?:post-money\s+|pre-money\s+)?valuation", (title if a.string is title else text)[a.end():a.end()+24], re.I)]
            amt = (non_val or amts or [None])[0]
            amount_m = None
            if amt:
                v = float(amt.group(2).replace(",", ""))
                unit = amt.group(3).lower()
                amount_m = v * 1000 if unit in ("billion", "bn", "b") else v
                if amt.group(1) == "€": amount_m *= 1.1
                if amt.group(1) == "£": amount_m *= 1.3
            rnd = ROUND_RE.search(title) or ROUND_RE.search(text)
            who = None
            m = re.search(r"\b(raises|raised|raising|secures|secured|lands|nabs|bags|banks|closes|closed|hits|reaches|triples|doubles|valued|acquires|to acquire|buys)\b", title, re.I)
            subject = title[:m.start()] if m else title
            subject = re.sub(r"^(?:Exclusive|Scoop|Report|Breaking)\s*[:|\-–]\s*", "", subject, flags=re.I)
            for cid in companies:
                nm = self.data["companies"][cid]["name"].split(" (")[0]
                if re.search(r"(?<![\w-])" + re.escape(nm) + r"(?![\w-])", subject) and not re.search(r"\b(ex|former|alum|alumni|veterans?|researchers?|backed|led|owned)\b[^.]{0,25}" + re.escape(nm), subject, re.I) and not re.search(re.escape(nm) + r"[\s'’]+(?:alum|veteran|researcher|exec|founder|engineer|backed|led)", subject, re.I):
                    who = nm
                    break
            if not who:
                mm = re.search(r"((?:[A-Z][\w.&'’-]*|[a-z]+\.ai)(?:\s(?:[A-Z][\w.&'’-]*|[a-z]+\.ai)){0,3})\s*$", subject.strip().rstrip(",:"))
                cand = mm.group(1) if mm else None
                bad = r"^(This|The|A|An|AI|Startup|Start-up|Exclusive|Israeli|Indian|British|Dallas|UK|US)\b|\b(Says|Valuation|Million|Billion|Roll|Week|Weeks|Funding|Rounds?|Report|Sources|Investors?|Deal)\b"
                if cand and not re.search(bad, cand):
                    who = cand
            fund = {"company": who, "amount_usd_m": amount_m, "round": rnd.group(1) if rnd else None,
                    "investors": self._investors(text)}
            sectors.add("capital")
        is_frontier = item.get("kind") == "research" or item.get("feed") in ("openai", "deepmind", "google_ai", "hf_blog") or (bool(FRONTIER_RE.search(title)) and not fund and any(s in sectors for s in ("foundation", "chips", "robotics", "health")))
        item = dict(item)
        item["companies"] = companies
        item["sectors"] = sorted(sectors) or ["general"]
        item["funding"] = fund
        item["frontier"] = bool(is_frontier)
        return item

    def _investors(self, text: str) -> list[str]:
        m = re.search(r"led by ([^.;]+?)(?:[.;]|with participation| and participation|$)", text, re.I)
        if not m:
            return []
        chunk = m.group(1)
        parts = re.split(r",|\band\b", chunk)
        return [p.strip() for p in parts if 2 < len(p.strip()) < 40][:4]


def dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for it in sorted(items, key=lambda x: -x["ts"]):
        key = re.sub(r"[^a-z0-9]", "", it["title"].lower())[:70]
        if key in seen or it["link"] in seen:
            continue
        seen.add(key); seen.add(it["link"])
        out.append(it)
    return out


FX_FALLBACK = {"USD": 1.0, "KRW": 0.00072, "TWD": 0.031, "JPY": 0.0066, "EUR": 1.10, "GBP": 1.30, "HKD": 0.128, "CNY": 0.14, "CHF": 1.15, "INR": 0.012, "ILS": 0.28, "SEK": 0.097, "DKK": 0.148, "CAD": 0.73, "AUD": 0.66, "SGD": 0.76, "GBp": 0.013}

def fetch_market_caps(tickers: list[str]) -> dict[str, dict]:
    """Market cap + day change for public companies via yfinance, converted to USD. Best effort."""
    out = {}
    try:
        import yfinance as yf
    except Exception:
        return out
    fx_cache = {}

    def fx(cur):
        if not cur or cur == "USD":
            return 1.0
        if cur in fx_cache:
            return fx_cache[cur]
        rate = None
        try:
            r = yf.Ticker(f"{cur}USD=X").fast_info
            rate = r.get("lastPrice") or r.get("last_price")
        except Exception:
            rate = None
        if not rate:
            rate = FX_FALLBACK.get(cur)
        fx_cache[cur] = rate
        return rate

    for t in tickers:
        try:
            fi = yf.Ticker(t).fast_info
            cap = fi.get("marketCap") or fi.get("market_cap")
            last = fi.get("lastPrice") or fi.get("last_price")
            prev = fi.get("previousClose") or fi.get("previous_close")
            cur = fi.get("currency")
            chg = (last / prev - 1) * 100 if last and prev else None
            rate = fx(cur)
            if cap and rate:
                out[t] = {"market_cap_usd_b": round(cap * rate / 1e9, 1), "last": last, "change_pct": round(chg, 2) if chg is not None else None, "currency": cur}
        except Exception as e:
            log.debug("cap %s: %s", t, e)
    return out
    for t in tickers:
        try:
            fi = yf.Ticker(t).fast_info
            cap = fi.get("marketCap") or fi.get("market_cap")
            last = fi.get("lastPrice") or fi.get("last_price")
            prev = fi.get("previousClose") or fi.get("previous_close")
            chg = (last / prev - 1) * 100 if last and prev else None
            if cap:
                out[t] = {"market_cap_usd_b": round(cap / 1e9, 1), "last": last, "change_pct": round(chg, 2) if chg is not None else None, "currency": fi.get("currency")}
        except Exception as e:
            log.debug("cap %s: %s", t, e)
    return out
