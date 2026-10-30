import { useState, useEffect, useMemo } from "react";
import { fmt$, fmtN, normalizeBodyType } from "./utils/format";
import { dealTier } from "./utils/scoreColor.js";
import DealBadge from "./components/deals/DealBadge";

const API = process.env.REACT_APP_API_URL || "http://localhost:5001/api";

// Body types that support Small/Medium/Large sub-filtering (matched lowercase)
const SIZE_SUPPORTED = new Set(["suv", "truck", "sedan", "hatchback"]);

// Approximate size bands by predicted price (proxy for vehicle size within a category)
const SIZE_PRICE_BANDS = {
  Small: { max: 22000 },
  Medium: { min: 18000, max: 40000 },
  Large: { min: 35000 },
};

// Persist the theme choice under the same key the pre-paint script in
// public/index.html reads, so a refresh restores it with no flash.
const THEME_KEY = "carintel-theme";

// Small semicircular-gauge glyph used as the brand mark (a fuel-gauge echo,
// not a data visualization).
function BrandMark({ size = 22 }) {
  const r = size * 0.42;
  const cx = size / 2;
  const cy = size / 2 + r * 0.15;
  const a = Math.PI * 0.32;
  return (
    <svg width={size} height={size * 0.64} viewBox={`0 0 ${size} ${size * 0.64}`} aria-hidden="true">
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`}
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth={size * 0.13}
        strokeLinecap="round"
      />
      <line
        x1={cx}
        y1={cy}
        x2={cx + r * 0.72 * Math.cos(a)}
        y2={cy - r * 0.72 * Math.sin(a)}
        stroke="var(--color-accent)"
        strokeWidth={size * 0.1}
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r={size * 0.09} fill="var(--color-accent)" />
    </svg>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("theme-dark")
  );

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("theme-dark", next);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", next ? "#0f172a" : "#f8fafc");
    try {
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch (e) {}
  };

  return (
    <button
      onClick={toggle}
      title="Switch panel lighting"
      aria-label={dark ? "Switch to day lighting" : "Switch to night lighting"}
      style={{
        position: "relative",
        width: 46,
        height: 22,
        borderRadius: 4,
        background: "var(--color-surface-subtle)",
        border: "1px solid var(--color-border-strong)",
        boxShadow: "var(--shadow-inset)",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 5,
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: 10,
          lineHeight: 1,
          color: "var(--color-text-subtle)",
          opacity: dark ? 0.35 : 1,
        }}
      >
        ☀
      </span>
      <span
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: 10,
          lineHeight: 1,
          color: "var(--color-text-subtle)",
          opacity: dark ? 1 : 0.35,
        }}
      >
        ☾
      </span>
      <span
        style={{
          position: "absolute",
          top: 2,
          left: dark ? 25 : 2,
          width: 19,
          height: 16,
          borderRadius: 3,
          background: "var(--color-accent)",
          transition: "left 0.18s ease",
        }}
      />
    </button>
  );
}

function FilterSelect({ label, value, onChange, children, minWidth = 120, disabled = false }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, opacity: disabled ? 0.45 : 1 }}>
      <span style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 12.5, color: "var(--color-text-muted)" }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-inset)",
          borderRadius: 5,
          color: value ? "var(--color-text-primary)" : "var(--color-text-muted)",
          fontFamily: "'Public Sans', sans-serif",
          fontSize: 13,
          outline: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          padding: "7px 9px",
          minWidth,
        }}
      >
        {children}
      </select>
    </label>
  );
}

// Minimum-grade filter as labelled choices; value is the lowest deal tier
// shown (scoreColor.js: 3 = Fair price, 4 = Good deal, 5 = Great deal).
const GRADE_CHOICES = [
  { tier: 1, label: "Any price" },
  { tier: 3, label: "Fair or better" },
  { tier: 4, label: "Good deals" },
  { tier: 5, label: "Great deals only" },
];

function GradeFilter({ value, onChange }) {
  return (
    <div role="group" aria-label="Show listings" className="grade-filter" style={{ display: "inline-flex", gap: 1, background: "var(--color-border)", border: "1px solid var(--color-border)", borderRadius: 6, overflow: "hidden" }}>
      {GRADE_CHOICES.map(({ tier, label }) => {
        const on = value === tier;
        return (
          <button
            key={tier}
            aria-pressed={on}
            onClick={() => onChange(tier)}
            style={{
              background: on ? "var(--color-accent)" : "var(--color-surface)",
              color: on ? "var(--color-on-accent)" : "var(--color-text-secondary)",
              border: "none",
              padding: "6px 12px",
              fontFamily: "'Public Sans', sans-serif",
              fontSize: 13,
              fontWeight: on ? 600 : 500,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// "$6,125 below market" reads the right way round; arrows and a "Savings"
// column that goes negative did not.
function vsMarket(savings) {
  if (savings == null) return { text: "—", color: "var(--color-text-muted)" };
  if (Math.abs(savings) < 50) return { text: "At market", color: "var(--color-text-secondary)" };
  return savings > 0
    ? { text: `${fmt$(savings)} below market`, color: "var(--color-success)" }
    : { text: `${fmt$(-savings)} above market`, color: "var(--color-danger)" };
}

const fmtUpdated = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ── URLs ─────────────────────────────────────────────────────────────────────
// Each view has a path and its inputs live in the query string, so Back works
// and a filtered search or an estimate can be bookmarked or shared. Cloudflare
// Pages serves index.html for any path (the build has no 404.html).
const PATHS = { home: "/", results: "/listings", estimator: "/price-check" };

function fromUrl() {
  const q = new URLSearchParams(window.location.search);
  const view = Object.keys(PATHS).find((v) => PATHS[v] === window.location.pathname) || "home";
  const get = (k, d = "") => (view === "home" ? d : q.get(k) ?? d);
  const grade = Number(get("grade", "1"));
  return {
    view,
    make: get("make"), model: get("model"), trim: get("trim"),
    body: get("body"), size: get("size"),
    yearFrom: get("year_from"), yearTo: get("year_to"),
    milesFrom: get("miles_from"), milesTo: get("miles_to"),
    grade: [1, 3, 4, 5].includes(grade) ? grade : 1,
    sort: ["score", "savings", "price", "mileage", "year"].includes(get("sort")) ? get("sort") : "score",
    dir: get("dir") === "asc" ? "asc" : "desc",
    year: get("year"), mileage: get("mileage"),
  };
}

function toUrl(view, params) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v != null) q.set(k, v);
  });
  const qs = q.toString();
  return PATHS[view] + (qs ? `?${qs}` : "");
}

const PAGE_TITLES = { home: "Car Intel: is this used car priced fairly?", results: "Used car listings graded by price | Car Intel", estimator: "Used car price check | Car Intel" };

export default function CarIntelDashboard() {
  const initial = useMemo(fromUrl, []);
  const [view, setView] = useState(initial.view); // "home" | "results" | "estimator"

  const [makeFilter, setMakeFilter] = useState(initial.view === "results" ? initial.make : "");
  const [modelFilter, setModelFilter] = useState(initial.view === "results" ? initial.model : "");
  const [sizeFilter, setSizeFilter] = useState(initial.size);
  const [bodyFilter, setBodyFilter] = useState(initial.body);
  const [minYear, setMinYear] = useState(initial.yearFrom);
  const [maxYear, setMaxYear] = useState(initial.yearTo);
  const [minMileage, setMinMileage] = useState(initial.milesFrom);
  const [maxMileage, setMaxMileage] = useState(initial.milesTo);
  const [minStars, setMinStars] = useState(initial.grade);

  const [selectedDeal, setSelectedDeal] = useState(null);
  const [tickerIdx, setTickerIdx] = useState(0);

  const [deals, setDeals] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState({ deals: true, stats: true });
  const [apiError, setApiError] = useState(false);

  const [sortKey, setSortKey] = useState(initial.sort); // score | savings | price | mileage | year
  const [sortDir, setSortDir] = useState(initial.dir); // asc | desc
  const [visibleCount, setVisibleCount] = useState(100); // rendered rows — see perf note below

  const isEst = initial.view === "estimator";
  const [estMake, setEstMake] = useState(isEst ? initial.make : "");
  const [estModel, setEstModel] = useState(isEst ? initial.model : "");
  const [estYear, setEstYear] = useState(isEst ? initial.year : "");
  const [estMileage, setEstMileage] = useState(isEst ? initial.mileage : "");
  const [estTrim, setEstTrim] = useState(isEst ? initial.trim : "");
  const [preview, setPreview] = useState([]); // top deals, shown while the full list loads
  const [estResult, setEstResult] = useState(null);
  const [estLoading, setEstLoading] = useState(false);
  const [estError, setEstError] = useState(null);

  useEffect(() => {
    const load = async (key, url, setter) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        setter(data);
      } catch (e) {
        console.error(`Failed to load ${key}:`, e);
        setApiError(true);
      } finally {
        setLoading((l) => ({ ...l, [key]: false }));
      }
    };

    // Listing URLs come from third-party data: only http(s) may reach an href.
    const safeUrls = (rows) => rows.map((d) => ({ ...d, url: /^https?:\/\//i.test(d.url || "") ? d.url : null }));
    // The top 100 deals arrive in a fraction of the full list's time, so the
    // first screen shows real listings while everything else downloads.
    fetch(`${API}/deals?limit=100`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setPreview(safeUrls(rows)))
      .catch(() => {});
    load("deals", `${API}/deals?min_score=0`, (rows) => setDeals(safeUrls(rows)));
    load("stats", `${API}/stats`, setStats);
  }, []);

  const makeOptions = useMemo(() => {
    const set = new Set();
    (deals || []).forEach((d) => {
      if (d.make) set.add(d.make.toLowerCase());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals]);

  const modelOptions = useMemo(() => {
    if (!makeFilter) return [];
    const set = new Set();
    (deals || [])
      .filter((d) => d.make?.toLowerCase() === makeFilter)
      .forEach((d) => {
        if (d.model) set.add(d.model.toLowerCase());
      });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals, makeFilter]);

  const yearOptions = useMemo(() => {
    const set = new Set();
    (deals || []).forEach((d) => {
      if (d.year) set.add(d.year);
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [deals]);

  const estModelOptions = useMemo(() => {
    if (!estMake) return [];
    const set = new Set();
    (deals || [])
      .filter((d) => d.make?.toLowerCase() === estMake)
      .forEach((d) => {
        if (d.model) set.add(d.model.toLowerCase());
      });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals, estMake]);

  const estTrimOptions = useMemo(() => {
    if (!estMake || !estModel) return [];
    const set = new Set();
    (deals || [])
      .filter((d) => d.make?.toLowerCase() === estMake && d.model?.toLowerCase() === estModel)
      .forEach((d) => {
        if (d.trim) set.add(d.trim.trim());
      });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals, estMake, estModel]);

  const bodyOptions = useMemo(() => {
    const set = new Set();
    (deals || []).forEach((d) => set.add(normalizeBodyType(d.body_type)));
    const opts = Array.from(set).sort((a, b) => a.localeCompare(b));
    const unknownIdx = opts.indexOf("Unknown");
    if (unknownIdx >= 0) {
      opts.splice(unknownIdx, 1);
      opts.push("Unknown");
    }
    return opts;
  }, [deals]);

  const topTickerDeals = useMemo(() => {
    return (deals || [])
      .filter((d) => d.deal_score != null)
      .slice()
      .sort((a, b) => (b.deal_score ?? 0) - (a.deal_score ?? 0));
  }, [deals]);

  useEffect(() => {
    if (!topTickerDeals.length) return;
    const id = setInterval(() => setTickerIdx((i) => (i + 1) % Math.min(topTickerDeals.length, 10)), 3000);
    return () => clearInterval(id);
  }, [topTickerDeals]);

  const filteredDeals = useMemo(() => {
    const arr = (deals || [])
      .filter((d) => d.deal_score != null)
      .filter((d) => dealTier(d.deal_score) >= minStars)
      .filter((d) => !makeFilter || d.make?.toLowerCase() === makeFilter)
      .filter((d) => !modelFilter || d.model?.toLowerCase() === modelFilter)
      .filter((d) => !bodyFilter || normalizeBodyType(d.body_type).toLowerCase() === bodyFilter.toLowerCase())
      .filter((d) => {
        if (!sizeFilter) return true;
        const band = SIZE_PRICE_BANDS[sizeFilter];
        if (!band) return true;
        const p = d.predicted_price ?? d.price;
        if (band.min && p < band.min) return false;
        if (band.max && p > band.max) return false;
        return true;
      })
      .filter((d) => !minYear || d.year >= Number(minYear))
      .filter((d) => !maxYear || d.year <= Number(maxYear))
      .filter((d) => !minMileage || d.mileage >= Number(minMileage))
      .filter((d) => !maxMileage || d.mileage <= Number(maxMileage));

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : -Infinity;
    };

    const getVal = (d) => {
      if (sortKey === "score") return num(d.deal_score);
      if (sortKey === "price") return num(d.price);
      if (sortKey === "savings") return num(d.savings);
      if (sortKey === "mileage") return num(d.mileage);
      if (sortKey === "year") return num(d.year);
      return num(d.deal_score);
    };

    const dir = sortDir === "asc" ? 1 : -1;

    arr.sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
      if (av === bv) {
        return num(b.deal_score) - num(a.deal_score);
      }
      return (av - bv) * dir;
    });

    return arr;
  }, [deals, minStars, makeFilter, modelFilter, sizeFilter, bodyFilter, minYear, maxYear, minMileage, maxMileage, sortKey, sortDir]);

  // Rendering every fetched listing (~13k) as DOM rows at once is what made
  // the results page laggy — cap the rendered slice and let people load
  // more, instead of rendering everything up front.
  useEffect(() => {
    setVisibleCount(100);
  }, [minStars, makeFilter, modelFilter, sizeFilter, bodyFilter, minYear, maxYear, minMileage, maxMileage, sortKey, sortDir]);

  const displayedDeals = useMemo(() => filteredDeals.slice(0, visibleCount), [filteredDeals, visibleCount]);

  // Keep the address bar in step with the view and its inputs. A new view is
  // a history entry (Back returns to it); filter changes replace the current
  // entry so Back doesn't replay every dropdown change.
  useEffect(() => {
    const url =
      view === "results"
        ? toUrl(view, { make: makeFilter, model: modelFilter, body: bodyFilter, size: sizeFilter, year_from: minYear, year_to: maxYear, miles_from: minMileage, miles_to: maxMileage, grade: minStars > 1 ? minStars : "", sort: sortKey !== "score" ? sortKey : "", dir: sortDir !== "desc" ? sortDir : "" })
        : view === "estimator"
        ? toUrl(view, { make: estMake, model: estModel, trim: estTrim, year: estYear, mileage: estMileage })
        : toUrl(view, {});
    const here = window.location.pathname + window.location.search;
    if (url === here) return;
    if (PATHS[view] !== window.location.pathname) {
      window.history.pushState(null, "", url);
      window.scrollTo(0, 0);
    } else {
      window.history.replaceState(null, "", url);
    }
  }, [view, makeFilter, modelFilter, bodyFilter, sizeFilter, minYear, maxYear, minMileage, maxMileage, minStars, sortKey, sortDir, estMake, estModel, estTrim, estYear, estMileage]);

  useEffect(() => {
    document.title = PAGE_TITLES[view];
  }, [view]);

  // Back/Forward: restore the view and inputs the URL describes.
  useEffect(() => {
    const onPop = () => {
      const u = fromUrl();
      setView(u.view);
      setSelectedDeal(null);
      if (u.view === "results") {
        setMakeFilter(u.make); setModelFilter(u.model); setBodyFilter(u.body); setSizeFilter(u.size);
        setMinYear(u.yearFrom); setMaxYear(u.yearTo); setMinMileage(u.milesFrom); setMaxMileage(u.milesTo);
        setMinStars(u.grade); setSortKey(u.sort); setSortDir(u.dir);
      } else if (u.view === "estimator") {
        setEstMake(u.make); setEstModel(u.model); setEstTrim(u.trim); setEstYear(u.year); setEstMileage(u.mileage);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const runEstimate = async () => {
    if (!estMake || !estModel || !estYear || !estMileage) {
      setEstError("Fill in make, model, year, and mileage to get an estimate.");
      return;
    }
    setEstLoading(true);
    setEstError(null);
    setEstResult(null);
    try {
      const params = new URLSearchParams({ make: estMake, model: estModel, year: estYear, mileage: estMileage, ...(estTrim && { trim: estTrim }) });
      const res = await fetch(`${API}/predict?${params}`);
      const data = await res.json().catch(() => ({}));
      // The API's 400 messages are written for people ("year must be between …").
      if (!res.ok || data.error) throw new Error(res.status === 400 && data.error ? data.error : "The estimate isn't available right now. Try again in a minute.");
      setEstResult(data);
    } catch (e) {
      setEstError(e instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : e.message);
    } finally {
      setEstLoading(false);
    }
  };


  // A shared price-check link carries everything the estimate needs: run it.
  useEffect(() => {
    if (initial.view === "estimator" && initial.make && initial.model && initial.year && initial.mileage) runEstimate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  const currentTicker = topTickerDeals[tickerIdx] || {};
  const isLoading = Object.values(loading).some(Boolean);

  const handleSelectDeal = (deal) => {
    setSelectedDeal((cur) => (cur?.listing_id === deal.listing_id ? null : deal));
  };

  const resetFilters = () => {
    setMakeFilter("");
    setModelFilter("");
    setSizeFilter("");
    setBodyFilter("");
    setMinYear("");
    setMaxYear("");
    setMinMileage("");
    setMaxMileage("");
    setMinStars(1);
  };

  // All colour tokens live in theme.css; styles below reference them via
  // var(--color-*) so day/night (and any future theme) work with no JS.
  const sharedStyles = `
    @import url('https://fonts.googleapis.com/css2?family=Overpass:wght@400;600;700;800&family=Public+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    *:focus-visible { outline: 2px solid var(--color-info); outline-offset: 2px; }
    ::-webkit-scrollbar { width: 4px; background: var(--color-surface-subtle); }
    ::-webkit-scrollbar-thumb { background: var(--color-border-strong); border-radius: 2px; }
    .deal-row { transition: background 0.15s; cursor: pointer; }
    .deal-row:hover { background: var(--color-surface-subtle) !important; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    @keyframes panelIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
    @media (prefers-reduced-motion: reduce) {
      .deal-row, .home-search-btn { transition: none !important; }
      .panel-in { animation: none !important; }
    }
    .home-search-btn { transition: background 0.15s, transform 0.1s; }
    .home-search-btn:hover { background: var(--color-accent-hover) !important; }
    .home-search-btn:active { transform: translateY(1px); }
    select option { color: var(--color-text-primary); background: var(--color-surface); }
    .chip-btn { transition: color 0.15s, border-color 0.15s; border-bottom: 2px solid transparent; }
    .chip-btn:hover { color: var(--color-accent) !important; border-bottom-color: var(--color-accent); }
    .nav-link { position: relative; }
    .nav-link::after { content: ""; position: absolute; left: 0; right: 0; bottom: -3px; height: 1px; background: var(--color-accent); transform: scaleX(0); transition: transform 0.15s; }
    .nav-link:hover::after { transform: scaleX(1); }

    /* Window-sticker plate: mimics a Monroney-style spec label. Reserved for
       the expanded listing panel and the estimator result — not used as
       generic chrome elsewhere. */
    .sticker-label { font-family: 'Public Sans', sans-serif; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); }

    /* Results table: one grid shared by header and rows. On phones it folds
       into two columns (vehicle | price, then vs-market | grade) and drops
       the secondary columns instead of scrolling sideways. */
    .deal-grid { display: grid; grid-template-columns: minmax(0,1fr) 100px 110px 170px 100px 56px 120px; min-width: 860px; align-items: center; column-gap: 12px; }
    .deal-row:focus-visible { outline-offset: -2px; }
    .best-pick { transition: background 0.15s; }
    .best-pick:hover { background: var(--color-surface-subtle) !important; }

    @media (max-width: 860px) {
      .hero-grid { grid-template-columns: 1fr !important; gap: 28px !important; }
      .hero-grid > div:last-child { order: -1; max-width: 280px; margin: 0 auto; }
    }
    @media (max-width: 720px) {
      .header-stats { display: none !important; }
      .page-pad { padding-left: 16px !important; padding-right: 16px !important; }
      .deal-grid { grid-template-columns: minmax(0,1fr) auto; min-width: 0; row-gap: 6px; }
      .deal-head, .col-optional { display: none !important; }
      .grade-filter { display: grid !important; grid-template-columns: 1fr 1fr; width: 100%; }
      .deal-row.deal-grid > :nth-child(2), .deal-row.deal-grid > :last-child { justify-self: end; }
      .filters > label, .filters > div { flex: 1 1 140px; }
      .filters select { width: 100%; }
    }
    @media (max-width: 620px) {
      .best-deal-chip { display: none !important; }
    }
    @media (max-width: 480px) {
      .est-grid { grid-template-columns: 1fr !important; }
    }
  `;

  const gridBg = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        backgroundImage:
          "linear-gradient(var(--color-grid) 1px,transparent 1px),linear-gradient(90deg,var(--color-grid) 1px,transparent 1px)",
        backgroundSize: "36px 36px",
        zIndex: 0,
      }}
    />
  );

  const statReadout = (label, value) => (
    <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
          fontWeight: 700,
          color: "var(--color-text-primary)",
        }}
      >
        {value}
      </div>
      <div style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 11.5, color: "var(--color-text-subtle)" }}>{label}</div>
    </div>
  );

  const statCluster = (
    <>
      {statReadout("Listings", isLoading ? "—" : fmtN(stats.graded_listings))}
      {statReadout("Makes", isLoading ? "—" : stats.makes)}
      {statReadout("Avg. price", isLoading ? "—" : fmt$(stats.avg_price))}
    </>
  );

  const brandButton = (onClick) => (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        background: "none",
        border: "none",
        cursor: onClick ? "pointer" : "default",
        padding: 0,
      }}
    >
      <BrandMark />
      <span
        style={{
          fontFamily: "'Overpass', sans-serif",
          fontWeight: 700,
          fontSize: 18,
          color: "var(--color-text-primary)",
          letterSpacing: "-0.01em",
        }}
      >
        Car Intel
      </span>
    </button>
  );

  const errorBanner = apiError && (
    <div role="alert" style={{ background: "var(--color-danger-surface)", border: "1px solid var(--color-danger)", color: "var(--color-danger-strong)", padding: "10px 24px", fontSize: 14, textAlign: "center", position: "relative", zIndex: 20 }}>
      Listings can't load right now. Check your connection, then refresh the page in a minute.
    </div>
  );

  const footer = (
    <footer className="page-pad" style={{ position: "relative", zIndex: 1, borderTop: "1px solid var(--color-border)", padding: "16px 32px", display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", fontSize: 12.5, color: "var(--color-text-subtle)" }}>
      <div>Car Intel compares asking prices with a market-value model trained on recent listings.</div>
      <div>{stats.last_updated ? `Data updated ${fmtUpdated(stats.last_updated)}` : ""}</div>
    </footer>
  );

  // ── HOME PAGE ────────────────────────────────────────────────────────────────
  if (view === "home") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif", position: "relative", display: "flex", flexDirection: "column" }}>
        <style>{sharedStyles}</style>
        {gridBg}
        {errorBanner}

        <header className="page-pad" style={{ position: "relative", zIndex: 10, borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-translucent)", backdropFilter: "blur(12px)", padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 58 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            {brandButton()}
            <button
              className="nav-link"
              onClick={() => setView("estimator")}
              style={{ background: "none", border: "none", padding: 0, fontFamily: "'Public Sans', sans-serif", fontSize: 13, fontWeight: 600, color: "var(--color-text-secondary)", cursor: "pointer" }}
            >
              Price check
            </button>
          </div>
          <div className="header-stats" style={{ display: "flex", gap: 22, alignItems: "center" }}>
            {statCluster}
            <ThemeToggle />
          </div>
        </header>

        <main className="page-pad" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "56px 32px 40px", position: "relative", zIndex: 1 }}>
          <div
            className="panel-in hero-grid"
            style={{
              width: "100%",
              maxWidth: 1040,
              display: "grid",
              gridTemplateColumns: "1.35fr 0.9fr",
              gap: 48,
              alignItems: "center",
              animation: "panelIn 0.4s ease",
            }}
          >
            <div>
              <h1 style={{ fontFamily: "'Overpass', sans-serif", fontWeight: 800, fontSize: "clamp(34px, 6vw, 46px)", lineHeight: 1.08, letterSpacing: "-0.01em", color: "var(--color-text-primary)" }}>
                Know what a used car is really worth.
              </h1>
              <p style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 16, color: "var(--color-text-secondary)", marginTop: 16, maxWidth: 460, lineHeight: 1.55 }}>
                Car Intel compares {isLoading ? "every" : fmtN(stats.graded_listings)} used-car listings with what similar cars sell for, so you can tell a fair price from an inflated one before you call the dealer.
              </p>
              <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
                <button
                  className="home-search-btn"
                  onClick={() => setView("results")}
                  style={{ background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", borderRadius: 6, padding: "12px 24px", fontFamily: "'Public Sans', sans-serif", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                >
                  Browse listings
                </button>
                <button
                  onClick={() => setView("estimator")}
                  style={{ background: "none", color: "var(--color-text-primary)", border: "1px solid var(--color-border-strong)", borderRadius: 6, padding: "12px 22px", fontFamily: "'Public Sans', sans-serif", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                >
                  Estimate a price
                </button>
              </div>
            </div>

            <section aria-labelledby="best-today" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, boxShadow: "var(--shadow-panel)", padding: "18px 0 8px" }}>
              <h2 id="best-today" style={{ fontFamily: "'Overpass', sans-serif", fontSize: 16, fontWeight: 700, padding: "0 20px 10px" }}>Best deals right now</h2>
              {!topTickerDeals.length && !preview.length ? (
                [0, 1, 2].map((i) => (
                  <div key={i} aria-hidden="true" style={{ margin: "10px 20px", height: 44, borderRadius: 4, background: "var(--color-surface-subtle)", animation: "pulse 1.4s infinite" }} />
                ))
              ) : (
                (topTickerDeals.length ? topTickerDeals : preview).slice(0, 3).map((d) => {
                  const vm = vsMarket(d.savings);
                  return (
                    <button
                      key={d.listing_id}
                      className="best-pick"
                      onClick={() => { setSelectedDeal(d); setView("results"); }}
                      style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", borderTop: "1px solid var(--color-border)", padding: "12px 20px", cursor: "pointer", color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif" }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{d.year} {d.make} {d.model}</span>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 700 }}>{fmt$(d.price)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 3, fontSize: 13 }}>
                        <span style={{ color: "var(--color-text-secondary)" }}>{fmtN(d.mileage)} mi, {d.location_state}</span>
                        <span style={{ color: vm.color, fontWeight: 600 }}>{vm.text}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </section>
          </div>

          <div style={{ width: "100%", maxWidth: 1040, marginTop: 40, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, boxShadow: "var(--shadow-panel)", padding: "22px 26px" }}>
            <div className="filters" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <FilterSelect label="Make" value={makeFilter} onChange={(v) => { setMakeFilter(v); setModelFilter(""); }} minWidth={140}>
                <option value="">Any make</option>
                {makeOptions.map((m) => (
                  <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Model" value={modelFilter} onChange={setModelFilter} disabled={!makeFilter} minWidth={140}>
                <option value="">Any model</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Body type" value={bodyFilter} onChange={(v) => { setBodyFilter(v); if (!SIZE_SUPPORTED.has(v.toLowerCase())) setSizeFilter(""); }} minWidth={130}>
                <option value="">Any body</option>
                {bodyOptions.map((bt) => (
                  <option key={bt} value={bt}>{bt}</option>
                ))}
              </FilterSelect>

              {SIZE_SUPPORTED.has(bodyFilter.toLowerCase()) && (
                <FilterSelect label="Size" value={sizeFilter} onChange={setSizeFilter} minWidth={110}>
                  <option value="">Any size</option>
                  <option value="Small">Small</option>
                  <option value="Medium">Medium</option>
                  <option value="Large">Large</option>
                </FilterSelect>
              )}

              <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                <FilterSelect label="Year from" value={minYear} onChange={setMinYear} minWidth={90}>
                  <option value="">Any</option>
                  {yearOptions.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </FilterSelect>
                <span style={{ color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="Year to" value={maxYear} onChange={setMaxYear} minWidth={90}>
                  <option value="">Any</option>
                  {[...yearOptions].reverse().map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </FilterSelect>
              </div>

              <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                <FilterSelect label="Mileage from" value={minMileage} onChange={setMinMileage} minWidth={105}>
                  <option value="">Any</option>
                  {[10000, 25000, 50000, 75000, 100000, 125000, 150000].map((m) => (
                    <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                  ))}
                </FilterSelect>
                <span style={{ color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="Mileage to" value={maxMileage} onChange={setMaxMileage} minWidth={105}>
                  <option value="">Any</option>
                  {[25000, 50000, 75000, 100000, 125000, 150000, 200000].map((m) => (
                    <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                  ))}
                </FilterSelect>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px 20px", marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--color-surface-subtle)" }}>
              <button
                className="home-search-btn"
                onClick={() => setView("results")}
                style={{ background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", borderRadius: 6, padding: "9px 18px", fontFamily: "'Public Sans', sans-serif", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                {loading.deals ? "Show listings" : `Show ${fmtN(filteredDeals.length)} listings`}
              </button>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                {[
                  { label: "Trucks", action: () => { setBodyFilter("Truck"); setView("results"); } },
                  { label: "SUVs", action: () => { setBodyFilter("SUV"); setView("results"); } },
                  { label: "Sedans", action: () => { setBodyFilter("Sedan"); setView("results"); } },
                  { label: "Best deals", action: () => { setMinStars(4); setView("results"); } },
                  { label: "Low mileage", action: () => { setMaxMileage("50000"); setView("results"); } },
                ].map(({ label, action }) => (
                  <button
                    key={label}
                    className="chip-btn"
                    onClick={action}
                    style={{ background: "none", border: "none", color: "var(--color-text-secondary)", padding: "2px 0", fontFamily: "'Public Sans', sans-serif", fontSize: 13.5, fontWeight: 500, cursor: "pointer" }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </main>

        {footer}
      </div>
    );
  }

  // ── PRICE ESTIMATOR PAGE ─────────────────────────────────────────────────────
  if (view === "estimator") {
    const inputStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", boxShadow: "var(--shadow-inset)", borderRadius: 5, padding: "10px 11px", fontFamily: "'Public Sans', sans-serif", fontSize: 13.5, color: "var(--color-text-primary)", width: "100%", outline: "none", boxSizing: "border-box" };
    const labelStyle = { fontFamily: "'Public Sans', sans-serif", fontSize: 13, color: "var(--color-text-muted)", display: "block", marginBottom: 4 };
    const maxYear = new Date().getFullYear() + 1;

    return (
      <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif", position: "relative" }}>
        <style>{sharedStyles}</style>
        {gridBg}
        {errorBanner}

        <header className="page-pad" style={{ position: "relative", zIndex: 10, borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-translucent)", backdropFilter: "blur(12px)", padding: "0 32px", display: "flex", alignItems: "center", height: 58, gap: 18 }}>
          {brandButton(() => setView("home"))}
          <div style={{ width: 1, height: 20, background: "var(--color-border)" }} />
          <div style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 13, fontWeight: 600, color: "var(--color-text-secondary)" }}>Price check</div>
          <div style={{ flex: 1 }} />
          <ThemeToggle />
        </header>

        <main className="page-pad" style={{ display: "flex", justifyContent: "center", padding: "56px 32px", position: "relative", zIndex: 1 }}>
          <div className="panel-in" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, boxShadow: "var(--shadow-panel)", padding: "clamp(22px, 5vw, 36px) clamp(18px, 5vw, 40px)", width: "100%", maxWidth: 540, animation: "panelIn 0.35s ease" }}>
            <h1 style={{ fontFamily: "'Overpass', sans-serif", fontWeight: 700, fontSize: 22, marginBottom: 4 }}>Estimate a fair price</h1>
            <p style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: 24, lineHeight: 1.5 }}>Tell us the car and its mileage to see what similar cars are listed for.</p>

            <div className="est-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="est-make" style={labelStyle}>Make</label>
                <select id="est-make" style={inputStyle} value={estMake} onChange={(e) => { setEstMake(e.target.value); setEstModel(""); setEstTrim(""); setEstResult(null); }}>
                  <option value="">Select make</option>
                  {makeOptions.map((m) => (
                    <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="est-model" style={{ ...labelStyle, opacity: !estMake ? 0.45 : 1 }}>Model</label>
                <select id="est-model" style={{ ...inputStyle, opacity: !estMake ? 0.45 : 1 }} value={estModel} onChange={(e) => { setEstModel(e.target.value); setEstTrim(""); setEstResult(null); }} disabled={!estMake}>
                  <option value="">Select model</option>
                  {estModelOptions.map((m) => (
                    <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                  ))}
                </select>
              </div>
              {estTrimOptions.length > 0 && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <label htmlFor="est-trim" style={{ ...labelStyle, opacity: !estModel ? 0.45 : 1 }}>Trim (optional)</label>
                  <select id="est-trim" style={{ ...inputStyle, opacity: !estModel ? 0.45 : 1 }} value={estTrim} onChange={(e) => { setEstTrim(e.target.value); setEstResult(null); }} disabled={!estModel}>
                    <option value="">Any trim</option>
                    {estTrimOptions.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label htmlFor="est-year" style={labelStyle}>Year</label>
                <input id="est-year" style={inputStyle} type="number" inputMode="numeric" placeholder="e.g. 2019" min="1980" max={maxYear} value={estYear} onChange={(e) => setEstYear(e.target.value)} />
              </div>
              <div>
                <label htmlFor="est-mileage" style={labelStyle}>Mileage</label>
                <input id="est-mileage" style={inputStyle} type="number" inputMode="numeric" placeholder="e.g. 45000" min="0" value={estMileage} onChange={(e) => setEstMileage(e.target.value)} />
              </div>
            </div>

            {estError && (
              <div role="alert" style={{ marginTop: 16, fontSize: 14, color: "var(--color-danger-strong)", background: "var(--color-danger-surface)", border: "1px solid var(--color-danger)", borderRadius: 5, padding: "10px 14px" }}>
                {estError}
              </div>
            )}

            <button
              onClick={runEstimate}
              disabled={estLoading}
              style={{ marginTop: 22, width: "100%", background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", borderRadius: 6, padding: "13px", fontFamily: "'Public Sans', sans-serif", fontSize: 14, fontWeight: 600, cursor: estLoading ? "wait" : "pointer", opacity: estLoading ? 0.7 : 1 }}
            >
              {estLoading ? "Estimating…" : "Get estimate"}
            </button>

            {estResult && (
              <div className="panel-in" style={{ marginTop: 26, borderTop: "1px solid var(--color-border)", paddingTop: 22, animation: "panelIn 0.3s ease" }}>
                <div style={{ border: "1px solid var(--color-border-strong)", borderRadius: 8, padding: "18px 20px", background: "var(--color-surface-subtle)" }}>
                  <div className="sticker-label">Estimated market value</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: 40, color: "var(--color-accent)", marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
                    {fmt$(estResult.predicted_price)}
                  </div>
                  {estResult.range_low != null && (
                    <div style={{ fontSize: 15, color: "var(--color-text-primary)", marginTop: 6 }}>
                      About half of similar cars are listed between <strong>{fmt$(estResult.range_low)}</strong> and <strong>{fmt$(estResult.range_high)}</strong>.
                    </div>
                  )}
                  <div style={{ fontSize: 14, color: "var(--color-text-secondary)", marginTop: 8 }}>
                    {estYear} {estMake.charAt(0).toUpperCase() + estMake.slice(1)} {estModel.charAt(0).toUpperCase() + estModel.slice(1)}{estTrim ? ` ${estTrim}` : ""}, {parseInt(estMileage).toLocaleString()} mi
                  </div>
                  <p style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 10, lineHeight: 1.5 }}>
                    {estResult.comparables != null && estResult.comparables < 3
                      ? "We've seen very few of this car recently, so treat this as a rough guide. "
                      : ""}
                    Condition, options and service history can move a real price either way.
                  </p>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ── RESULTS PAGE ─────────────────────────────────────────────────────────────
  const anyFilter = makeFilter || modelFilter || sizeFilter || bodyFilter || minYear || maxYear || minMileage || maxMileage || minStars > 1;
  // While the full list loads, the default view (best deals first, no
  // filters) can already show the top-100 preview, which is the same rows.
  const rows = !loading.deals ? displayedDeals : !anyFilter && sortKey === "score" && sortDir === "desc" ? preview : [];

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif", position: "relative" }}>
      <style>{sharedStyles}</style>
      {gridBg}
      {errorBanner}

      <header
        className="page-pad"
        style={{
          position: "relative",
          zIndex: 10,
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-bg-translucent)",
          backdropFilter: "blur(12px)",
          padding: "0 32px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 58,
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexShrink: 0 }}>
          {brandButton(() => { setView("home"); resetFilters(); })}
          <div style={{ width: 1, height: 20, background: "var(--color-border)" }} />
          <button className="nav-link" onClick={() => setView("estimator")} style={{ background: "none", border: "none", fontFamily: "'Public Sans', sans-serif", fontSize: 13.5, fontWeight: 600, color: "var(--color-text-secondary)", cursor: "pointer", padding: 0 }}>
            Price check
          </button>
        </div>

        {currentTicker.make && (
          <div className="best-deal-chip" style={{ display: "flex", alignItems: "center", gap: 9, background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)", borderRadius: 5, boxShadow: "var(--shadow-inset)", padding: "6px 14px", minWidth: 0, overflow: "hidden" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-success)", flexShrink: 0 }} />
            <span style={{ fontSize: 12.5, color: "var(--color-text-muted)", flexShrink: 0 }}>Best deal:</span>
            <span style={{ fontSize: 12.5, color: "var(--color-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{currentTicker.year} {currentTicker.make} {currentTicker.model}</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, color: "var(--color-accent)", fontWeight: 700, flexShrink: 0 }}>{fmt$(currentTicker.price)}</span>
          </div>
        )}

        <div style={{ display: "flex", gap: 22, alignItems: "center", flexShrink: 0 }}>
          <div className="header-stats" style={{ display: "flex", gap: 22, alignItems: "center" }}>{statCluster}</div>
          <ThemeToggle />
        </div>
      </header>

      <main className="page-pad" style={{ position: "relative", zIndex: 1, padding: "26px 32px", maxWidth: 1400, margin: "0 auto" }}>
        <div className="panel-in" style={{ animation: "panelIn 0.3s ease" }}>
          <h1 style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Used car listings graded by price</h1>
          <div style={{ marginBottom: 16, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, boxShadow: "var(--shadow-panel)", padding: "16px 18px" }}>
            <div className="filters" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <FilterSelect label="Make" value={makeFilter} onChange={(v) => { setMakeFilter(v); setModelFilter(""); }} minWidth={128}>
                <option value="">Any make</option>
                {makeOptions.map((m) => (
                  <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Model" value={modelFilter} onChange={setModelFilter} disabled={!makeFilter} minWidth={128}>
                <option value="">Any model</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Body type" value={bodyFilter} onChange={(v) => { setBodyFilter(v); if (!SIZE_SUPPORTED.has(v.toLowerCase())) setSizeFilter(""); }} minWidth={118}>
                <option value="">Any body</option>
                {bodyOptions.map((bt) => (
                  <option key={bt} value={bt}>{bt}</option>
                ))}
              </FilterSelect>

              {SIZE_SUPPORTED.has(bodyFilter.toLowerCase()) && (
                <FilterSelect label="Size" value={sizeFilter} onChange={setSizeFilter} minWidth={105}>
                  <option value="">Any size</option>
                  <option value="Small">Small</option>
                  <option value="Medium">Medium</option>
                  <option value="Large">Large</option>
                </FilterSelect>
              )}

              <FilterSelect label="Year from" value={minYear} onChange={setMinYear} minWidth={90}>
                <option value="">Any</option>
                {yearOptions.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </FilterSelect>
              <FilterSelect label="Year to" value={maxYear} onChange={setMaxYear} minWidth={90}>
                <option value="">Any</option>
                {[...yearOptions].reverse().map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </FilterSelect>

              <FilterSelect label="Mileage from" value={minMileage} onChange={setMinMileage} minWidth={110}>
                <option value="">Any</option>
                {[10000, 25000, 50000, 75000, 100000, 125000, 150000].map((m) => (
                  <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                ))}
              </FilterSelect>
              <FilterSelect label="Mileage to" value={maxMileage} onChange={setMaxMileage} minWidth={110}>
                <option value="">Any</option>
                {[25000, 50000, 75000, 100000, 125000, 150000, 200000].map((m) => (
                  <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                ))}
              </FilterSelect>

              {anyFilter && (
                <button
                  onClick={resetFilters}
                  style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", borderRadius: 5, padding: "8px 12px", cursor: "pointer", fontFamily: "'Public Sans', sans-serif", fontSize: 13, alignSelf: "flex-end" }}
                >
                  Clear filters
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: "10px 16px", alignItems: "center", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--color-surface-subtle)", flexWrap: "wrap" }}>
              <GradeFilter value={minStars} onChange={setMinStars} />

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-text-muted)" }}>
                Sort by
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value)}
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 5, color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif", fontSize: 13, outline: "none", cursor: "pointer", padding: "6px 8px" }}
                >
                  <option value="score">Best deal</option>
                  <option value="savings">Most below market</option>
                  <option value="price">Price</option>
                  <option value="mileage">Mileage</option>
                  <option value="year">Year</option>
                </select>
              </label>
              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)", borderRadius: 5, padding: "6px 10px", cursor: "pointer", fontSize: 13 }}
              >
                {sortDir === "asc" ? "Lowest first" : "Highest first"}
              </button>

              <div style={{ flex: 1 }} />
              <div role="status" style={{ fontSize: 13.5, color: "var(--color-text-secondary)" }}>{loading.deals ? "Loading listings…" : `${fmtN(filteredDeals.length)} listings`}</div>
            </div>
          </div>

          <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: "0 2px 12px", lineHeight: 1.5, maxWidth: 760 }}>
            Each asking price is compared with our estimate of market value for that car. Fair price means within the estimate's usual margin of error; a great deal is at least three times that far below it.
          </p>

          <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, boxShadow: "var(--shadow-panel)", overflowX: "auto" }}>
            <div className="deal-grid deal-head" style={{ padding: "10px 20px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-subtle)" }}>
              {["Vehicle", "Price", "Market value", "Compared with market", "Mileage", "State", "Grade"].map((h) => (
                <div key={h} style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-text-secondary)" }}>{h}</div>
              ))}
            </div>

            {loading.deals && !rows.length ? (
              <div aria-hidden="true">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} style={{ margin: "14px 20px", height: 30, borderRadius: 4, background: "var(--color-surface-subtle)", animation: "pulse 1.4s infinite" }} />
                ))}
              </div>
            ) : filteredDeals.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 14 }}>
                <p>No listings match these filters.</p>
                {anyFilter && (
                  <button onClick={resetFilters} style={{ marginTop: 12, background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", borderRadius: 5, padding: "8px 16px", fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              rows.map((deal) => {
                const open = selectedDeal?.listing_id === deal.listing_id;
                const vm = vsMarket(deal.savings);
                const detailId = `deal-${deal.listing_id}`;
                return (
                  <div key={deal.listing_id}>
                    <div
                      className="deal-row deal-grid"
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      onClick={() => handleSelectDeal(deal)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectDeal(deal); }
                      }}
                      style={{
                        padding: "13px 20px",
                        borderBottom: open ? "none" : "1px solid var(--color-surface-subtle)",
                        background: open ? "var(--color-surface-subtle)" : "transparent",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>
                          {deal.year} {deal.make} {deal.model}
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginTop: 2 }}>
                          {[normalizeBodyType(deal.body_type), deal.trim].filter(Boolean).join(", ")}
                        </div>
                      </div>

                      <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 14, fontWeight: 700, color: "var(--color-text-primary)" }}>{fmt$(deal.price)}</div>
                      <div className="col-optional" style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: "var(--color-text-muted)" }}>{fmt$(deal.predicted_price)}</div>
                      <div style={{ fontSize: 13, color: vm.color, fontWeight: 600 }}>{vm.text}</div>
                      <div className="col-optional" style={{ fontSize: 13, color: "var(--color-text-muted)" }}>{fmtN(deal.mileage)} mi</div>
                      <div className="col-optional" style={{ fontSize: 13, color: "var(--color-text-muted)" }}>{deal.location_state}</div>
                      <DealBadge score={deal.deal_score} />
                    </div>

                    {open && (
                      <div id={detailId} className="panel-in" style={{ background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)", borderTop: "2px solid var(--color-accent)", padding: "20px 24px", animation: "panelIn 0.15s ease" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                          <div>
                            <h2 style={{ fontFamily: "'Overpass', sans-serif", fontWeight: 700, fontSize: 19, color: "var(--color-text-primary)" }}>
                              {deal.year} {deal.make} {deal.model} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>{deal.trim}</span>
                            </h2>
                            <div style={{ display: "flex", gap: 26, marginTop: 14, flexWrap: "wrap" }}>
                              {[
                                { label: "Asking price", value: fmt$(deal.price), color: "var(--color-text-primary)" },
                                { label: "Market value", value: fmt$(deal.predicted_price), color: "var(--color-text-secondary)" },
                                { label: "Compared with market", value: vm.text, color: vm.color },
                                { label: "Mileage", value: `${fmtN(deal.mileage)} mi`, color: "var(--color-text-secondary)" },
                                { label: "Location", value: [deal.location_city, deal.location_state].filter(Boolean).join(", "), color: "var(--color-text-secondary)" },
                              ].map(({ label, value, color }) => (
                                <div key={label}>
                                  <div className="sticker-label" style={{ marginBottom: 4 }}>{label}</div>
                                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 15, fontWeight: 700, color }}>{value}</div>
                                </div>
                              ))}
                              <div>
                                <div className="sticker-label" style={{ marginBottom: 4 }}>Grade</div>
                                <DealBadge score={deal.deal_score} width={52} height={8} />
                              </div>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            {deal.url && (
                              <a
                                href={deal.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ background: "var(--color-accent)", color: "var(--color-on-accent)", borderRadius: 5, padding: "8px 15px", fontSize: 13.5, fontWeight: 600, textDecoration: "none" }}
                              >
                                View on dealer site<span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}> (opens in a new tab)</span>
                              </a>
                            )}
                            <button
                              onClick={() => setSelectedDeal(null)}
                              style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", borderRadius: 5, padding: "8px 13px", cursor: "pointer", fontSize: 13.5 }}
                            >
                              Close
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {!loading.deals && visibleCount < filteredDeals.length && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
              <button
                onClick={() => setVisibleCount((v) => v + 100)}
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border-strong)", color: "var(--color-text-primary)", borderRadius: 6, padding: "10px 22px", fontFamily: "'Public Sans', sans-serif", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                Show 100 more <span style={{ color: "var(--color-text-subtle)", fontWeight: 400 }}>({fmtN(filteredDeals.length - visibleCount)} left)</span>
              </button>
            </div>
          )}
        </div>
      </main>

      <div style={{ marginTop: 40 }}>{footer}</div>
    </div>
  );
}
