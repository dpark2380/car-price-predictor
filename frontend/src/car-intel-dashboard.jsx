import { useState, useEffect, useMemo } from "react";
import { fmt$, fmtN, normalizeBodyType } from "./utils/format";
import { getDealColor, scoreToStars, starsDisplay } from "./utils/scoreColor.js";
import Spinner from "./components/common/Spinner";


const API = process.env.REACT_APP_API_URL || "http://localhost:5001/api";

// Body types that support Small/Medium/Large sub-filtering (matched lowercase)
const SIZE_SUPPORTED = new Set(["suv", "truck", "sedan", "hatchback"]);

// Approximate size bands by predicted price (proxy for vehicle size within a category)
const SIZE_PRICE_BANDS = {
  Small:  { max: 22000 },
  Medium: { min: 18000, max: 40000 },
  Large:  { min: 35000 },
};

// Persist the theme choice under the same key the pre-paint script in
// public/index.html reads, so a refresh restores it with no flash.
const THEME_KEY = "carintel-theme";

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" &&
      document.documentElement.classList.contains("theme-dark")
  );

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("theme-dark", next);
    // Keep the mobile browser chrome colour in sync with the surface.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", next ? "#0f172a" : "#f8fafc");
    try { localStorage.setItem(THEME_KEY, next ? "dark" : "light"); } catch (e) {}
  };

  return (
    <button
      onClick={toggle}
      title="Toggle light / dark theme"
      aria-label="Toggle light and dark theme"
      style={{
        background: "none",
        border: "1px solid var(--color-border)",
        borderRadius: 4,
        padding: "5px 10px",
        cursor: "pointer",
        color: "var(--color-text-secondary)",
        fontFamily: "monospace",
        fontSize: 13,
        lineHeight: 1,
      }}
    >
      {dark ? "☀" : "☾"}
    </button>
  );
}

function FilterSelect({ label, value, onChange, children, minWidth = 120, disabled = false }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, opacity: disabled ? 0.45 : 1 }}>
      <span style={{ fontFamily: "monospace", fontSize: 9, color: "var(--color-text-muted)", letterSpacing: "0.1em" }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          background: "var(--color-surface-subtle)",
          border: "1px solid var(--color-border)",
          borderRadius: 4,
          color: value ? "var(--color-text-primary)" : "var(--color-text-muted)",
          fontFamily: "monospace",
          fontSize: 12,
          outline: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          padding: "6px 8px",
          minWidth,
        }}
      >
        {children}
      </select>
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

  const [sortKey, setSortKey] = useState("score");   // score | price | savings | mileage
  const [sortDir, setSortDir] = useState("desc");    // asc | desc

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
    (deals || []).forEach((d) => { if (d.make) set.add(d.make.toLowerCase()); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals]);

  const modelOptions = useMemo(() => {
    if (!makeFilter) return [];
    const set = new Set();
    (deals || [])
      .filter((d) => d.make?.toLowerCase() === makeFilter)
      .forEach((d) => { if (d.model) set.add(d.model.toLowerCase()); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals, makeFilter]);

  const yearOptions = useMemo(() => {
    const set = new Set();
    (deals || []).forEach((d) => { if (d.year) set.add(d.year); });
    return Array.from(set).sort((a, b) => a - b);
  }, [deals]);

  const estModelOptions = useMemo(() => {
    if (!estMake) return [];
    const set = new Set();
    (deals || [])
      .filter((d) => d.make?.toLowerCase() === estMake)
      .forEach((d) => { if (d.model) set.add(d.model.toLowerCase()); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals, estMake]);

  const estTrimOptions = useMemo(() => {
    if (!estMake || !estModel) return [];
    const set = new Set();
    (deals || [])
      .filter((d) => d.make?.toLowerCase() === estMake && d.model?.toLowerCase() === estModel)
      .forEach((d) => { if (d.trim) set.add(d.trim.trim()); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals, estMake, estModel]);

  const bodyOptions = useMemo(() => {
    const set = new Set();
    (deals || []).forEach((d) => set.add(normalizeBodyType(d.body_type)));
    const opts = Array.from(set).sort((a, b) => a.localeCompare(b));
    const unknownIdx = opts.indexOf("Unknown");
    if (unknownIdx >= 0) { opts.splice(unknownIdx, 1); opts.push("Unknown"); }
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
      .filter((d) => scoreToStars(d.deal_score) >= minStars)
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
        // tiebreaker: higher score first
        return (num(b.deal_score) - num(a.deal_score));
      }
      return (av - bv) * dir;
    });

    return arr;
  }, [deals, minStars, makeFilter, modelFilter, sizeFilter, bodyFilter, minYear, maxYear, minMileage, maxMileage, sortKey, sortDir]);

  const currentTicker = topTickerDeals[tickerIdx] || {};
  const isLoading = Object.values(loading).some(Boolean);

  const handleSelectDeal = (deal) => {
    setSelectedDeal((cur) => (cur?.listing_id === deal.listing_id ? null : deal));
  };

  const resetFilters = () => {
    setMakeFilter(""); setModelFilter(""); setSizeFilter(""); setBodyFilter("");
    setMinYear(""); setMaxYear(""); setMinMileage(""); setMaxMileage(""); setMinStars(1);
  };

  // All colour tokens live in theme.css; styles below reference them via
  // var(--color-*) so light/dark (and any future theme) work with no JS.
  const sharedStyles = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Bebas+Neue&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    ::-webkit-scrollbar { width: 4px; background: var(--color-surface-subtle); }
    ::-webkit-scrollbar-thumb { background: var(--color-border-strong); border-radius: 2px; }
    .deal-row { transition: background 0.15s; cursor: pointer; }
    .deal-row:hover { background: var(--color-surface-subtle) !important; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    @keyframes fadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    @keyframes slideIn { from { transform:translateY(8px); opacity:0; } to { transform:translateY(0); opacity:1; } }
    .home-search-btn { transition: background 0.15s, transform 0.1s; }
    .home-search-btn:hover { background: var(--color-accent-solid-hover) !important; transform: translateY(-1px); }
    .home-search-btn:active { transform: translateY(0); }
    select option { color: var(--color-text-primary); background: var(--color-surface); }
  `;

  const gridBg = (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none",
      backgroundImage: "linear-gradient(var(--color-grid) 1px,transparent 1px),linear-gradient(90deg,var(--color-grid) 1px,transparent 1px)",
      backgroundSize: "40px 40px", zIndex: 0 }} />
  );

  const statCluster = (
    <>
      {[
        { label: "LISTINGS", value: isLoading ? "—" : fmtN(stats.active_listings) },
        { label: "MAKES",    value: isLoading ? "—" : stats.makes },
        { label: "AVG PRICE",value: isLoading ? "—" : fmt$(stats.avg_price) },
      ].map((s) => (
        <div key={s.label} style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "monospace", fontSize: 9, color: "var(--color-text-secondary)", letterSpacing: "0.1em" }}>{s.label}</div>
          <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: "var(--color-text-primary)", fontWeight: 700 }}>{s.value}</div>
        </div>
      ))}
    </>
  );

  // ── HOME PAGE ────────────────────────────────────────────────────────────────
  if (view === "home") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'DM Sans', sans-serif", position: "relative", display: "flex", flexDirection: "column" }}>
        <style>{sharedStyles}</style>
        {gridBg}

        {/* Nav bar */}
        <header style={{ position: "relative", zIndex: 10, borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-translucent)", backdropFilter: "blur(12px)", padding: "0 40px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: "0.1em", color: "var(--color-accent)" }}>CARINTEL</div>
            <button onClick={() => setView("estimator")} style={{ background: "none", border: "1px solid var(--color-border)", borderRadius: 4, padding: "5px 14px", fontFamily: "monospace", fontSize: 11, color: "var(--color-text-secondary)", cursor: "pointer", letterSpacing: "0.08em" }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--color-accent)"; e.currentTarget.style.color = "var(--color-accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--color-border)"; e.currentTarget.style.color = "var(--color-text-secondary)"; }}>
              PRICE CHECK
            </button>
          </div>
          <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
            {statCluster}
            <ThemeToggle />
          </div>
        </header>

        {/* Hero */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 32px", position: "relative", zIndex: 1, animation: "fadeUp 0.4s ease" }}>
          <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 72, letterSpacing: "0.08em", color: "var(--color-text-primary)", lineHeight: 1, textAlign: "center" }}>
            FIND YOUR NEXT <span style={{ color: "var(--color-accent)" }}>DEAL</span>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 13, color: "var(--color-text-muted)", marginTop: 12, letterSpacing: "0.05em", textAlign: "center" }}>
            ML-powered used car pricing · {isLoading ? "..." : fmtN(stats.active_listings)} active listings
          </div>

          {/* Search card */}
          <div style={{ marginTop: 48, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "32px 36px", boxShadow: "var(--shadow-card)", width: "100%", maxWidth: 920 }}>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--color-text-subtle)", letterSpacing: "0.12em", marginBottom: 20 }}>SEARCH FILTERS</div>

            {/* Filter row */}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <FilterSelect label="MAKE" value={makeFilter} onChange={(v) => { setMakeFilter(v); setModelFilter(""); }} minWidth={140}>
                <option value="">Any Make</option>
                {makeOptions.map((m) => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
              </FilterSelect>

              <FilterSelect label="MODEL" value={modelFilter} onChange={setModelFilter} disabled={!makeFilter} minWidth={140}>
                <option value="">Any Model</option>
                {modelOptions.map((m) => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
              </FilterSelect>

              <FilterSelect label="BODY TYPE" value={bodyFilter} onChange={(v) => { setBodyFilter(v); if (!SIZE_SUPPORTED.has(v.toLowerCase())) setSizeFilter(""); }} minWidth={130}>
                <option value="">Any Body</option>
                {bodyOptions.map((bt) => <option key={bt} value={bt}>{bt}</option>)}
              </FilterSelect>

              {SIZE_SUPPORTED.has(bodyFilter.toLowerCase()) && (
                <FilterSelect label="SIZE" value={sizeFilter} onChange={setSizeFilter} minWidth={110}>
                  <option value="">Any Size</option>
                  <option value="Small">Small</option>
                  <option value="Medium">Medium</option>
                  <option value="Large">Large</option>
                </FilterSelect>
              )}

              <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                <FilterSelect label="YEAR FROM" value={minYear} onChange={setMinYear} minWidth={95}>
                  <option value="">Any</option>
                  {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
                </FilterSelect>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="YEAR TO" value={maxYear} onChange={setMaxYear} minWidth={95}>
                  <option value="">Any</option>
                  {[...yearOptions].reverse().map((y) => <option key={y} value={y}>{y}</option>)}
                </FilterSelect>
              </div>

              <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                <FilterSelect label="MIN MILEAGE" value={minMileage} onChange={setMinMileage} minWidth={110}>
                  <option value="">Any</option>
                  {[10000, 25000, 50000, 75000, 100000, 125000, 150000].map((m) => <option key={m} value={m}>{(m/1000).toFixed(0)}k mi</option>)}
                </FilterSelect>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="MAX MILEAGE" value={maxMileage} onChange={setMaxMileage} minWidth={110}>
                  <option value="">Any</option>
                  {[25000, 50000, 75000, 100000, 125000, 150000, 200000].map((m) => <option key={m} value={m}>{(m/1000).toFixed(0)}k mi</option>)}
                </FilterSelect>
              </div>
            </div>

            {/* Search button */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 24 }}>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-subtle)" }}>
                {filteredDeals.length > 0 ? `${filteredDeals.length} listings match` : ""}
              </div>
              <button
                className="home-search-btn"
                onClick={() => setView("results")}
                style={{ background: "var(--color-accent-solid)", color: "var(--color-on-accent)", border: "none", borderRadius: 6, padding: "12px 32px", fontFamily: "monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer" }}
              >
                SEARCH DEALS →
              </button>
            </div>
          </div>

          {/* Quick links */}
          <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap", justifyContent: "center" }}>
            {[
              { label: "Trucks", action: () => { setBodyFilter("Truck"); setView("results"); } },
              { label: "SUVs",   action: () => { setBodyFilter("SUV");   setView("results"); } },
              { label: "Sedans", action: () => { setBodyFilter("Sedan"); setView("results"); } },
              { label: "Best Deals", action: () => { setMinStars(4); setView("results"); } },
              { label: "Low Mileage", action: () => { setMaxMileage("50000"); setView("results"); } },
            ].map(({ label, action }) => (
              <button key={label} onClick={action}
                style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", borderRadius: 20, padding: "6px 16px", fontFamily: "monospace", fontSize: 11, cursor: "pointer", transition: "border-color 0.15s, color 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--color-accent)"; e.currentTarget.style.color = "var(--color-accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--color-border)"; e.currentTarget.style.color = "var(--color-text-secondary)"; }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <footer style={{ position: "relative", zIndex: 1, borderTop: "1px solid var(--color-border)", padding: "14px 40px", display: "flex", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--color-text-subtle)" }}>CARINTEL — XGBOOST PRICE MODEL</div>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--color-text-subtle)" }}>
            {stats.last_updated ? `LAST UPDATED: ${new Date(stats.last_updated).toLocaleTimeString()}` : ""}
          </div>
        </footer>
      </div>
    );
  }

  // ── PRICE ESTIMATOR PAGE ─────────────────────────────────────────────────────
  if (view === "estimator") {
    const runEstimate = async () => {
      if (!estMake || !estModel || !estYear || !estMileage) {
        setEstError("Please fill in all required fields.");
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

    const inputStyle = { background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)", borderRadius: 4, padding: "10px 12px", fontFamily: "monospace", fontSize: 13, color: "var(--color-text-primary)", width: "100%", outline: "none", boxSizing: "border-box" };
    const labelStyle = { fontFamily: "monospace", fontSize: 9, color: "var(--color-text-muted)", letterSpacing: "0.1em", display: "block", marginBottom: 4 };

    return (
      <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'DM Sans', sans-serif", position: "relative" }}>
        <style>{sharedStyles}</style>
        {gridBg}

        {/* Header */}
        <header style={{ position: "relative", zIndex: 10, borderBottom: "1px solid var(--color-border)", background: "var(--color-bg-translucent)", backdropFilter: "blur(12px)", padding: "0 32px", display: "flex", alignItems: "center", height: 60, gap: 16 }}>
          <button onClick={() => setView("home")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: "0.1em", color: "var(--color-accent)", lineHeight: 1, padding: 0 }}>CARINTEL</button>
          <div style={{ width: 1, height: 24, background: "var(--color-border)" }} />
          <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-secondary)", letterSpacing: "0.1em" }}>PRICE CHECK</div>
          <div style={{ flex: 1 }} />
          <ThemeToggle />
        </header>

        {/* Form */}
        <div style={{ display: "flex", justifyContent: "center", padding: "60px 32px", position: "relative", zIndex: 1 }}>
          <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "40px 44px", boxShadow: "var(--shadow-card)", width: "100%", maxWidth: 560 }}>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--color-text-subtle)", letterSpacing: "0.12em", marginBottom: 28 }}>PRICE ESTIMATOR</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelStyle}>MAKE *</label>
                <select style={inputStyle} value={estMake} onChange={(e) => { setEstMake(e.target.value); setEstModel(""); setEstTrim(""); setEstResult(null); }}>
                  <option value="">Select Make</option>
                  {makeOptions.map((m) => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ ...labelStyle, opacity: !estMake ? 0.45 : 1 }}>MODEL *</label>
                <select style={{ ...inputStyle, opacity: !estMake ? 0.45 : 1 }} value={estModel} onChange={(e) => { setEstModel(e.target.value); setEstTrim(""); setEstResult(null); }} disabled={!estMake}>
                  <option value="">Select Model</option>
                  {estModelOptions.map((m) => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                </select>
              </div>
              {estTrimOptions.length > 0 && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={{ ...labelStyle, opacity: !estModel ? 0.45 : 1 }}>TRIM</label>
                  <select style={{ ...inputStyle, opacity: !estModel ? 0.45 : 1 }} value={estTrim} onChange={(e) => { setEstTrim(e.target.value); setEstResult(null); }} disabled={!estModel}>
                    <option value="">Any Trim</option>
                    {estTrimOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label style={labelStyle}>YEAR *</label>
                <input style={inputStyle} type="number" placeholder="e.g. 2019" min="1990" max="2025" value={estYear} onChange={(e) => setEstYear(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>MILEAGE *</label>
                <input style={inputStyle} type="number" placeholder="e.g. 45000" min="0" value={estMileage} onChange={(e) => setEstMileage(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>ACCIDENTS</label>
                <input style={inputStyle} type="number" placeholder="0" min="0" max="10" value={estAccidents} onChange={(e) => setEstAccidents(e.target.value)} />
              </div>
            </div>

            {estError && (
              <div style={{ marginTop: 16, fontFamily: "monospace", fontSize: 12, color: "var(--color-danger-strong)", background: "var(--color-danger-surface)", border: "1px solid var(--color-danger)", borderRadius: 4, padding: "10px 14px" }}>
                {estError}
              </div>
            )}

            <button onClick={runEstimate} disabled={estLoading}
              style={{ marginTop: 24, width: "100%", background: "var(--color-accent-solid)", color: "var(--color-on-accent)", border: "none", borderRadius: 6, padding: "13px", fontFamily: "monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", cursor: estLoading ? "wait" : "pointer", opacity: estLoading ? 0.7 : 1 }}>
              {estLoading ? "ESTIMATING..." : "GET ESTIMATE →"}
            </button>

            {estResult && (
              <div style={{ marginTop: 28, borderTop: "1px solid var(--color-border)", paddingTop: 28, textAlign: "center" }}>
                <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--color-text-subtle)", letterSpacing: "0.12em", marginBottom: 8 }}>ESTIMATED VALUE</div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 56, color: "var(--color-accent)", letterSpacing: "0.04em", lineHeight: 1 }}>
                  {fmt$(estResult.predicted_price)}
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-muted)", marginTop: 8 }}>
                  {estYear} {estMake} · {parseInt(estMileage).toLocaleString()} mi
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── RESULTS PAGE ─────────────────────────────────────────────────────────────
  const ROW_COLUMNS = "1fr 90px 110px 110px 100px 80px 110px";

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-bg)", color: "var(--color-text-primary)", fontFamily: "'DM Sans', sans-serif", position: "relative" }}>
      <style>{sharedStyles}</style>
      {gridBg}

      {apiError && (
        <div
          style={{
            background: "var(--color-danger-surface)",
            border: "1px solid var(--color-danger)",
            color: "var(--color-danger-strong)",
            padding: "10px 24px",
            fontFamily: "monospace",
            fontSize: 12,
            textAlign: "center",
            position: "relative",
            zIndex: 20,
          }}
        >
          ⚠ Failed to connect to API at {API}. Make sure api.py is running.
        </div>
      )}

      {/* Header */}
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
          height: 60,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button onClick={() => { setView("home"); resetFilters(); }} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: "0.1em", color: "var(--color-accent)", lineHeight: 1, padding: 0 }}>
            CARINTEL
          </button>
          <div style={{ width: 1, height: 24, background: "var(--color-border)" }} />
          <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-secondary)", letterSpacing: "0.1em" }}>DEAL FINDER</div>
          <div style={{ width: 1, height: 24, background: "var(--color-border)" }} />
          <button onClick={() => setView("estimator")} style={{ background: "none", border: "none", fontFamily: "monospace", fontSize: 11, color: "var(--color-text-secondary)", cursor: "pointer", letterSpacing: "0.1em", padding: 0 }}
            onMouseEnter={(e) => e.currentTarget.style.color = "var(--color-accent)"}
            onMouseLeave={(e) => e.currentTarget.style.color = "var(--color-text-secondary)"}>
            PRICE CHECK
          </button>
        </div>

        {currentTicker.make && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)", borderRadius: 4, padding: "6px 14px" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-success)", animation: "pulse 2s infinite" }} />
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-muted)" }}>BEST DEAL:</span>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-primary)" }}>{currentTicker.year} {currentTicker.make} {currentTicker.model}</span>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-accent)", fontWeight: 700 }}>{fmt$(currentTicker.price)}</span>
            {currentTicker.savings > 0 && (
              <span style={{ fontFamily: "monospace", fontSize: 10, color: "var(--color-success)" }}>↓{fmt$(currentTicker.savings)} below market</span>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          {statCluster}
          <ThemeToggle />
        </div>
      </header>

      <main style={{ position: "relative", zIndex: 1, padding: "28px 32px", maxWidth: 1400, margin: "0 auto" }}>
        <div style={{ animation: "fadeUp 0.3s ease" }}>
          {/* Filter bar */}
          <div style={{ marginBottom: 16, background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 6, padding: "14px 16px" }}>
            {/* Row 1: main filters */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              {/* Make */}
              <FilterSelect
                label="MAKE"
                value={makeFilter}
                onChange={(v) => { setMakeFilter(v); setModelFilter(""); }}
                minWidth={130}
              >
                <option value="">Any Make</option>
                {makeOptions.map((m) => (
                  <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                ))}
              </FilterSelect>

              {/* Model — only active when make is chosen */}
              <FilterSelect
                label="MODEL"
                value={modelFilter}
                onChange={setModelFilter}
                disabled={!makeFilter}
                minWidth={130}
              >
                <option value="">Any Model</option>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                ))}
              </FilterSelect>

              {/* Body type → Size cascade */}
              <FilterSelect label="BODY TYPE" value={bodyFilter} onChange={(v) => { setBodyFilter(v); if (!SIZE_SUPPORTED.has(v.toLowerCase())) setSizeFilter(""); }} minWidth={120}>
                <option value="">Any Body</option>
                {bodyOptions.map((bt) => (
                  <option key={bt} value={bt}>{bt}</option>
                ))}
              </FilterSelect>

              {SIZE_SUPPORTED.has(bodyFilter.toLowerCase()) && (
                <FilterSelect label="SIZE" value={sizeFilter} onChange={setSizeFilter} minWidth={110}>
                  <option value="">Any Size</option>
                  <option value="Small">Small</option>
                  <option value="Medium">Medium</option>
                  <option value="Large">Large</option>
                </FilterSelect>
              )}

              {/* Year range */}
              <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                <FilterSelect label="YEAR FROM" value={minYear} onChange={setMinYear} minWidth={90}>
                  <option value="">Any</option>
                  {yearOptions.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </FilterSelect>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="YEAR TO" value={maxYear} onChange={setMaxYear} minWidth={90}>
                  <option value="">Any</option>
                  {[...yearOptions].reverse().map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </FilterSelect>
              </div>

              {/* Mileage range */}
              <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
                <FilterSelect label="MIN MILEAGE" value={minMileage} onChange={setMinMileage} minWidth={110}>
                  <option value="">Any</option>
                  {[10000, 25000, 50000, 75000, 100000, 125000, 150000].map((m) => (
                    <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                  ))}
                </FilterSelect>
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-subtle)", paddingBottom: 9 }}>–</span>
                <FilterSelect label="MAX MILEAGE" value={maxMileage} onChange={setMaxMileage} minWidth={110}>
                  <option value="">Any</option>
                  {[25000, 50000, 75000, 100000, 125000, 150000, 200000].map((m) => (
                    <option key={m} value={m}>{(m / 1000).toFixed(0)}k mi</option>
                  ))}
                </FilterSelect>
              </div>

              {/* Spacer */}
              <div style={{ flex: 1 }} />

              {/* Clear filters */}
              {(makeFilter || modelFilter || sizeFilter || bodyFilter || minYear || maxYear || minMileage || maxMileage || minStars > 1) && (
                <button
                  onClick={resetFilters}
                  style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-muted)", borderRadius: 4, padding: "6px 12px", cursor: "pointer", fontFamily: "monospace", fontSize: 11, alignSelf: "flex-end" }}
                >
                  CLEAR ✕
                </button>
              )}
            </div>

            {/* Row 2: score + sort + count */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--color-surface-subtle)", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-muted)" }}>MIN SCORE</span>
              <input type="range" min={1} max={5} step={1} value={minStars} onChange={(e) => setMinStars(+e.target.value)} style={{ accentColor: "var(--color-accent)", width: 80 }} />
              <span style={{ fontSize: 13, color: "var(--color-accent)", minWidth: 60 }}>{"★".repeat(minStars) + "☆".repeat(5 - minStars)}</span>

              <div style={{ width: 1, height: 16, background: "var(--color-border)", margin: "0 4px" }} />

              <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-muted)" }}>SORT</span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value)}
                style={{ background: "transparent", border: "1px solid var(--color-border)", borderRadius: 4, color: "var(--color-text-primary)", fontFamily: "monospace", fontSize: 11, outline: "none", cursor: "pointer", padding: "4px 8px" }}
              >
                <option value="score">Score</option>
                <option value="price">Price</option>
                <option value="savings">Savings</option>
                <option value="mileage">Mileage</option>
                <option value="year">Year</option>
              </select>
              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-primary)", borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontFamily: "monospace", fontSize: 12 }}
              >
                {sortDir === "asc" ? "↑ ASC" : "↓ DESC"}
              </button>

              <div style={{ flex: 1 }} />
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-secondary)" }}>{filteredDeals.length} RESULTS</div>
            </div>
          </div>

          <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: ROW_COLUMNS, padding: "10px 20px", borderBottom: "1px solid var(--color-border)", background: "var(--color-surface-subtle)" }}>
              {["VEHICLE", "PRICE", "EST. VALUE", "SAVINGS", "MILEAGE", "STATE", "SCORE"].map((h) => (
                <div key={h} style={{ fontFamily: "monospace", fontSize: 9, color: "var(--color-text-secondary)", letterSpacing: "0.1em" }}>{h}</div>
              ))}
            </div>

            {loading.deals ? (
              <Spinner />
            ) : filteredDeals.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-secondary)", fontFamily: "monospace", fontSize: 12 }}>
                No deals match your filters
              </div>
            ) : (
              filteredDeals.map((deal, i) => (
                <div key={i}>
                <div
                  className="deal-row"
                  onClick={() => handleSelectDeal(deal)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: ROW_COLUMNS,
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
                            fontFamily: "monospace",
                            fontSize: 12,
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

                    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
                      {normalizeBodyType(deal.body_type)} · {deal.trim}
                    </div>
                  </div>

                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, fontWeight: 700, color: "var(--color-text-primary)" }}>{fmt$(deal.price)}</div>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: "var(--color-text-muted)" }}>{fmt$(deal.predicted_price)}</div>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: deal.savings >= 0 ? "var(--color-success)" : "var(--color-danger)", fontWeight: 600 }}>
                    {deal.savings >= 0 ? "↓ " : "↑ "}
                    {fmt$(Math.abs(deal.savings))}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--color-text-muted)" }}>{fmtN(deal.mileage)} mi</div>
                  <div style={{ fontFamily: "monospace", fontSize: 12, color: "var(--color-text-subtle)" }}>{deal.location_state}</div>
                  <div style={{ fontSize: 15, color: getDealColor(deal.deal_score), letterSpacing: "0.05em" }}>
                    {starsDisplay(deal.deal_score)}
                  </div>
                </div>

                {selectedDeal?.listing_id === deal.listing_id && (
                  <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-accent-subtle)", borderTop: "2px solid var(--color-accent)", borderBottom: "1px solid var(--color-surface-subtle)", padding: "20px 24px", animation: "slideIn 0.15s ease" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 22, color: "var(--color-accent)", letterSpacing: "0.05em" }}>
                          {selectedDeal.year} {selectedDeal.make} {selectedDeal.model} — {selectedDeal.trim}
                        </div>
                        <div style={{ display: "flex", gap: 28, marginTop: 12, flexWrap: "wrap" }}>
                          {[
                            { label: "Listed Price", value: fmt$(selectedDeal.price), color: "var(--color-text-primary)" },
                            { label: "Est. Value", value: fmt$(selectedDeal.predicted_price), color: "var(--color-text-muted)" },
                            { label: "You Save", value: fmt$(selectedDeal.savings), color: selectedDeal.savings >= 0 ? "var(--color-success)" : "var(--color-danger)" },
                            { label: "Mileage", value: `${fmtN(selectedDeal.mileage)} mi`, color: "var(--color-text-subtle)" },
                            { label: "Deal Score", value: starsDisplay(selectedDeal.deal_score), color: getDealColor(selectedDeal.deal_score) },
                            { label: "Location", value: `${selectedDeal.location_city || ""} ${selectedDeal.location_state || ""}`.trim(), color: "var(--color-text-subtle)" },
                            { label: "Accidents", value: selectedDeal.accident_count ?? 0, color: selectedDeal.accident_count > 0 ? "var(--color-danger)" : "var(--color-success)" },
                          ].map(({ label, value, color }) => (
                            <div key={label}>
                              <div style={{ fontFamily: "monospace", fontSize: 9, color: "var(--color-text-secondary)", letterSpacing: "0.1em", marginBottom: 4 }}>{label}</div>
                              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 15, fontWeight: 700, color }}>{value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {selectedDeal.url && !selectedDeal.url.includes("mock") && (
                          <a href={selectedDeal.url} target="_blank" rel="noreferrer"
                            style={{ background: "var(--color-accent-solid)", color: "var(--color-on-accent)", borderRadius: 4, padding: "6px 14px", fontFamily: "monospace", fontSize: 11, fontWeight: 700, textDecoration: "none", letterSpacing: "0.05em" }}>
                            VIEW LISTING →
                          </a>
                        )}
                        <button onClick={() => setSelectedDeal(null)}
                          style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", borderRadius: 4, padding: "6px 12px", cursor: "pointer", fontFamily: "monospace", fontSize: 11 }}>
                          CLOSE ✕
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                </div>
              ))
            )}
          </div>

        </div>
      </main>

      <footer style={{ position: "relative", zIndex: 1, borderTop: "1px solid var(--color-border)", padding: "16px 32px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 40 }}>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--color-text-subtle)" }}>CARINTEL — XGBOOST PRICE MODEL</div>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--color-text-subtle)" }}>
          {stats.last_updated ? `LAST UPDATED: ${new Date(stats.last_updated).toLocaleTimeString()}` : ""}
        </div>
      </footer>
    </div>
  );
}
