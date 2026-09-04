import { useState, useEffect, useMemo } from "react";
import { fmt$, fmtN, normalizeBodyType } from "./utils/format";
import { dealTier, dealTierLabel } from "./utils/scoreColor.js";
import Spinner from "./components/common/Spinner";
import ArcGauge from "./components/common/Gauge";
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

// Small semicircular-gauge glyph used as the brand mark — a static echo of
// the ArcGauge component, not a data visualization.
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
    <div style={{ display: "flex", flexDirection: "column", gap: 4, opacity: disabled ? 0.45 : 1 }}>
      <span style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 11.5, color: "var(--color-text-muted)" }}>{label}</span>
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
    </div>
  );
}

// Five-block grade scale used for the "minimum grade" filter — the same
// visual language as DealBadge, driven by a slider position rather than a
// listing's score.
function GradeScale({ value, onChange }) {
  const colors = ["var(--color-deal-bad)", "var(--color-deal-poor)", "var(--color-deal-fair)", "var(--color-deal-good)", "var(--color-deal-excellent)"];
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
      {[1, 2, 3, 4, 5].map((tier) => (
        <button
          key={tier}
          onClick={() => onChange(tier)}
          title={`${tier} — ${["Overpriced", "Below fair", "Fair price", "Good deal", "Great deal"][tier - 1]} or better`}
          style={{
            width: 16,
            height: 16,
            borderRadius: 2,
            padding: 0,
            cursor: "pointer",
            background: tier <= value ? colors[tier - 1] : "transparent",
            border: `1px solid ${tier <= value ? colors[tier - 1] : "var(--color-border-strong)"}`,
          }}
        />
      ))}
    </div>
  );
}

export default function CarIntelDashboard() {
  const [view, setView] = useState("home"); // "home" | "results" | "estimator"

  const [makeFilter, setMakeFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [sizeFilter, setSizeFilter] = useState("");
  const [bodyFilter, setBodyFilter] = useState("");
  const [minYear, setMinYear] = useState("");
  const [maxYear, setMaxYear] = useState("");
  const [minMileage, setMinMileage] = useState("");
  const [maxMileage, setMaxMileage] = useState("");
  const [minStars, setMinStars] = useState(1);

  const [selectedDeal, setSelectedDeal] = useState(null);
  const [tickerIdx, setTickerIdx] = useState(0);

  const [deals, setDeals] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState({ deals: true, stats: true });
  const [apiError, setApiError] = useState(false);

  const [sortKey, setSortKey] = useState("score"); // score | price | savings | mileage
  const [sortDir, setSortDir] = useState("desc"); // asc | desc
  const [visibleCount, setVisibleCount] = useState(100); // rendered rows — see perf note below

  const [estMake, setEstMake] = useState("");
  const [estModel, setEstModel] = useState("");
  const [estYear, setEstYear] = useState("");
  const [estMileage, setEstMileage] = useState("");
  const [estTrim, setEstTrim] = useState("");
  const [estAccidents, setEstAccidents] = useState("0");
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
        if (key === "stats") setApiError(true);
      } finally {
        setLoading((l) => ({ ...l, [key]: false }));
      }
    };

    load("deals", `${API}/deals?limit=10000&min_score=0`, setDeals);
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

  // Real, computed metric for the hero gauge — the average grade across
  // every currently scored listing, not a placeholder number.
  const avgScore = useMemo(() => {
    const scored = (deals || []).filter((d) => d.deal_score != null);
    if (!scored.length) return null;
    return scored.reduce((sum, d) => sum + d.deal_score, 0) / scored.length;
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

  // Rendering all ~10,000 fetched listings as DOM rows at once is what made
  // the results page laggy — cap the rendered slice and let people load
  // more, instead of rendering everything up front.
  useEffect(() => {
    setVisibleCount(100);
  }, [minStars, makeFilter, modelFilter, sizeFilter, bodyFilter, minYear, maxYear, minMileage, maxMileage, sortKey, sortDir]);

  const displayedDeals = useMemo(() => filteredDeals.slice(0, visibleCount), [filteredDeals, visibleCount]);

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
    .sticker-label { font-family: 'Public Sans', sans-serif; font-size: 9.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); }

    @media (max-width: 860px) {
      .hero-grid { grid-template-columns: 1fr !important; gap: 28px !important; }
      .hero-grid > div:last-child { order: -1; max-width: 280px; margin: 0 auto; }
    }
    @media (max-width: 720px) {
      .header-stats { display: none !important; }
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
      <div style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 10, color: "var(--color-text-subtle)" }}>{label}</div>
    </div>
  );

  const statCluster = (
    <>
      {statReadout("Listings", isLoading ? "—" : fmtN(stats.active_listings))}
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

  // ── HOME PAGE ────────────────────────────────────────────────────────────────
  if (view === "home") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif", position: "relative", display: "flex", flexDirection: "column" }}>
        <style>{sharedStyles}</style>
        {gridBg}

        <header style={{ position: "relative", zIndex: 10, borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-translucent)", backdropFilter: "blur(12px)", padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 58 }}>
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

        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "56px 32px 40px", position: "relative", zIndex: 1 }}>
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
              <div style={{ fontFamily: "'Overpass', sans-serif", fontWeight: 800, fontSize: 46, lineHeight: 1.08, letterSpacing: "-0.01em", color: "var(--color-text-primary)" }}>
                Know what a used car is really worth.
              </div>
              <p style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 15, color: "var(--color-text-secondary)", marginTop: 16, maxWidth: 440, lineHeight: 1.55 }}>
                Car Intel grades {isLoading ? "every" : fmtN(stats.active_listings)} live listing against a market-value model, so you can tell a fair price from an inflated one before you call the dealer.
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

            <div style={{ display: "flex", justifyContent: "center", background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, boxShadow: "var(--shadow-panel)", padding: "22px 20px 18px" }}>
              {avgScore != null ? (
                <ArcGauge value={avgScore} size={190} label="Average grade, live inventory" sublabel={dealTierLabel(avgScore)} />
              ) : (
                <div style={{ height: 150, display: "flex", alignItems: "center", color: "var(--color-text-subtle)", fontSize: 13 }}>Loading gauge…</div>
              )}
            </div>
          </div>

          <div style={{ width: "100%", maxWidth: 1040, marginTop: 40, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, boxShadow: "var(--shadow-panel)", padding: "22px 26px" }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
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
                <FilterSelect label="Min mileage" value={minMileage} onChange={setMinMileage} minWidth={105}>
                  <option value="">Any</option>
                  {[10000, 25000, 50000, 75000, 100000, 125000, 150000].map((m) => (
                    <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                  ))}
                </FilterSelect>
                <span style={{ color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="Max mileage" value={maxMileage} onChange={setMaxMileage} minWidth={105}>
                  <option value="">Any</option>
                  {[25000, 50000, 75000, 100000, 125000, 150000, 200000].map((m) => (
                    <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                  ))}
                </FilterSelect>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px 20px", marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--color-surface-subtle)" }}>
              <div style={{ fontSize: 12.5, color: "var(--color-text-subtle)" }}>
                {filteredDeals.length > 0 ? `${fmtN(filteredDeals.length)} listings match` : ""}
              </div>
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
                    style={{ background: "none", border: "none", color: "var(--color-text-secondary)", padding: "2px 0", fontFamily: "'Public Sans', sans-serif", fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <footer style={{ position: "relative", zIndex: 1, borderTop: "1px solid var(--color-border)", padding: "14px 32px", display: "flex", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 11.5, color: "var(--color-text-subtle)" }}>Car Intel — priced with a market-value model</div>
          <div style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 11.5, color: "var(--color-text-subtle)" }}>
            {stats.last_updated ? `Updated ${new Date(stats.last_updated).toLocaleTimeString()}` : ""}
          </div>
        </footer>
      </div>
    );
  }

  // ── PRICE ESTIMATOR PAGE ─────────────────────────────────────────────────────
  if (view === "estimator") {
    const runEstimate = async () => {
      if (!estMake || !estModel || !estYear || !estMileage) {
        setEstError("Fill in make, model, year, and mileage to get an estimate.");
        return;
      }
      setEstLoading(true);
      setEstError(null);
      setEstResult(null);
      try {
        const params = new URLSearchParams({ make: estMake, model: estModel, year: estYear, mileage: estMileage, accident_count: estAccidents, ...(estTrim && { trim: estTrim }) });
        const res = await fetch(`${API}/predict?${params}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setEstResult(data);
      } catch (e) {
        setEstError(e.message);
      } finally {
        setEstLoading(false);
      }
    };

    const inputStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", boxShadow: "var(--shadow-inset)", borderRadius: 5, padding: "10px 11px", fontFamily: "'Public Sans', sans-serif", fontSize: 13.5, color: "var(--color-text-primary)", width: "100%", outline: "none", boxSizing: "border-box" };
    const labelStyle = { fontFamily: "'Public Sans', sans-serif", fontSize: 11.5, color: "var(--color-text-muted)", display: "block", marginBottom: 4 };

    return (
      <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif", position: "relative" }}>
        <style>{sharedStyles}</style>
        {gridBg}

        <header style={{ position: "relative", zIndex: 10, borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-translucent)", backdropFilter: "blur(12px)", padding: "0 32px", display: "flex", alignItems: "center", height: 58, gap: 18 }}>
          {brandButton(() => setView("home"))}
          <div style={{ width: 1, height: 20, background: "var(--color-border)" }} />
          <div style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 13, fontWeight: 600, color: "var(--color-text-secondary)" }}>Price check</div>
          <div style={{ flex: 1 }} />
          <ThemeToggle />
        </header>

        <div style={{ display: "flex", justifyContent: "center", padding: "56px 32px", position: "relative", zIndex: 1 }}>
          <div className="panel-in" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, boxShadow: "var(--shadow-panel)", padding: "36px 40px", width: "100%", maxWidth: 540, animation: "panelIn 0.35s ease" }}>
            <div style={{ fontFamily: "'Overpass', sans-serif", fontWeight: 700, fontSize: 20, marginBottom: 4 }}>Estimate a fair price</div>
            <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 24 }}>Enter the basics and the model will estimate current market value.</p>

            <div className="est-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelStyle}>Make</label>
                <select style={inputStyle} value={estMake} onChange={(e) => { setEstMake(e.target.value); setEstModel(""); setEstTrim(""); setEstResult(null); }}>
                  <option value="">Select make</option>
                  {makeOptions.map((m) => (
                    <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ ...labelStyle, opacity: !estMake ? 0.45 : 1 }}>Model</label>
                <select style={{ ...inputStyle, opacity: !estMake ? 0.45 : 1 }} value={estModel} onChange={(e) => { setEstModel(e.target.value); setEstTrim(""); setEstResult(null); }} disabled={!estMake}>
                  <option value="">Select model</option>
                  {estModelOptions.map((m) => (
                    <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                  ))}
                </select>
              </div>
              {estTrimOptions.length > 0 && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ ...labelStyle, opacity: !estModel ? 0.45 : 1 }}>Trim</label>
                  <select style={{ ...inputStyle, opacity: !estModel ? 0.45 : 1 }} value={estTrim} onChange={(e) => { setEstTrim(e.target.value); setEstResult(null); }} disabled={!estModel}>
                    <option value="">Any trim</option>
                    {estTrimOptions.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label style={labelStyle}>Year</label>
                <input style={inputStyle} type="number" placeholder="e.g. 2019" min="1990" max="2025" value={estYear} onChange={(e) => setEstYear(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Mileage</label>
                <input style={inputStyle} type="number" placeholder="e.g. 45000" min="0" value={estMileage} onChange={(e) => setEstMileage(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Accidents</label>
                <input style={inputStyle} type="number" placeholder="0" min="0" max="10" value={estAccidents} onChange={(e) => setEstAccidents(e.target.value)} />
              </div>
            </div>

            {estError && (
              <div style={{ marginTop: 16, fontSize: 13, color: "var(--color-danger-strong)", background: "var(--color-danger-surface)", border: "1px solid var(--color-danger)", borderRadius: 5, padding: "10px 14px" }}>
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
                  <div style={{ fontSize: 12.5, color: "var(--color-text-muted)", marginTop: 8 }}>
                    {estYear} {estMake.charAt(0).toUpperCase() + estMake.slice(1)} {estModel.charAt(0).toUpperCase() + estModel.slice(1)} · {parseInt(estMileage).toLocaleString()} mi
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── RESULTS PAGE ─────────────────────────────────────────────────────────────
  const ROW_COLUMNS = "1fr 90px 110px 110px 100px 80px 120px";

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif", position: "relative" }}>
      <style>{sharedStyles}</style>
      {gridBg}

      {apiError && (
        <div
          style={{
            background: "var(--color-danger-surface)",
            border: "1px solid var(--color-danger)",
            color: "var(--color-danger-strong)",
            padding: "10px 24px",
            fontSize: 13,
            textAlign: "center",
            position: "relative",
            zIndex: 20,
          }}
        >
          Couldn't connect to the API at {API}. Make sure api.py is running.
        </div>
      )}

      <header
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
          <button className="nav-link" onClick={() => setView("estimator")} style={{ background: "none", border: "none", fontFamily: "'Public Sans', sans-serif", fontSize: 13, fontWeight: 600, color: "var(--color-text-secondary)", cursor: "pointer", padding: 0 }}>
            Price check
          </button>
        </div>

        {currentTicker.make && (
          <div className="best-deal-chip" style={{ display: "flex", alignItems: "center", gap: 9, background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)", borderRadius: 5, boxShadow: "var(--shadow-inset)", padding: "6px 14px", minWidth: 0, overflow: "hidden" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-success)", animation: "pulse 2s infinite", flexShrink: 0 }} />
            <span style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 11.5, color: "var(--color-text-muted)", flexShrink: 0 }}>Best deal:</span>
            <span style={{ fontSize: 11.5, color: "var(--color-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{currentTicker.year} {currentTicker.make} {currentTicker.model}</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "var(--color-accent)", fontWeight: 700, flexShrink: 0 }}>{fmt$(currentTicker.price)}</span>
          </div>
        )}

        <div style={{ display: "flex", gap: 22, alignItems: "center", flexShrink: 0 }}>
          <div className="header-stats" style={{ display: "flex", gap: 22, alignItems: "center" }}>{statCluster}</div>
          <ThemeToggle />
        </div>
      </header>

      <main style={{ position: "relative", zIndex: 1, padding: "26px 32px", maxWidth: 1400, margin: "0 auto" }}>
        <div className="panel-in" style={{ animation: "panelIn 0.3s ease" }}>
          <div style={{ marginBottom: 16, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, boxShadow: "var(--shadow-panel)", padding: "16px 18px" }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
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

              <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                <FilterSelect label="Year from" value={minYear} onChange={setMinYear} minWidth={86}>
                  <option value="">Any</option>
                  {yearOptions.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </FilterSelect>
                <span style={{ color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="Year to" value={maxYear} onChange={setMaxYear} minWidth={86}>
                  <option value="">Any</option>
                  {[...yearOptions].reverse().map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </FilterSelect>
              </div>

              <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                <FilterSelect label="Min mileage" value={minMileage} onChange={setMinMileage} minWidth={105}>
                  <option value="">Any</option>
                  {[10000, 25000, 50000, 75000, 100000, 125000, 150000].map((m) => (
                    <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                  ))}
                </FilterSelect>
                <span style={{ color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="Max mileage" value={maxMileage} onChange={setMaxMileage} minWidth={105}>
                  <option value="">Any</option>
                  {[25000, 50000, 75000, 100000, 125000, 150000, 200000].map((m) => (
                    <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                  ))}
                </FilterSelect>
              </div>

              <div style={{ flex: 1 }} />

              {(makeFilter || modelFilter || sizeFilter || bodyFilter || minYear || maxYear || minMileage || maxMileage || minStars > 1) && (
                <button
                  onClick={resetFilters}
                  style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-muted)", borderRadius: 5, padding: "7px 12px", cursor: "pointer", fontFamily: "'Public Sans', sans-serif", fontSize: 12, alignSelf: "flex-end" }}
                >
                  Clear filters
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--color-surface-subtle)", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Minimum grade</span>
              <GradeScale value={minStars} onChange={setMinStars} />

              <div style={{ width: 1, height: 16, background: "var(--color-border)", margin: "0 6px" }} />

              <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Sort by</span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value)}
                style={{ background: "transparent", border: "1px solid var(--color-border)", borderRadius: 5, color: "var(--color-text-primary)", fontFamily: "'Public Sans', sans-serif", fontSize: 12, outline: "none", cursor: "pointer", padding: "5px 8px" }}
              >
                <option value="score">Grade</option>
                <option value="price">Price</option>
                <option value="savings">Savings</option>
                <option value="mileage">Mileage</option>
                <option value="year">Year</option>
              </select>
              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-primary)", borderRadius: 5, padding: "5px 9px", cursor: "pointer", fontSize: 12 }}
                aria-label={sortDir === "asc" ? "Sort descending" : "Sort ascending"}
              >
                {sortDir === "asc" ? "↑ Ascending" : "↓ Descending"}
              </button>

              <div style={{ flex: 1 }} />
              <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>{fmtN(filteredDeals.length)} results</div>
            </div>
          </div>

          <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, boxShadow: "var(--shadow-panel)", overflow: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: ROW_COLUMNS, minWidth: 820, padding: "10px 20px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-subtle)" }}>
              {["Vehicle", "Price", "Est. value", "Savings", "Mileage", "State", "Grade"].map((h) => (
                <div key={h} style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)" }}>{h}</div>
              ))}
            </div>

            {loading.deals ? (
              <Spinner />
            ) : filteredDeals.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)", fontSize: 13 }}>No listings match your filters</div>
            ) : (
              displayedDeals.map((deal, i) => (
                <div key={i}>
                  <div
                    className="deal-row"
                    onClick={() => handleSelectDeal(deal)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: ROW_COLUMNS,
                      minWidth: 820,
                      padding: "13px 20px",
                      borderBottom: selectedDeal?.listing_id === deal.listing_id ? "none" : "1px solid var(--color-surface-subtle)",
                      background: selectedDeal?.listing_id === deal.listing_id ? "var(--color-surface-subtle)" : "transparent",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {deal.url ? (
                          <a
                            href={deal.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)", textDecoration: "none" }}
                            onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                            onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                          >
                            {deal.year} {deal.make} {deal.model}
                          </a>
                        ) : (
                          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)" }}>
                            {deal.year} {deal.make} {deal.model}
                          </div>
                        )}

                        {deal.url && (
                          <a
                            href={deal.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open original listing"
                            style={{
                              fontSize: 11,
                              color: "var(--color-text-muted)",
                              textDecoration: "none",
                              border: "1px solid var(--color-border)",
                              padding: "1px 6px",
                              borderRadius: 4,
                            }}
                          >
                            ↗
                          </a>
                        )}
                      </div>

                      <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", marginTop: 2 }}>
                        {normalizeBodyType(deal.body_type)} · {deal.trim}
                      </div>
                    </div>

                    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)" }}>{fmt$(deal.price)}</div>
                    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: "var(--color-text-muted)" }}>{fmt$(deal.predicted_price)}</div>
                    <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: deal.savings >= 0 ? "var(--color-success)" : "var(--color-danger)", fontWeight: 600 }}>
                      {deal.savings >= 0 ? "↓ " : "↑ "}
                      {fmt$(Math.abs(deal.savings))}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>{fmtN(deal.mileage)} mi</div>
                    <div style={{ fontSize: 12, color: "var(--color-text-subtle)" }}>{deal.location_state}</div>
                    <DealBadge score={deal.deal_score} />
                  </div>

                  {selectedDeal?.listing_id === deal.listing_id && (
                    <div className="panel-in" style={{ background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)", borderTop: "2px solid var(--color-accent)", padding: "20px 24px", animation: "panelIn 0.15s ease" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontFamily: "'Overpass', sans-serif", fontWeight: 700, fontSize: 19, color: "var(--color-text-primary)" }}>
                            {selectedDeal.year} {selectedDeal.make} {selectedDeal.model} <span style={{ color: "var(--color-text-secondary)", fontWeight: 400 }}>{selectedDeal.trim}</span>
                          </div>
                          <div style={{ display: "flex", gap: 26, marginTop: 14, flexWrap: "wrap" }}>
                            {[
                              { label: "Listed price", value: fmt$(selectedDeal.price), color: "var(--color-text-primary)" },
                              { label: "Est. value", value: fmt$(selectedDeal.predicted_price), color: "var(--color-text-muted)" },
                              { label: "You save", value: fmt$(selectedDeal.savings), color: selectedDeal.savings >= 0 ? "var(--color-success)" : "var(--color-danger)" },
                              { label: "Mileage", value: `${fmtN(selectedDeal.mileage)} mi`, color: "var(--color-text-subtle)" },
                              { label: "Location", value: `${selectedDeal.location_city || ""} ${selectedDeal.location_state || ""}`.trim(), color: "var(--color-text-subtle)" },
                              { label: "Accidents", value: selectedDeal.accident_count ?? 0, color: selectedDeal.accident_count > 0 ? "var(--color-danger)" : "var(--color-success)" },
                            ].map(({ label, value, color }) => (
                              <div key={label}>
                                <div className="sticker-label" style={{ marginBottom: 4 }}>{label}</div>
                                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 14.5, fontWeight: 700, color }}>{value}</div>
                              </div>
                            ))}
                            <div>
                              <div className="sticker-label" style={{ marginBottom: 4 }}>Deal grade</div>
                              <DealBadge score={selectedDeal.deal_score} width={64} height={9} />
                            </div>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          {selectedDeal.url && !selectedDeal.url.includes("mock") && (
                            <a
                              href={selectedDeal.url}
                              target="_blank"
                              rel="noreferrer"
                              style={{ background: "var(--color-accent)", color: "var(--color-on-accent)", borderRadius: 5, padding: "7px 15px", fontSize: 12.5, fontWeight: 600, textDecoration: "none" }}
                            >
                              View listing
                            </a>
                          )}
                          <button
                            onClick={() => setSelectedDeal(null)}
                            style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", borderRadius: 5, padding: "7px 13px", cursor: "pointer", fontSize: 12.5 }}
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {!loading.deals && visibleCount < filteredDeals.length && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
              <button
                onClick={() => setVisibleCount((v) => v + 100)}
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border-strong)", color: "var(--color-text-primary)", borderRadius: 6, padding: "10px 22px", fontFamily: "'Public Sans', sans-serif", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                Show 100 more <span style={{ color: "var(--color-text-subtle)", fontWeight: 400 }}>({fmtN(filteredDeals.length - visibleCount)} remaining)</span>
              </button>
            </div>
          )}
        </div>
      </main>

      <footer style={{ position: "relative", zIndex: 1, borderTop: "1px solid var(--color-border)", padding: "16px 32px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 40 }}>
        <div style={{ fontSize: 11.5, color: "var(--color-text-subtle)" }}>Car Intel — priced with a market-value model</div>
        <div style={{ fontSize: 11.5, color: "var(--color-text-subtle)" }}>
          {stats.last_updated ? `Updated ${new Date(stats.last_updated).toLocaleTimeString()}` : ""}
        </div>
      </footer>
    </div>
  );
}
