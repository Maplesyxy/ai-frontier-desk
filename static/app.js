/* AI Frontier Desk - front end */
(() => {
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else if (v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
const fmtB = (b) => b == null ? "—" : b >= 1000 ? `$${(b / 1000).toFixed(1)}T` : b >= 100 ? `$${Math.round(b)}B` : `$${b.toFixed(b < 10 ? 1 : 0)}B`;
const fmtM = (m) => m == null ? "undisclosed" : m >= 1000 ? `$${(m / 1000).toFixed(m >= 10000 ? 0 : 1)}B` : `$${Math.round(m)}M`;
const ago = (ts) => { const s = Date.now() / 1000 - ts; if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`; };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ---------------- data access: live API (server.py) or static JSON (GitHub Pages build) ---------------- */
const STATIC = { on: false, feed: null, loaded: 0 };
const bust = () => "?t=" + Math.floor(Date.now() / 600000);
async function detectStatic() {
  try { const r = await fetch("data/manifest.json" + bust(), { cache: "no-store" }); if (r.ok) { const m = await r.json(); STATIC.on = !!m.static; } } catch { STATIC.on = false; }
}
async function loadStatic() {
  if (STATIC.feed && Date.now() - STATIC.loaded < 15 * 60 * 1000) return STATIC.feed;
  const r = await fetch("data/feed.json" + bust()); STATIC.feed = await r.json(); STATIC.loaded = Date.now(); return STATIC.feed;
}
function filterFeed(all, q) { /* mirrors /api/feed in server.py */
  const sector = q.get("sector"), company = q.get("company"), kind = q.get("kind"), s = (q.get("q") || "").toLowerCase();
  const limit = Math.min(+q.get("limit") || 80, 400);
  let items = all;
  if (sector && sector !== "all") items = items.filter(i => i.sectors.includes(sector));
  else if (!company && !s) items = items.filter(i => !(i.sectors.length === 1 && i.sectors[0] === "general"));
  if (company) items = items.filter(i => i.companies.includes(company));
  if (kind === "funding") items = items.filter(i => i.funding);
  else if (kind === "frontier") items = items.filter(i => i.frontier);
  else if (kind === "news") items = items.filter(i => !i.frontier && !i.funding);
  else if (kind === "research") items = items.filter(i => i.kind === "research");
  if (s) items = items.filter(i => i.title.toLowerCase().includes(s) || (i.summary || "").toLowerCase().includes(s));
  return { items: items.slice(0, limit), total: items.length };
}
async function api(path, opts) {
  if (!STATIC.on) { const r = await fetch(path, opts); return r.json(); }
  const u = new URL(path, location.href); const p = u.pathname.replace(/.*\/api\//, ""); const q = u.searchParams;
  if (p === "data") return (await fetch("data/data.json" + bust())).json();
  const f = await loadStatic();
  if (p === "feed") return filterFeed(f.items, q);
  if (p === "status") return { items: f.items.length, last_news: f.last_news, last_caps: f.last_caps, refreshing: false, feeds: f.feed_status || {} };
  if (p === "funding") { const items = f.items.filter(i => i.funding); return { items: items.slice(0, 120), total_usd_m: Math.round(items.reduce((a, i) => a + (i.funding.amount_usd_m || 0), 0)), count: items.length }; }
  if (p.startsWith("company/")) {
    const cid = p.split("/")[1];
    try { const r = await fetch(`data/company/${cid}.json` + bust()); if (r.ok) return r.json(); } catch {}
    return { items: f.items.filter(i => i.companies.includes(cid)).slice(0, 25) };
  }
  if (p === "refresh") return { ok: false };
  throw new Error("unknown endpoint " + p);
}

const S = { data: null, sectorsById: {}, tab: "overview", sub: "news", query: "", sizeBy: "share", feedCache: {}, graph: null };

/* ---------------- routing & boot ---------------- */
async function boot() {
  await detectStatic();
  S.data = await api("/api/data");
  S.data.sectors.forEach(s => S.sectorsById[s.id] = s);
  $("#disclaimer").textContent = `Curated figures as of ${S.data.as_of}. ${S.data.disclaimer}`;
  renderTabs(); applyTheme(localStorage.getItem("afd-theme") || "light");
  $("#theme-btn").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  if (STATIC.on) $("#refresh-btn").hidden = true;
  $("#refresh-btn").onclick = async () => { $("#refresh-btn").textContent = "Refreshing…"; await api("/api/refresh", { method: "POST" }); setTimeout(() => { S.feedCache = {}; route(); $("#refresh-btn").textContent = "Refresh"; }, 12000); };
  let t; $("#search").oninput = e => { clearTimeout(t); t = setTimeout(() => { S.query = e.target.value.trim(); S.feedCache = {}; renderMain(); }, 300); };
  window.addEventListener("hashchange", route);
  route(); tape(); status(); setInterval(status, 30000); setInterval(() => { S.feedCache = {}; renderMain(); }, 5 * 60 * 1000);
}
function applyTheme(t) { document.documentElement.dataset.theme = t; localStorage.setItem("afd-theme", t); if (S.data) renderSide(); }
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const segs = h.split("/");
  const ci = segs.indexOf("company"); const company = ci >= 0 ? segs[ci + 1] : null;
  const [a, b] = ci >= 0 ? segs.slice(0, ci) : segs;
  const tab = (a && (S.sectorsById[a] || a === "overview" || a === "frontiers")) ? a : "overview";
  const changed = tab !== S.tab;
  if (changed) { S.sub = tab === "frontiers" ? "frontier" : "news"; }
  S.tab = tab; if (b && ["news", "frontier", "funding", "companies"].includes(b)) S.sub = b;
  if (changed || !S.rendered) { renderTabs(); renderMain(); renderSide(); S.rendered = true; window.scrollTo({ top: 0 }); }
  if (company) openDossier(company); else closeDossier(false);
  if (segs.includes("map")) openMapOverlay(S.sectorsById[tab] || null); else if (!$("#overlay").classList.contains("hidden")) closeMapOverlay();
}
function go(tab, sub) { location.hash = `#/${tab}${sub ? "/" + sub : ""}`; }

/* ---------------- tabs & tape ---------------- */
function renderTabs() {
  const tabs = [{ id: "overview", short: "Overview", color: "#e8b84a" }, ...S.data.sectors, { id: "frontiers", short: "Frontiers", color: "#e8b84a" }];
  $("#tabs").replaceChildren(...tabs.map(t => el("div", { class: "tab" + (S.tab === t.id ? " active" : ""), style: `--tab-color:${t.color}`, onclick: () => go(t.id) }, t.short)));
}
async function tape() {
  const f = (await api("/api/feed?kind=funding&limit=14")).items;
  const fr = (await api("/api/feed?kind=frontier&limit=10")).items;
  const parts = [];
  f.forEach(i => parts.push(el("span", { class: "tape-item", onclick: () => window.open(i.link) }, el("b", {}, (i.funding.company || i.title.split(/[:|–—]/)[0].slice(0, 40)) + " "), fmtM(i.funding.amount_usd_m) + (i.funding.round ? " " + i.funding.round : ""))));
  fr.forEach(i => parts.push(el("span", { class: "tape-item", onclick: () => window.open(i.link) }, el("b", {}, "Frontier "), i.title.slice(0, 90))));
  const track = $("#tape"); track.replaceChildren(...parts, ...parts.map(p => p.cloneNode(true)));
  track.querySelectorAll(".tape-item").forEach((n, idx) => { const src = [...f, ...fr][idx % (f.length + fr.length)]; if (src) n.onclick = () => window.open(src.link); });
}
async function status() {
  const s = await api("/api/status");
  const ok = Object.values(s.feeds).filter(f => f.ok).length, tot = Object.keys(s.feeds).length;
  $("#status-line").textContent = `${s.items} items · ${ok}/${tot} feeds ok · news ${s.last_news ? ago(s.last_news) : "pending"} · market caps ${s.last_caps ? ago(s.last_caps) : "pending"}${s.refreshing ? " · refreshing…" : ""}${STATIC.on ? " · rebuilds every 30 min" : ""}`;
}

/* ---------------- data helpers ---------------- */
const co = (id) => S.data.companies[id];
const secColor = (id) => (S.sectorsById[id] || {}).color || "#999";
function memberSectors(cid) { return S.data.sectors.filter(s => s.members.some(m => m.id === cid)); }
function shareIn(cid, sid) { const m = (S.sectorsById[sid] || { members: [] }).members.find(m => m.id === cid); return m ? m.share : null; }
function capOf(cid) { const t = co(cid)?.ticker; return t && S.data.caps[t]; }
function valuation(cid) { const c = co(cid); const cap = capOf(cid); return cap ? cap.market_cap_usd_b : c.valuation_usd_b; }
async function feed(params) {
  const key = JSON.stringify(params); if (S.feedCache[key]) return S.feedCache[key];
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v)));
  const j = await api("/api/feed?" + qs); S.feedCache[key] = j; return j;
}

/* ---------------- main column ---------------- */
async function renderMain() {
  const main = $("#main");
  if (S.tab === "overview") return renderOverview(main);
  if (S.tab === "frontiers") return renderFrontiers(main);
  const sec = S.sectorsById[S.tab];
  main.replaceChildren(
    el("div", { class: "section-head" }, el("div", {}, el("h1", {}, sec.name), el("p", {}, sec.description))),
    kpiStrip(sec),
    el("div", { class: "subtabs", id: "subtabs" }),
    el("div", { id: "content" }, el("div", { class: "empty" }, el("span", { class: "spinner" }), " loading…"))
  );
  const counts = {};
  const [news, fr, fu] = await Promise.all([feed({ sector: sec.id, kind: "news", limit: 1, q: S.query }), feed({ sector: sec.id, kind: "frontier", limit: 1, q: S.query }), feed({ sector: sec.id, kind: "funding", limit: 1, q: S.query })]);
  counts.news = news.total; counts.frontier = fr.total; counts.funding = fu.total; counts.companies = sec.members.length;
  const subs = [["news", "News"], ["frontier", "Frontiers"], ["funding", "Funding & deals"], ["companies", "Companies"]];
  $("#subtabs").replaceChildren(...subs.map(([k, l]) => el("button", { class: "subtab" + (S.sub === k ? " active" : ""), onclick: () => { S.sub = k; history.replaceState(null, "", `#/${sec.id}/${k}`); renderMain(); } }, l, el("span", { class: "cnt" }, counts[k]))));
  const content = $("#content");
  if (S.sub === "companies") return content.replaceChildren(companyGrid(sec));
  const j = await feed({ sector: sec.id, kind: S.sub, limit: 120, q: S.query });
  content.replaceChildren(S.sub === "funding" ? fundingTable(j.items) : feedList(j.items, true));
}
function kpiStrip(sec) {
  const m = sec.market; const pub = sec.members.filter(x => capOf(x.id)).length;
  return el("div", { class: "kpis" },
    kpi(fmtB(m.size_2025_usd_b), "Market 2025", m.note), kpi(fmtB(m.size_2030_usd_b), "Market 2030E", `${m.window} projection`),
    kpi(`${m.cagr_pct}%`, "CAGR", m.window), kpi(sec.members.length, "Companies tracked", `${pub} with live market caps`),
    ...sec.kpis.map(k => kpi(k.value, k.label, k.note)));
}
const kpi = (v, l, n) => el("div", { class: "kpi" }, el("div", { class: "v" }, v), el("div", { class: "l" }, l), n ? el("div", { class: "n" }, n) : null);

function feedList(items, lead = false) {
  if (!items.length) return el("div", { class: "empty" }, "Nothing matched yet. Feeds refresh every 15 minutes.");
  return el("div", { class: "feed" }, ...items.map((i, idx) => feedItem(i, lead && idx === 0)));
}
function feedItem(i, lead = false) {
  const badge = i.funding ? el("span", { class: "badge fund" }, "Funding") : i.kind === "research" ? el("span", { class: "badge research" }, "Research") : i.frontier ? el("span", { class: "badge frontier" }, "Frontier") : el("span", { class: "badge" }, i.kind === "company" ? "Company blog" : "News");
  const meta = el("div", { class: "m" }, el("span", {}, i.source), el("span", {}, ago(i.ts)),
    ...(i.funding && i.funding.amount_usd_m ? [el("span", { class: "amount" }, fmtM(i.funding.amount_usd_m), i.funding.round ? ` · ${i.funding.round}` : "")] : []),
    ...i.companies.slice(0, 5).map(c => el("span", { class: "chip", onclick: () => openDossier(c) }, co(c)?.name.split(" (")[0] || c)),
    ...i.sectors.filter(s => S.sectorsById[s]).slice(0, 3).map(s => el("span", { class: "chip sec", onclick: () => go(s) }, el("i", { style: `background:${secColor(s)}` }), S.sectorsById[s].short)));
  return el("article", { class: "item" + (lead ? " lead" : "") },
    el("a", { class: "t", href: i.link, target: "_blank", rel: "noopener" }, i.title), badge,
    (lead || i.kind === "research") && i.summary ? el("div", { class: "s" }, i.summary + (i.authors ? ` — ${i.authors}` : "")) : null, meta);
}
function fundingTable(items) {
  if (!items.length) return el("div", { class: "empty" }, "No funding events detected yet.");
  const total = items.reduce((a, i) => a + (i.funding.amount_usd_m || 0), 0);
  const rows = items.map(i => el("tr", {},
    el("td", {}, el("b", {}, i.funding.company || "—"), i.companies.length ? el("div", { class: "small" }, ...i.companies.slice(0, 3).map(c => el("span", { class: "chip", onclick: () => openDossier(c) }, co(c).name.split(" (")[0]))) : null),
    el("td", { class: "amount" }, fmtM(i.funding.amount_usd_m)), el("td", {}, i.funding.round || "—"),
    el("td", { class: "small" }, i.funding.investors?.join(", ") || "—"),
    el("td", {}, el("a", { href: i.link, target: "_blank", rel: "noopener" }, i.title), el("div", { class: "small muted" }, `${i.source} · ${ago(i.ts)}`))));
  return el("div", { class: "card" }, el("h3", {}, "Detected rounds, deals and valuations", el("span", {}, `${items.length} events · ${fmtM(total)} disclosed`)),
    el("table", { class: "fund" }, el("thead", {}, el("tr", {}, ...["Company", "Amount", "Round", "Led by / investors", "Story"].map(h => el("th", {}, h)))), el("tbody", {}, ...rows)));
}
function companyGrid(sec) {
  const members = [...sec.members].sort((a, b) => (b.share || 0) - (a.share || 0));
  return el("div", { class: "co-grid" }, ...members.map(m => {
    const c = co(m.id); const cap = capOf(m.id);
    return el("div", { class: "co", onclick: () => openDossier(m.id) },
      el("div", { class: "n" }, c.name, el("span", { class: "type " + c.type }, c.type)), el("div", { class: "d" }, c.blurb),
      el("div", { class: "r" }, el("span", {}, m.share != null ? ["Share ", el("b", {}, m.share + "%")] : "Supplier / enabler"),
        el("span", {}, cap ? ["Mkt cap ", el("b", {}, fmtB(cap.market_cap_usd_b)), cap.change_pct != null ? el("span", { class: cap.change_pct >= 0 ? "pos" : "neg" }, ` ${cap.change_pct >= 0 ? "+" : ""}${cap.change_pct}%`) : null] : c.valuation_usd_b ? ["Valuation ", el("b", {}, fmtB(c.valuation_usd_b))] : "")));
  }));
}

/* ---- overview & frontiers ---- */
async function renderOverview(main) {
  main.replaceChildren(
    el("div", { class: "section-head" }, el("div", {}, el("h1", {}, "The AI industry, end to end"), el("p", {}, "Live news, funding and research across eight sectors, with curated maps of who supplies, funds and competes with whom. Pick a sector tab for its network map, market structure and workflow."))),
    el("div", { class: "kpis" }, ...S.data.sectors.map(s => el("div", { class: "kpi", style: `border-top:3px solid ${s.color};cursor:pointer`, onclick: () => go(s.id) }, el("div", { class: "v" }, fmtB(s.market.size_2025_usd_b)), el("div", { class: "l" }, s.short), el("div", { class: "n" }, `${s.market.cagr_pct}% CAGR → ${fmtB(s.market.size_2030_usd_b)} by 2030`)))),
    el("div", { class: "subtabs", id: "subtabs" }), el("div", { id: "content" }, el("div", { class: "empty" }, el("span", { class: "spinner" }), " loading…")));
  const subs = [["news", "Top stories"], ["funding", "Funding & deals"], ["frontier", "Frontier moves"]];
  const draw = async () => {
    $("#subtabs").replaceChildren(...subs.map(([k, l]) => el("button", { class: "subtab" + (S.sub === k ? " active" : ""), onclick: () => { S.sub = k; draw(); } }, l)));
    const j = await feed({ kind: S.sub, limit: 120, q: S.query });
    $("#content").replaceChildren(S.sub === "funding" ? fundingTable(j.items) : feedList(j.items, true));
  };
  if (!["news", "funding", "frontier"].includes(S.sub)) S.sub = "news";
  draw();
}
async function renderFrontiers(main) {
  main.replaceChildren(el("div", { class: "section-head" }, el("div", {}, el("h1", {}, "Frontiers"), el("p", {}, "New models, launches, benchmarks and papers: company research blogs, arXiv (cs.AI, cs.LG, cs.CL, cs.RO, cs.CV), SemiAnalysis, Import AI and Hugging Face."))),
    el("div", { class: "subtabs", id: "subtabs" }), el("div", { id: "content" }));
  const subs = [["frontier", "All frontier"], ["research", "Papers & research"], ...S.data.sectors.filter(s => s.id !== "capital").map(s => [s.id, s.short])];
  if (!subs.some(([k]) => k === S.sub)) S.sub = "frontier";
  const draw = async () => {
    $("#subtabs").replaceChildren(...subs.map(([k, l]) => el("button", { class: "subtab" + (S.sub === k ? " active" : ""), onclick: () => { S.sub = k; draw(); } }, l)));
    const params = S.sectorsById[S.sub] ? { sector: S.sub, kind: "frontier" } : { kind: S.sub };
    const j = await feed({ ...params, limit: 150, q: S.query });
    $("#content").replaceChildren(feedList(j.items));
  };
  draw();
}

/* ---------------- side column ---------------- */
function renderSide() {
  const side = $("#side");
  if (S.tab === "overview" || S.tab === "frontiers") return renderOverviewSide(side);
  const sec = S.sectorsById[S.tab];
  const mapCard = el("div", { class: "card" }, el("h3", {}, "Industry map", el("span", { class: "ctl" },
    el("button", { class: S.sizeBy === "share" ? "on" : "", onclick: () => { S.sizeBy = "share"; renderSide(); } }, "share"),
    el("button", { class: S.sizeBy === "valuation" ? "on" : "", onclick: () => { S.sizeBy = "valuation"; renderSide(); } }, "valuation"),
    el("button", { class: S.mapOpts.external ? "on" : "", onclick: () => { S.mapOpts.external = !S.mapOpts.external; renderSide(); } }, "outside cos"),
    el("button", { class: "expand", onclick: () => openMapOverlay(sec) }, "⤢ Expand"))),
    el("div", { class: "map", id: "map" }, el("div", { class: "hint" }, "drag · zoom · hover edges · click a company · expand for the full map")),
    el("div", { class: "legend" }, el("span", {}, el("i", { class: "sup" }), "supplies"), el("span", {}, el("i", { class: "inv" }), "invests in"), el("span", {}, el("i", { class: "par" }), "partners"), el("span", {}, el("i", { class: "com" }), "competes"),
      el("span", {}, el("span", { class: "dot", style: "background:#1e4d8c" }), "big tech"), el("span", {}, el("span", { class: "dot", style: "background:#1f8a4c" }), "startup"), el("span", {}, el("span", { class: "dot", style: "background:#b36b00" }), "public"), el("span", {}, el("span", { class: "dot", style: "background:#7b4fd6" }), "investor"), el("span", {}, el("span", { class: "dot", style: "background:#9a9a93" }), "outside sector")),
    el("div", { class: "small muted", style: "margin-top:6px" }, `Node size: ${S.sizeBy === "share" ? sec.share_metric : "valuation or live market cap"}.`));
  const marketCard = el("div", { class: "card" }, el("h3", {}, "Market size & CAGR", el("span", {}, `${sec.market.cagr_pct}% · ${sec.market.window}`)), el("div", { class: "chart", id: "c-market" }), el("div", { class: "small muted" }, sec.market.note));
  const shareCard = el("div", { class: "card" }, el("h3", {}, "Market share"), el("div", { class: "row2" }, el("div", { class: "chart", id: "c-donut" }), el("div", { id: "c-donut-legend" })), el("div", { class: "small muted", style: "margin-top:6px" }, sec.share_metric));
  const segCard = el("div", { class: "card" }, el("h3", {}, "Where the revenue sits"), el("div", { class: "hbar", id: "c-seg" }));
  const fundCard = el("div", { class: "card" }, el("h3", {}, "Private funding by year", el("span", {}, "$B, est.")), el("div", { class: "chart", id: "c-fund" }));
  const flowCard = el("div", { class: "card" }, el("h3", {}, "How the sector works"), el("div", { class: "flow" }, ...sec.workflow.stages.map(st => el("div", { class: "stage" }, el("h4", {}, st.name), ...st.nodes.map(n => el("div", { class: "pill" }, n))))));
  const noteCard = el("div", { class: "card" }, el("h3", {}, "Numbers to know"), el("ul", { class: "notes" }, ...sec.kpis.map(k => el("li", {}, el("b", {}, k.label + ": "), k.value, k.note ? el("span", { class: "muted" }, ` — ${k.note}`) : null))));
  side.replaceChildren(mapCard, marketCard, shareCard, segCard, fundCard, flowCard, noteCard);
  drawMap($("#map"), sec);
  barChart($("#c-market"), sec.series.market_size.map(([y, v]) => ({ label: String(y), value: v, proj: y > 2025 })), { fmt: v => fmtB(v) });
  donut($("#c-donut"), $("#c-donut-legend"), sec);
  hbars($("#c-seg"), sec.series.segments);
  barChart($("#c-fund"), sec.series.funding.map(([y, v]) => ({ label: String(y), value: v, proj: y >= 2026 })), { fmt: v => fmtB(v) });
}
function renderOverviewSide(side) {
  const layers = [
    ["capital"], ["consumer", "enterprise", "health", "robotics"], ["foundation"], ["cloud"], ["chips"]
  ];
  const stack = el("div", { class: "stack" });
  layers.forEach((ids, i) => {
    stack.append(el("div", { class: "layer" }, ...ids.map(id => { const s = S.sectorsById[id]; return el("div", { class: "box", style: `background:${s.color}`, onclick: () => go(id) }, el("b", {}, s.short), el("small", {}, `${fmtB(s.market.size_2025_usd_b)} · ${s.market.cagr_pct}% CAGR`)); })));
    if (i < layers.length - 1) stack.append(el("div", { class: "arrow" }, i === 0 ? "funds ↓" : "↑ built on"));
  });
  side.replaceChildren(
    el("div", { class: "card" }, el("h3", {}, "The AI stack"), stack, el("div", { class: "small muted", style: "margin-top:8px" }, "Capital flows down into every layer; value flows up from chips through cloud and models to applications. Click a layer.")),
    el("div", { class: "card" }, el("h3", {}, "Market size by sector", el("span", {}, "2025 vs 2030E")), el("div", { class: "chart", id: "c-ov" })),
    el("div", { class: "card" }, el("h3", {}, "Growth rates", el("span", {}, "CAGR 2025-2030")), el("div", { class: "hbar", id: "c-cagr" })),
    el("div", { class: "card" }, el("h3", {}, "Cross-sector hubs", el("span", { class: "ctl" }, el("button", { class: "expand", onclick: () => openMapOverlay(null) }, "⤢ Full map"))), el("div", { class: "map", id: "map", style: "height:400px" }, el("div", { class: "hint" }, "most-connected companies · click to open · expand for all 121")), el("div", { class: "small muted", style: "margin-top:6px" }, "Node size: valuation or live market cap. Colour: primary sector.")));
  groupedBars($("#c-ov"), S.data.sectors.filter(s => s.id !== "capital").map(s => ({ label: s.short, a: s.market.size_2025_usd_b, b: s.market.size_2030_usd_b, color: s.color })));
  hbars($("#c-cagr"), S.data.sectors.map(s => [s.short, s.market.cagr_pct]), { suffix: "%", colors: S.data.sectors.map(s => s.color) });
  drawMap($("#map"), null);
}

/* ---------------- network map (D3) ---------------- */
const TYPE_COLOR = { bigtech: "#1e4d8c", startup: "#1f8a4c", public: "#b36b00", investor: "#7b4fd6" };
const EDGE_COLOR = { supplies: "#1f8a4c", invests: "#7b4fd6", partners: "#6b8fc9", competes: "#c23b22" };
const domainOf = (c) => { try { return new URL(c.site).hostname.replace(/^www\./, ""); } catch { return null; } };
const logoUrl = (c) => { const d = domainOf(c); return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=64` : null; };
S.mapOpts = { external: false, everyone: false, edges: { supplies: true, invests: true, partners: true, competes: false } };

function buildGraph(sec, { full = false } = {}) {
  let memberIds;
  if (sec) memberIds = sec.members.map(m => m.id);
  else {
    const deg = {}; S.data.connections.forEach(c => { deg[c.source] = (deg[c.source] || 0) + 1; deg[c.target] = (deg[c.target] || 0) + 1; });
    const minDeg = full ? (S.mapOpts.everyone ? 0 : 3) : 4;
    memberIds = Object.keys(S.data.companies).filter(id => (deg[id] || 0) >= minDeg).sort((a, b) => (deg[b] || 0) - (deg[a] || 0)).slice(0, full ? 200 : 40);
  }
  const memberSet = new Set(memberIds);
  const edgeOn = S.mapOpts.edges;
  let links = S.data.connections.filter(c => edgeOn[c.type] && (memberSet.has(c.source) || memberSet.has(c.target)));
  const showExt = sec ? S.mapOpts.external : false;
  if (!showExt) links = links.filter(c => memberSet.has(c.source) && memberSet.has(c.target));
  const byPair = {};
  links.forEach(l => { const k = l.source + "|" + l.target; if (!byPair[k]) byPair[k] = { source: l.source, target: l.target, types: [], labels: [] }; byPair[k].types.push(l.type); if (l.label) byPair[k].labels.push(`${l.type}: ${l.label}`); });
  links = Object.values(byPair).map(e => ({ ...e, type: e.types.includes("supplies") ? "supplies" : e.types.includes("invests") ? "invests" : e.types[0] }));
  const ids = new Set(memberIds); links.forEach(l => { ids.add(l.source); ids.add(l.target); });
  const maxShare = sec ? Math.max(...sec.members.map(m => m.share || 0), 1) : 1;
  const maxVal = Math.max(1, ...memberIds.map(id => valuation(id) || 0));
  const base = full ? 46 : 26, min = full ? 11 : 7;
  const nodes = [...ids].map(id => {
    const c = co(id); const member = memberSet.has(id);
    const sh = sec ? shareIn(id, sec.id) : null; const v = valuation(id);
    let r;
    if (sec && S.sizeBy === "share") r = sh == null ? min : min + base * Math.sqrt(sh / maxShare);
    else r = min + base * Math.sqrt((v || 0.5) / maxVal);
    if (!member) r = full ? 9 : 6;
    const primary = memberSectors(id)[0];
    const value = sec && S.sizeBy === "share" ? (sh != null ? `${sh}% share` : "enabler") : capOf(id) ? `${fmtB(capOf(id).market_cap_usd_b)} mkt cap` : v ? `${fmtB(v)} val.` : "";
    return { id, name: c.name.split(" (")[0], r, member, value, color: sec ? (TYPE_COLOR[c.type] || "#888") : (primary ? primary.color : "#888"), logo: logoUrl(c), initials: c.name.replace(/[^A-Za-z0-9 ]/g, "").split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase() };
  });
  let hero;
  if (sec) hero = nodes.filter(n => n.member).sort((a, b) => b.r - a.r)[0];
  else { const dg = {}; links.forEach(l => { dg[l.source] = (dg[l.source] || 0) + 1; dg[l.target] = (dg[l.target] || 0) + 1; }); hero = nodes.filter(n => n.member).sort((a, b) => (dg[b.id] || 0) - (dg[a.id] || 0))[0]; }
  if (hero) hero.hero = true;
  return { nodes, links, memberSet };
}

function renderGraph(container, graph, { full = false, sec = null, onSelect = null } = {}) {
  container.querySelectorAll("svg").forEach(n => n.remove());
  const W = container.clientWidth || 440, H = container.clientHeight || 420;
  const { nodes, links } = graph;
  const sfx = full ? "f" : "s";
  const svg = d3.select(container).append("svg").attr("viewBox", [0, 0, W, H]);
  const defs = svg.append("defs");
  ["supplies", "invests", "partners"].forEach(t => defs.append("marker").attr("id", `arr-${t}-${sfx}`).attr("viewBox", "0 -3 6 6").attr("refX", 6).attr("markerWidth", 5).attr("markerHeight", 5).attr("markerUnits", "userSpaceOnUse").attr("orient", "auto").append("path").attr("d", "M0,-3L6,0L0,3").attr("fill", EDGE_COLOR[t]).attr("opacity", .7));
  nodes.forEach(n => { if (n.logo) defs.append("clipPath").attr("id", `clip-${n.id}-${sfx}`).append("circle").attr("r", n.r * .68); });
  const g = svg.append("g");
  const zoom = d3.zoom().scaleExtent([0.3, 5]).on("zoom", e => { g.attr("transform", e.transform); g.classed("zoomed", e.transform.k > 1.5); });
  svg.call(zoom).on("dblclick.zoom", null);
  const linkSel = g.append("g").attr("class", "links").selectAll("path").data(links).join("path").attr("class", d => "link " + d.type).attr("stroke", d => EDGE_COLOR[d.type]).attr("marker-end", d => d.type === "competes" ? null : `url(#arr-${d.type}-${sfx})`);
  const hit = g.append("g").selectAll("path").data(links).join("path").attr("class", "hit").on("mouseenter", (e, d) => tip(e, `<b>${esc(co(d.source.id || d.source).name)}</b> → <b>${esc(co(d.target.id || d.target).name)}</b><br>${esc(d.labels.length ? d.labels.join("<br>") : d.types.join(", ")).replace(/&lt;br&gt;/g, "<br>")}`)).on("mousemove", moveTip).on("mouseleave", hideTip);
  const node = g.append("g").attr("class", "nodes").selectAll("g").data(nodes).join("g").attr("class", d => "node" + (d.member ? "" : " ext") + (d.hero ? " hero" : ""))
    .call(d3.drag().on("start", (e, d) => { if (!e.active) sim.alphaTarget(.25).restart(); d.fx = d.x; d.fy = d.y; }).on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; }).on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); if (!d.hero) { d.fx = null; d.fy = null; } }));
  node.append("circle").attr("class", "halo").attr("r", d => d.r + 4);
  node.append("circle").attr("class", "body").attr("r", d => d.r).attr("fill", d => d.hero ? d.color : "var(--paper)").attr("stroke", d => d.color);
  node.filter(d => d.logo && !d.hero && d.r >= 9).append("image").attr("href", d => d.logo).attr("x", d => -d.r * .68).attr("y", d => -d.r * .68).attr("width", d => d.r * 1.36).attr("height", d => d.r * 1.36).attr("clip-path", d => `url(#clip-${d.id}-${sfx})`).on("error", function () { this.remove(); });
  node.filter(d => d.hero).append("text").attr("class", "hero-label").attr("dy", 4).attr("text-anchor", "middle").text(d => d.name.length > (full ? 14 : 9) && d.r < 40 ? d.initials : d.name.split(" / ")[0]);
  node.filter(d => !d.hero).append("text").attr("class", "name").attr("dy", d => d.r + 12).attr("text-anchor", "middle").text(d => d.name.length > 18 ? d.name.slice(0, 17) + "…" : d.name);
  node.filter(d => d.member && d.value && (full || d.r >= 12)).append("text").attr("class", "val").attr("dy", d => d.hero ? d.r + 12 : d.r + 23).attr("text-anchor", "middle").text(d => d.value);
  let selected = null;
  node.selectAll("circle, image, text.hero-label").on("mouseenter", (e, d) => { if (!selected) focus(d.id); tip(e, nodeTip(d, sec)); }).on("mousemove", moveTip).on("mouseleave", () => { if (!selected) focus(null); hideTip(); })
    .on("click", (e, d) => { e.stopPropagation(); if (onSelect) onSelect(d.id); else openDossier(d.id); });
  svg.on("click", () => { if (onSelect) onSelect(null); });
  const hero = nodes.find(n => n.hero); if (hero) { hero.fx = W / 2; hero.fy = H / 2; }
  const deg = {}; links.forEach(l => { deg[l.source.id || l.source] = (deg[l.source.id || l.source] || 0) + 1; deg[l.target.id || l.target] = (deg[l.target.id || l.target] || 0) + 1; });
  nodes.forEach((n, i) => { const a = i / nodes.length * Math.PI * 2; n.x = W / 2 + Math.cos(a) * 80; n.y = H / 2 + Math.sin(a) * 80; });
  const R = Math.min(W, H) * .42;
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(d => d.source.r + d.target.r + (full ? 90 : 50)).strength(.35))
    .force("charge", d3.forceManyBody().strength(d => d.member ? (full ? -520 : -200) : (full ? -160 : -70)).distanceMax(full ? 420 : 260))
    .force("collide", d3.forceCollide(d => d.r + (full ? 24 : 14)).strength(.95))
    .force("x", d3.forceX(W / 2).strength(d => (deg[d.id] || 0) === 0 ? .18 : .05)).force("y", d3.forceY(H / 2).strength(d => (deg[d.id] || 0) === 0 ? .18 : .07))
    .force("radial", d3.forceRadial(d => d.member ? ((deg[d.id] || 0) === 0 ? R * .85 : 0) : R * 1.1, W / 2, H / 2).strength(d => d.member ? ((deg[d.id] || 0) === 0 ? .5 : 0) : .35));
  sim.alphaDecay(.03).on("end", () => api.fit());
  const arc = d => { const sx = d.source.x, sy = d.source.y, tx = d.target.x, ty = d.target.y; const dx = tx - sx, dy = ty - sy, dist = Math.hypot(dx, dy) || 1; const ex = tx - dx / dist * (d.target.r + 3), ey = ty - dy / dist * (d.target.r + 3); const dr = dist * 1.4; return `M${sx},${sy}A${dr},${dr} 0 0,1 ${ex},${ey}`; };
  sim.on("tick", () => { linkSel.attr("d", arc); hit.attr("d", arc); node.attr("transform", d => `translate(${d.x},${d.y})`); });
  function focus(id) {
    if (!id) { node.classed("dim", false); linkSel.classed("dim", false).classed("hi", false); return; }
    const near = new Set([id]); links.forEach(l => { if (l.source.id === id) near.add(l.target.id); if (l.target.id === id) near.add(l.source.id); });
    node.classed("dim", d => !near.has(d.id)); linkSel.classed("dim", l => l.source.id !== id && l.target.id !== id).classed("hi", l => l.source.id === id || l.target.id === id);
  }
  const api = {
    sim, nodes, links,
    stop: () => sim.stop(),
    fit: () => { const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y); const pad = 60; const w = Math.max(...xs) - Math.min(...xs) + pad * 2, h = Math.max(...ys) - Math.min(...ys) + pad * 2; const k = Math.min(3, .95 / Math.max(w / W, h / H)); const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2; svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(W / 2 - k * cx, H / 2 - k * cy).scale(k)); },
    zoomBy: (f) => svg.transition().duration(250).call(zoom.scaleBy, f),
    reset: () => { nodes.forEach(n => { if (!n.hero) { n.fx = null; n.fy = null; } n.x = W / 2 + (Math.random() - .5) * 50; n.y = H / 2 + (Math.random() - .5) * 50; }); sim.alpha(1).restart(); svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity); },
    focusNode: (id) => { const n = nodes.find(x => x.id === id); if (!n) return; selected = id; focus(id); svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(W / 2 - 1.6 * n.x, H / 2 - 1.6 * n.y).scale(1.6)); },
    select: (ids) => { selected = ids && ids.length ? ids[0] : null; node.classed("sel", d => ids && ids.includes(d.id)); focus(selected); },
    pathBetween: (a, b) => {
      const adj = {}; links.forEach(l => { (adj[l.source.id] = adj[l.source.id] || []).push([l.target.id, l]); (adj[l.target.id] = adj[l.target.id] || []).push([l.source.id, l]); });
      const prev = { [a]: null }, q = [a]; while (q.length) { const u = q.shift(); if (u === b) break; for (const [v, l] of adj[u] || []) if (!(v in prev)) { prev[v] = [u, l]; q.push(v); } }
      if (!(b in prev)) return null; const path = []; let cur = b; while (prev[cur]) { path.unshift(prev[cur][1]); cur = prev[cur][0]; } return path; }
  };
  setTimeout(() => api.fit(), 700);
  return api;
}

function drawMap(container, sec) {
  if (S.graph) { S.graph.stop(); S.graph = null; }
  S.graph = renderGraph(container, buildGraph(sec), { sec });
}
function nodeTip(d, sec) {
  const c = co(d.id); const sh = sec ? shareIn(d.id, sec.id) : null; const cap = capOf(d.id);
  return `<b>${esc(c.name)}</b> <span style="opacity:.7">${c.type}</span><br>${sh != null ? `share ${sh}% · ` : ""}${cap ? `mkt cap ${fmtB(cap.market_cap_usd_b)}` : c.valuation_usd_b ? `valuation ${fmtB(c.valuation_usd_b)}` : ""}<br><span style="opacity:.8">${esc(c.blurb.slice(0, 140))}…</span>`;
}
const tipEl = () => $("#tooltip");
function tip(e, html) { const t = tipEl(); t.innerHTML = html; t.classList.remove("hidden"); moveTip(e); }
function moveTip(e) { const t = tipEl(); const x = Math.min(e.clientX + 14, window.innerWidth - 300), y = Math.min(e.clientY + 14, window.innerHeight - 120); t.style.left = x + "px"; t.style.top = y + "px"; }
function hideTip() { tipEl().classList.add("hidden"); }

/* ---- full-screen map overlay ---- */
let OV = { graph: null, sel: [] };
function openMapOverlay(sec) {
  const ov = $("#overlay"); ov.classList.remove("hidden"); document.body.style.overflow = "hidden";
  const title = sec ? sec.name : "The whole AI stack";
  const edgeBtn = (t, label) => el("button", { class: "qbtn" + (S.mapOpts.edges[t] ? " on" : ""), style: `--c:${EDGE_COLOR[t]}`, onclick: (e) => { S.mapOpts.edges[t] = !S.mapOpts.edges[t]; e.currentTarget.classList.toggle("on"); redraw(); } }, el("i", {}), label);
  const companiesInView = () => OV.graph ? OV.graph.nodes : [];
  ov.replaceChildren(
    el("div", { class: "ov-head" },
      el("div", {}, el("div", { class: "ov-title" }, title), el("div", { class: "small muted" }, sec ? `Node size: ${S.sizeBy === "share" ? sec.share_metric : "valuation / live market cap"}. Hover an edge for the deal. Click two companies to see how they connect.` : "Node size: valuation or live market cap. Colour: primary sector. Click two companies to see how they connect.")),
      el("div", { class: "ov-tools" },
        el("input", { id: "ov-search", placeholder: "Find a company…", list: "ov-list", onchange: (e) => { const q = e.target.value.toLowerCase(); const n = companiesInView().find(x => x.name.toLowerCase() === q) || companiesInView().find(x => x.name.toLowerCase().includes(q)); if (n) { OV.graph.focusNode(n.id); pick(n.id); } } }),
        el("datalist", { id: "ov-list" }),
        el("button", { class: "btn", onclick: () => OV.graph.zoomBy(1.4) }, "+"), el("button", { class: "btn", onclick: () => OV.graph.zoomBy(1 / 1.4) }, "−"),
        el("button", { class: "btn", onclick: () => OV.graph.fit() }, "Fit"), el("button", { class: "btn", onclick: () => { OV.graph.reset(); setTimeout(() => OV.graph.fit(), 1500); } }, "Reset layout"),
        el("button", { class: "btn", onclick: closeMapOverlay }, "✕ Close"))),
    el("div", { class: "ov-filters" },
      el("span", { class: "small muted" }, "Edges:"), edgeBtn("supplies", "supplies"), edgeBtn("invests", "invests in"), edgeBtn("partners", "partners"), edgeBtn("competes", "competes"),
      ...(sec ? [el("span", { class: "small muted", style: "margin-left:14px" }, "Show:"), el("button", { class: "qbtn" + (S.mapOpts.external ? " on" : ""), onclick: (e) => { S.mapOpts.external = !S.mapOpts.external; e.currentTarget.classList.toggle("on"); redraw(); } }, "outside companies"),
        el("span", { class: "small muted", style: "margin-left:14px" }, "Size:"), el("button", { class: "qbtn" + (S.sizeBy === "share" ? " on" : ""), onclick: () => { S.sizeBy = "share"; openMapOverlay(sec); } }, "market share"), el("button", { class: "qbtn" + (S.sizeBy === "valuation" ? " on" : ""), onclick: () => { S.sizeBy = "valuation"; openMapOverlay(sec); } }, "valuation")]
        : [el("span", { class: "small muted", style: "margin-left:14px" }, "Show:"), el("button", { class: "qbtn" + (S.mapOpts.everyone ? "" : " on"), onclick: () => { S.mapOpts.everyone = false; openMapOverlay(null); } }, "hubs (3+ links)"), el("button", { class: "qbtn" + (S.mapOpts.everyone ? " on" : ""), onclick: () => { S.mapOpts.everyone = true; openMapOverlay(null); } }, "all 121 companies")]),
      el("span", { style: "flex:1" }),
      ...(sec ? [el("span", { class: "legend" }, el("span", {}, el("span", { class: "dot", style: "background:#1e4d8c" }), "big tech"), el("span", {}, el("span", { class: "dot", style: "background:#1f8a4c" }), "startup"), el("span", {}, el("span", { class: "dot", style: "background:#b36b00" }), "public"), el("span", {}, el("span", { class: "dot", style: "background:#7b4fd6" }), "investor"), el("span", {}, el("span", { class: "dot", style: "background:#9a9a93" }), "outside sector"))]
        : [el("span", { class: "legend" }, ...S.data.sectors.map(s => el("span", {}, el("span", { class: "dot", style: `background:${s.color}` }), s.short)))])),
    el("div", { class: "ov-map", id: "ov-map" }),
    el("div", { class: "ov-rel hidden", id: "ov-rel" }));
  function pick(id) {
    if (!id) { OV.sel = []; OV.graph.select([]); $("#ov-rel").classList.add("hidden"); return; }
    if (OV.sel.length === 1 && OV.sel[0] !== id) OV.sel.push(id); else OV.sel = [id];
    OV.graph.select(OV.sel);
    const rel = $("#ov-rel"); rel.classList.remove("hidden");
    const a = co(OV.sel[0]);
    if (OV.sel.length === 1) { rel.replaceChildren(el("div", { class: "rel-head" }, el("b", {}, a.name), el("button", { class: "btn small", onclick: () => openDossier(OV.sel[0]) }, "Open dossier")), el("div", { class: "small muted" }, "Click a second company to see the relationship.")); return; }
    const b = co(OV.sel[1]);
    const direct = S.data.connections.filter(c => (c.source === OV.sel[0] && c.target === OV.sel[1]) || (c.source === OV.sel[1] && c.target === OV.sel[0]));
    const path = direct.length ? null : OV.graph.pathBetween(OV.sel[0], OV.sel[1]);
    const line = (c) => el("div", { class: "rel-line" }, el("span", { class: "k " + c.type }, c.type === "invests" ? "invests in" : c.type), " ", el("b", {}, co(c.source).name), " → ", el("b", {}, co(c.target).name), c.label ? el("span", { class: "muted" }, ` — ${c.label}`) : null);
    rel.replaceChildren(
      el("div", { class: "rel-head" }, el("b", {}, `${a.name} ↔ ${b.name}`), el("span", {}, el("button", { class: "btn small", onclick: () => openDossier(OV.sel[0]) }, a.name.split(" ")[0]), " ", el("button", { class: "btn small", onclick: () => openDossier(OV.sel[1]) }, b.name.split(" ")[0]))),
      ...(direct.length ? direct.map(line) : path ? [el("div", { class: "small muted" }, `No direct link. Shortest path (${path.length} hops):`), ...path.flatMap(l => (l.types || [l.type]).map((t, i) => line({ source: l.source.id, target: l.target.id, type: t, label: (l.labels[i] || "").replace(/^\w+: /, "") })))] : [el("div", { class: "small muted" }, "No path with the current edge filters.")]));
  }
  function redraw() { if (OV.graph) OV.graph.stop(); const g = buildGraph(sec, { full: true }); OV.graph = renderGraph($("#ov-map"), g, { full: true, sec, onSelect: pick }); $("#ov-list").replaceChildren(...g.nodes.map(n => el("option", { value: n.name }))); OV.sel = []; $("#ov-rel").classList.add("hidden"); }
  redraw();
}
function closeMapOverlay() { $("#overlay").classList.add("hidden"); document.body.style.overflow = ""; if (OV.graph) { OV.graph.stop(); OV.graph = null; } }
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#overlay").classList.contains("hidden")) closeMapOverlay(); });

/* ---------------- charts ---------------- */
function barChart(container, data, { fmt = v => v } = {}) {
  const W = container.clientWidth || 400, H = 150, m = { t: 18, r: 6, b: 22, l: 6 };
  const svg = d3.select(container).html("").append("svg").attr("viewBox", [0, 0, W, H]);
  const x = d3.scaleBand().domain(data.map(d => d.label)).range([m.l, W - m.r]).padding(.25);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.value) * 1.1]).range([H - m.b, m.t]);
  svg.append("g").selectAll("rect").data(data).join("rect").attr("class", d => "bar" + (d.proj ? " proj" : "")).attr("x", d => x(d.label)).attr("y", d => y(d.value)).attr("width", x.bandwidth()).attr("height", d => y(0) - y(d.value)).attr("rx", 3);
  svg.append("g").selectAll("text.val").data(data).join("text").attr("class", "val").attr("x", d => x(d.label) + x.bandwidth() / 2).attr("y", d => y(d.value) - 4).attr("text-anchor", "middle").text(d => fmt(d.value));
  svg.append("g").selectAll("text.lab").data(data).join("text").attr("x", d => x(d.label) + x.bandwidth() / 2).attr("y", H - 6).attr("text-anchor", "middle").text(d => d.label + (d.proj ? "E" : ""));
}
function groupedBars(container, data) {
  const W = container.clientWidth || 400, H = 190, m = { t: 16, r: 6, b: 34, l: 6 };
  const svg = d3.select(container).html("").append("svg").attr("viewBox", [0, 0, W, H]);
  const x = d3.scaleBand().domain(data.map(d => d.label)).range([m.l, W - m.r]).padding(.2);
  const x2 = d3.scaleBand().domain(["a", "b"]).range([0, x.bandwidth()]).padding(.1);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.b) * 1.1]).range([H - m.b, m.t]);
  const g = svg.append("g").selectAll("g").data(data).join("g").attr("transform", d => `translate(${x(d.label)},0)`);
  g.append("rect").attr("x", x2("a")).attr("width", x2.bandwidth()).attr("y", d => y(d.a)).attr("height", d => y(0) - y(d.a)).attr("fill", d => d.color).attr("rx", 2);
  g.append("rect").attr("x", x2("b")).attr("width", x2.bandwidth()).attr("y", d => y(d.b)).attr("height", d => y(0) - y(d.b)).attr("fill", d => d.color).attr("opacity", .45).attr("rx", 2);
  g.append("text").attr("class", "val").attr("x", x2("b") + x2.bandwidth() / 2).attr("y", d => y(d.b) - 3).attr("text-anchor", "middle").text(d => fmtB(d.b));
  g.append("text").attr("x", x.bandwidth() / 2).attr("y", H - 20).attr("text-anchor", "middle").text(d => d.label);
  svg.append("text").attr("x", m.l).attr("y", H - 4).text("solid = 2025 · faded = 2030E");
}
function donut(container, legend, sec) {
  const members = sec.members.filter(m => m.share != null).sort((a, b) => b.share - a.share);
  const top = members.slice(0, 8); const rest = members.slice(8).reduce((a, m) => a + m.share, 0);
  const total = members.reduce((a, m) => a + m.share, 0); const other = Math.max(0, 100 - total) + rest;
  const data = [...top.map(m => ({ id: m.id, name: co(m.id).name.split(" (")[0], v: m.share })), ...(other > 0 ? [{ id: null, name: "Others / long tail", v: +other.toFixed(1) }] : [])];
  const W = 190, R = 85; const color = d3.scaleOrdinal().domain(data.map(d => d.name)).range([sec.color, ...d3.schemeTableau10.filter(c => c !== sec.color), "#bbb"]);
  const svg = d3.select(container).html("").append("svg").attr("viewBox", [0, 0, W, W]);
  const arcs = d3.pie().value(d => d.v).sort(null)(data);
  svg.append("g").attr("transform", `translate(${W / 2},${W / 2})`).selectAll("path").data(arcs).join("path").attr("d", d3.arc().innerRadius(R * .58).outerRadius(R)).attr("fill", d => d.data.id ? color(d.data.name) : "#bbb").attr("stroke", "var(--paper)").style("cursor", d => d.data.id ? "pointer" : "default").on("click", (e, d) => d.data.id && openDossier(d.data.id)).on("mouseenter", (e, d) => tip(e, `<b>${esc(d.data.name)}</b> ${d.data.v}%`)).on("mousemove", moveTip).on("mouseleave", hideTip);
  svg.append("text").attr("x", W / 2).attr("y", W / 2 - 4).attr("text-anchor", "middle").attr("class", "val").style("font-size", "20px").text(top[0] ? top[0].share + "%" : "");
  svg.append("text").attr("x", W / 2).attr("y", W / 2 + 12).attr("text-anchor", "middle").text(top[0] ? co(top[0].id).name.split(" ")[0] : "");
  legend.replaceChildren(el("div", { class: "donut-legend" }, ...data.flatMap(d => [el("span", { style: d.id ? "cursor:pointer" : "", onclick: () => d.id && openDossier(d.id) }, el("i", { style: `background:${d.id ? color(d.name) : "#bbb"}` }), d.name), el("span", {}, d.v + "%")])));
}
function hbars(container, rows, { suffix = "%", colors } = {}) {
  const max = Math.max(...rows.map(r => r[1]));
  container.replaceChildren(...rows.flatMap(([l, v], i) => [el("span", { class: "lab", title: l }, l), el("div", { class: "track" }, el("i", { style: `width:${100 * v / max}%;${colors ? "background:" + colors[i] : ""}` })), el("span", {}, v + suffix)]));
}

/* ---------------- company dossier ---------------- */
async function openDossier(cid) {
  const c = co(cid); if (!c) return;
  const want = `#/${S.tab}/${S.sub}/company/${cid}`;
  if (location.hash !== want) history.pushState(null, "", want);
  const d = $("#drawer"), bd = $("#drawer-backdrop"); d.classList.remove("hidden"); bd.classList.remove("hidden"); bd.onclick = () => closeDossier(true);
  const cap = capOf(cid); const secs = memberSectors(cid);
  const conns = S.data.connections.filter(x => x.source === cid || x.target === cid);
  const grouped = {}; conns.forEach(x => { const other = x.source === cid ? x.target : x.source; const dir = x.source === cid; let k = x.type; if (x.type === "invests") k = dir ? "invests" : "backed by"; if (x.type === "supplies") k = dir ? "supplies" : "supplied by"; (grouped[k] = grouped[k] || []).push({ other, label: x.label, type: x.type }); });
  d.replaceChildren(
    el("button", { class: "close", onclick: () => closeDossier(true) }, "×"),
    el("h2", {}, c.name, el("span", { class: "type " + c.type }, c.type)),
    el("div", { class: "small muted" }, [c.hq, c.founded ? `founded ${c.founded}` : null, c.ticker ? `ticker ${c.ticker}` : null].filter(Boolean).join(" · "), " · ", el("a", { href: c.site, target: "_blank", rel: "noopener" }, c.site.replace(/^https?:\/\//, ""))),
    el("p", { class: "blurb" }, c.blurb),
    c.overview ? el("section", { class: "about" }, el("h4", {}, "About the business"), el("p", {}, c.overview)) : null,
    el("div", { class: "facts" },
      ...(cap ? [fact(fmtB(cap.market_cap_usd_b), "Market cap (live)"), fact((cap.change_pct >= 0 ? "+" : "") + cap.change_pct + "%", "Today", cap.change_pct >= 0 ? "pos" : "neg")] : c.valuation_usd_b ? [fact(fmtB(c.valuation_usd_b), "Last valuation")] : []),
      ...secs.map(s => fact(shareIn(cid, s.id) != null ? shareIn(cid, s.id) + "%" : "enabler", `Share · ${s.short}`))),
    el("div", { class: "small" }, "Sectors: ", ...secs.map(s => el("span", { class: "chip sec", onclick: () => { closeDossier(false); go(s.id); } }, el("i", { style: `background:${s.color}` }), s.short))),
    el("h3", {}, "Supply chain"), supplyChain(cid),
    el("h3", {}, "Products"), el("div", {}, ...(c.products || []).map(p => el("span", { class: "chip", style: "margin:2px 4px 2px 0" }, p))),
    el("h3", {}, `Connections (${conns.length})`), el("div", { class: "conn" }, ...Object.entries(grouped).flatMap(([k, arr]) => [el("div", { class: "k " + arr[0].type }, k), el("div", { class: "v" }, ...arr.map(a => el("span", {}, el("a", { href: "#", onclick: (e) => { e.preventDefault(); openDossier(a.other); } }, co(a.other).name), a.label ? el("span", { class: "muted" }, ` — ${a.label}`) : null)))])),
    el("h3", {}, "Latest news ", el("span", { class: "spinner", id: "news-spin" })), el("ul", { class: "mini", id: "co-news" }));
  d.scrollTop = 0;
  try {
    const j = await api(`/api/company/${cid}/news`);
    $("#news-spin")?.remove();
    const list = $("#co-news"); if (!list) return;
    list.replaceChildren(...(j.items.length ? j.items.slice(0, 20).map(i => el("li", {}, el("a", { href: i.link, target: "_blank", rel: "noopener" }, i.title), el("div", { class: "m" }, `${i.source} · ${ago(i.ts)}${i.funding?.amount_usd_m ? " · " : ""}`, i.funding?.amount_usd_m ? el("span", { class: "amount" }, fmtM(i.funding.amount_usd_m)) : null))) : [el("li", { class: "muted" }, "No recent coverage found.")]));
  } catch { $("#news-spin")?.remove(); }
}
const fact = (v, l, cls = "") => el("div", { class: "fact" }, el("div", { class: "v " + cls }, v), el("div", { class: "l" }, l));
function closeDossier(updateHash) {
  $("#drawer").classList.add("hidden"); $("#drawer-backdrop").classList.add("hidden");
  if (updateHash && location.hash.includes("/company/")) history.replaceState(null, "", `#/${S.tab}/${S.sub}`);
}
function supplyChain(cid) {
  const c = co(cid); const ch = c.chain || {};
  const name = (id) => co(id).name.split(" (")[0];
  const sup = [...(ch.suppliers || [])], cus = [...(ch.customers || [])], inv = [], par = [...(ch.partners || [])];
  S.data.connections.forEach(x => {
    if (x.target === cid && x.type === "supplies" && !sup.some(s => s.toLowerCase().includes(name(x.source).toLowerCase()))) sup.push(name(x.source));
    if (x.source === cid && x.type === "supplies" && !cus.some(s => s.toLowerCase().includes(name(x.target).toLowerCase()))) cus.push(name(x.target));
    if (x.target === cid && x.type === "invests") inv.push(name(x.source));
    if (x.type === "partners" && (x.source === cid || x.target === cid)) { const o = name(x.source === cid ? x.target : x.source); if (!par.some(p => p.toLowerCase().includes(o.toLowerCase()))) par.push(o); }
  });
  const L = sup.slice(0, 8), R = cus.slice(0, 8), T = inv.slice(0, 8), B = par.slice(0, 8);
  const W = 640, rowH = 26, colW = 200, topH = T.length ? 60 : 10, midH = Math.max(L.length, R.length, 1) * rowH + 20, botH = B.length ? 60 : 10, H = topH + midH + botH + 20;
  const svg = d3.create("svg").attr("class", "sc").attr("viewBox", [0, 0, W, H]);
  const box = (x, y, w, h, text, cls = "") => { svg.append("rect").attr("class", "box " + cls).attr("x", x).attr("y", y).attr("width", w).attr("height", h).attr("rx", 5); svg.append("text").attr("x", x + w / 2).attr("y", y + h / 2 + 4).attr("text-anchor", "middle").text(text.length > 30 ? text.slice(0, 29) + "…" : text); };
  const cx = W / 2 - 70, cy = topH + midH / 2 - 14;
  svg.append("text").attr("class", "col-title").attr("x", 10).attr("y", topH + 6).text("Suppliers & inputs");
  svg.append("text").attr("class", "col-title").attr("x", W - colW - 10).attr("y", topH + 6).text("Customers & channels");
  L.forEach((s, i) => { const y = topH + 14 + i * rowH; box(10, y, colW, 20, s); svg.append("path").attr("class", "sup").attr("d", `M${10 + colW},${y + 10}C${cx - 40},${y + 10} ${cx - 40},${cy + 14} ${cx},${cy + 14}`); });
  R.forEach((s, i) => { const y = topH + 14 + i * rowH; box(W - colW - 10, y, colW, 20, s); svg.append("path").attr("class", "cus").attr("d", `M${cx + 140},${cy + 14}C${cx + 180},${cy + 14} ${cx + 180},${y + 10} ${W - colW - 10},${y + 10}`); });
  box(cx, cy, 140, 28, c.name.split(" (")[0], "center");
  if (T.length) { svg.append("text").attr("class", "col-title").attr("x", 10).attr("y", 12).text("Backed by"); T.forEach((s, i) => { const w = Math.min(120, (W - 20) / T.length - 6); const x = 10 + i * (w + 6); box(x, 18, w, 20, s); svg.append("path").attr("class", "inv").attr("d", `M${x + w / 2},38C${x + w / 2},${cy - 20} ${cx + 70},${cy - 30} ${cx + 70},${cy}`); }); }
  if (B.length) { const y0 = topH + midH + 12; svg.append("text").attr("class", "col-title").attr("x", 10).attr("y", y0).text("Partners"); B.forEach((s, i) => { const w = Math.min(120, (W - 20) / B.length - 6); box(10 + i * (w + 6), y0 + 6, w, 20, s); }); }
  return svg.node();
}

boot();
})();
