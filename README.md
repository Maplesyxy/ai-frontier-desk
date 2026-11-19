# AI Frontier Desk

A personal, 24/7-Wall-St-style desk for the AI industry: live news, funding rounds and
research across eight sectors, plus curated maps of who supplies, funds and competes
with whom. Runs locally, no accounts needed, and also publishes as a static site on GitHub Pages.

## Run

```bash
cd "~/Documents/claude_projects/ai-frontier-desk"
./run.sh            # http://127.0.0.1:8766
```

`run.sh` creates `.venv` (Python 3.12 via `uv`) on first run. The first crawl takes about a
minute; after that feeds refresh every 15 minutes and market caps every hour. To restart:
`lsof -ti :8766 | xargs kill` then `./run.sh`.

## Public site (GitHub Pages)

`.github/workflows/pages.yml` runs `build_site.py` every 30 minutes (and on every push to
`main`): it crawls all feeds, merges them with the previous build fetched from the live site
(so ten days of history accumulate), refreshes market caps and a rolling 30 companies' Google
News, and deploys `site/` to Pages. No server: `static/app.js` detects `data/manifest.json`
and reads the JSON files instead of the API. The Refresh button is hidden there.

To test the build locally: `.venv/bin/python build_site.py --out site` then
`python3 -m http.server -d site 8080`. Market caps fall back to `data/caps_seed.json` when
Yahoo Finance blocks the runner. GitHub disables scheduled workflows after 60 days without a
push; a trivial commit re-arms it.

## What is on the page

| Area | What it shows | Source |
|---|---|---|
| Tabs | Overview, one tab per sector (Models, Chips, Cloud, Enterprise, Robotics, Health & Bio, Consumer, Capital), Frontiers | `data/sectors.json` |
| Tape | Latest detected funding rounds and frontier launches | crawler |
| Sector page | KPI tiles (market 2025 / 2030E, CAGR, sector facts), sub-tabs News / Frontiers / Funding & deals / Companies | curated + crawler |
| Industry map (side) | Force graph of the sector in the paresearch.com style: logo nodes, node size = market share (or valuation), the leader filled as the hub, curved edges = supplies / invests / partners (competes hidden by default). "outside cos" adds grey nodes for companies outside the sector that touch it. "Expand" opens the full-screen map with search, zoom, edge filters, Fit / Reset layout, and click-two-companies-to-see-the-relationship (direct deals or shortest path) | `connections` in the data file |
| Side charts | Market size series with CAGR, market-share donut, revenue segments, private funding by year, "how the sector works" workflow, numbers to know | curated |
| Company dossier (click any node, chip or card) | Live market cap for public names, valuation for private, share per sector, supply-chain diagram (suppliers, customers, investors, partners), full connection list, latest Google News | curated + yfinance + Google News |
| Overview | Cross-sector KPIs, the AI stack diagram, market size and CAGR comparisons, map of all tracked companies | curated |
| Frontiers | Company research blogs, arXiv (cs.AI/LG/CL/RO/CV), SemiAnalysis, Import AI, Hugging Face, plus launch/benchmark news | crawler |

## Feeds

About 35 sources: TechCrunch (AI, Startups, Venture), The Verge, VentureBeat, MIT Technology
Review, Ars Technica, Wired, FT AI, Bloomberg Technology, CNBC, 24/7 Wall St., Hacker News,
Crunchbase News, SemiAnalysis, Import AI, IEEE Spectrum, The Robot Report, STAT, Tom's
Hardware, OpenAI, Google DeepMind, Google AI, NVIDIA, Microsoft, AWS ML, Hugging Face, the
arXiv API, and Google News queries (funding, Anthropic, Meta AI, robotics, health, chips).
Edit the `FEEDS` list in `crawl.py` to add or remove sources.

Every item is classified by matching company keywords (from the data file) and sector
keyword lists. Funding events are extracted with regexes (amount, round, lead investors,
company); expect some misses on unusual headlines.

## The curated data

`data/sectors.json` holds the industry model: sectors (market size, CAGR, segments, funding
series, workflow stages, KPIs, members with share), 121 companies (type, HQ, valuation,
ticker, blurb, keywords, products, supply chain) and 241 connections. Market sizes, CAGRs,
shares and valuations are **curated estimates as of mid-2026**, assembled from public
analyst figures and press reports. They are starting points, not audited data. The server
reloads the file automatically when you edit it, so updating a share or adding a company
is a JSON edit. Keep company `keywords` specific; short or common names (Apple, Meta,
Figure, Scale) are already handled with extra context checks in `crawl.py`.

## Layout of the code

- `server.py` FastAPI app, background scheduler, JSON API (`/api/data`, `/api/feed`,
  `/api/funding`, `/api/company/{id}/news`, `/api/status`, `POST /api/refresh`)
- `crawl.py` feed list, fetching, classification, funding extraction, market caps
- `data/sectors.json` the industry model
- `static/` `index.html`, `style.css`, `app.js` (D3 maps and charts, dossier)
- `build_site.py` static build for GitHub Pages (writes `site/`, ignored by git)
- `cache.json` last crawl snapshot (safe to delete)

Data is for personal research only, not investment advice.
