import { useState, useEffect, useMemo } from "react";
import { fmt$, fmtN, normalizeBodyType } from "./utils/format";
import { getDealColor, scoreToStars, starsDisplay } from "./utils/scoreColor.js";
import Spinner from "./components/common/Spinner";
// eslint-disable-next-line no-unused-vars
import DealBadge from "./components/deals/DealBadge";


const API = process.env.REACT_APP_API_URL || "http://localhost:5001/api";

// Body types that support Small/Medium/Large sub-filtering (matched lowercase)
const SIZE_SUPPORTED = new Set(["suv", "truck", "sedan", "hatchback"]);

// Approximate size bands by predicted price (proxy for vehicle size within a category)
const SIZE_PRICE_BANDS = {
  Small:  { max: 22000 },
  Medium: { min: 18000, max: 40000 },
  Large:  { min: 35000 },
};

function FilterSelect({ label, value, onChange, children, minWidth = 120, disabled = false }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, opacity: disabled ? 0.45 : 1 }}>
      <span style={{ fontFamily: "monospace", fontSize: 9, color: "#64748b", letterSpacing: "0.1em" }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          background: "#f1f5f9",
          border: "1px solid #e2e8f0",
          borderRadius: 4,
          color: value ? "#0f172a" : "#64748b",
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
  const [view, setView] = useState("home"); // "home" | "results"

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

  // eslint-disable-next-line no-unused-vars
  const [benchmark, setBenchmark] = useState(null);
  // eslint-disable-next-line no-unused-vars
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [salesStats, setSalesStats] = useState(null);
  // eslint-disable-next-line no-unused-vars
  const [salesLoading, setSalesLoading] = useState(false);
  const [apiError, setApiError] = useState(false);

  const [sortKey, setSortKey] = useState("score");   // score | price | savings | mileage
  const [sortDir, setSortDir] = useState("desc");    // asc | desc

  const [estMake, setEstMake] = useState("");
  const [estModel, setEstModel] = useState("");
  const [estYear, setEstYear] = useState("");
  const [estMileage, setEstMileage] = useState("");
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
    const next = selectedDeal?.listing_id === deal.listing_id ? null : deal;
    setSelectedDeal(next);

    // Disable benchmark/sales panels + requests
    setBenchmark(null);
    setSalesStats(null);
    setBenchmarkLoading(false);
    setSalesLoading(false);
  };

  const sharedStyles = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Bebas+Neue&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    ::-webkit-scrollbar { width: 4px; background: #f1f5f9; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
    .deal-row { transition: background 0.15s; cursor: pointer; }
    .deal-row:hover { background: #f1f5f9 !important; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
    @keyframes fadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    @keyframes slideIn { from { transform:translateY(8px); opacity:0; } to { transform:translateY(0); opacity:1; } }
    .home-search-btn { transition: background 0.15s, transform 0.1s; }
    .home-search-btn:hover { background: #1d4ed8 !important; transform: translateY(-1px); }
    .home-search-btn:active { transform: translateY(0); }
    select option { color: #0f172a; background: #ffffff; }
  `;

  const gridBg = (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none",
      backgroundImage: "linear-gradient(#94a3b818 1px,transparent 1px),linear-gradient(90deg,#94a3b818 1px,transparent 1px)",
      backgroundSize: "40px 40px", zIndex: 0 }} />
  );

  // ── HOME PAGE ────────────────────────────────────────────────────────────────
  if (view === "home") {
    return (
      <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a", fontFamily: "'DM Sans', sans-serif", position: "relative", display: "flex", flexDirection: "column" }}>
        <style>{sharedStyles}</style>
        {gridBg}

        {/* Nav bar */}
        <header style={{ position: "relative", zIndex: 10, borderBottom: "1px solid #e2e8f0", background: "#f8fafcee", backdropFilter: "blur(12px)", padding: "0 40px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: "0.1em", color: "#2563eb" }}>CARINTEL</div>
            <button onClick={() => setView("estimator")} style={{ background: "none", border: "1px solid #e2e8f0", borderRadius: 4, padding: "5px 14px", fontFamily: "monospace", fontSize: 11, color: "#475569", cursor: "pointer", letterSpacing: "0.08em" }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2563eb"; e.currentTarget.style.color = "#2563eb"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.color = "#475569"; }}>
              PRICE CHECK
            </button>
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            {[
              { label: "LISTINGS", value: isLoading ? "—" : fmtN(stats.active_listings) },
              { label: "MAKES",    value: isLoading ? "—" : stats.makes },
              { label: "AVG PRICE",value: isLoading ? "—" : fmt$(stats.avg_price) },
            ].map((s) => (
              <div key={s.label} style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "monospace", fontSize: 9, color: "#475569", letterSpacing: "0.1em" }}>{s.label}</div>
                <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: "#0f172a", fontWeight: 700 }}>{s.value}</div>
              </div>
            ))}
          </div>
        </header>

        {/* Hero */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 32px", position: "relative", zIndex: 1, animation: "fadeUp 0.4s ease" }}>
          <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 72, letterSpacing: "0.08em", color: "#0f172a", lineHeight: 1, textAlign: "center" }}>
            FIND YOUR NEXT <span style={{ color: "#2563eb" }}>DEAL</span>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 13, color: "#64748b", marginTop: 12, letterSpacing: "0.05em", textAlign: "center" }}>
            ML-powered used car pricing · {isLoading ? "..." : fmtN(stats.active_listings)} active listings
          </div>

          {/* Search card */}
          <div style={{ marginTop: 48, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "32px 36px", boxShadow: "0 4px 24px #0f172a0a", width: "100%", maxWidth: 920 }}>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8", letterSpacing: "0.12em", marginBottom: 20 }}>SEARCH FILTERS</div>

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
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", paddingBottom: 9 }}>–</span>
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
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", paddingBottom: 9 }}>–</span>
                <FilterSelect label="MAX MILEAGE" value={maxMileage} onChange={setMaxMileage} minWidth={110}>
                  <option value="">Any</option>
                  {[25000, 50000, 75000, 100000, 125000, 150000, 200000].map((m) => <option key={m} value={m}>{(m/1000).toFixed(0)}k mi</option>)}
                </FilterSelect>
              </div>
            </div>

            {/* Search button */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 24 }}>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8" }}>
                {filteredDeals.length > 0 ? `${filteredDeals.length} listings match` : ""}
              </div>
              <button
                className="home-search-btn"
                onClick={() => setView("results")}
                style={{ background: "#2563eb", color: "#ffffff", border: "none", borderRadius: 6, padding: "12px 32px", fontFamily: "monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer" }}
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
                style={{ background: "none", border: "1px solid #e2e8f0", color: "#475569", borderRadius: 20, padding: "6px 16px", fontFamily: "monospace", fontSize: 11, cursor: "pointer", transition: "border-color 0.15s, color 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#2563eb"; e.currentTarget.style.color = "#2563eb"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.color = "#475569"; }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <footer style={{ position: "relative", zIndex: 1, borderTop: "1px solid #e2e8f0", padding: "14px 40px", display: "flex", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#cbd5e1" }}>CARINTEL — XGBOOST PRICE MODEL</div>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#cbd5e1" }}>
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
        const params = new URLSearchParams({ make: estMake, model: estModel, year: estYear, mileage: estMileage, accident_count: estAccidents });
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

    const inputStyle = { background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 4, padding: "10px 12px", fontFamily: "monospace", fontSize: 13, color: "#0f172a", width: "100%", outline: "none", boxSizing: "border-box" };
    const labelStyle = { fontFamily: "monospace", fontSize: 9, color: "#64748b", letterSpacing: "0.1em", display: "block", marginBottom: 4 };

    return (
      <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a", fontFamily: "'DM Sans', sans-serif", position: "relative" }}>
        <style>{sharedStyles}</style>
        {gridBg}

        {/* Header */}
        <header style={{ position: "relative", zIndex: 10, borderBottom: "1px solid #e2e8f0", background: "#f8fafcee", backdropFilter: "blur(12px)", padding: "0 32px", display: "flex", alignItems: "center", height: 60, gap: 16 }}>
          <button onClick={() => setView("home")} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: "0.1em", color: "#2563eb", lineHeight: 1, padding: 0 }}>CARINTEL</button>
          <div style={{ width: 1, height: 24, background: "#e2e8f0" }} />
          <div style={{ fontFamily: "monospace", fontSize: 11, color: "#475569", letterSpacing: "0.1em" }}>PRICE CHECK</div>
        </header>

        {/* Form */}
        <div style={{ display: "flex", justifyContent: "center", padding: "60px 32px", position: "relative", zIndex: 1 }}>
          <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "40px 44px", boxShadow: "0 4px 24px #0f172a0a", width: "100%", maxWidth: 560 }}>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8", letterSpacing: "0.12em", marginBottom: 28 }}>MARKET PRICE ESTIMATOR</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelStyle}>MAKE *</label>
                <input style={inputStyle} placeholder="e.g. Toyota" value={estMake} onChange={(e) => setEstMake(e.target.value)} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label style={labelStyle}>MODEL *</label>
                <input style={inputStyle} placeholder="e.g. Camry" value={estModel} onChange={(e) => setEstModel(e.target.value)} />
              </div>
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
              <div style={{ marginTop: 16, fontFamily: "monospace", fontSize: 12, color: "#991b1b", background: "#fef2f2", border: "1px solid #ef4444", borderRadius: 4, padding: "10px 14px" }}>
                {estError}
              </div>
            )}

            <button onClick={runEstimate} disabled={estLoading}
              style={{ marginTop: 24, width: "100%", background: "#2563eb", color: "#ffffff", border: "none", borderRadius: 6, padding: "13px", fontFamily: "monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", cursor: estLoading ? "wait" : "pointer", opacity: estLoading ? 0.7 : 1 }}>
              {estLoading ? "ESTIMATING..." : "GET ESTIMATE →"}
            </button>

            {estResult && (
              <div style={{ marginTop: 28, borderTop: "1px solid #e2e8f0", paddingTop: 28, textAlign: "center" }}>
                <div style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8", letterSpacing: "0.12em", marginBottom: 8 }}>ESTIMATED MARKET VALUE</div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 56, color: "#2563eb", letterSpacing: "0.04em", lineHeight: 1 }}>
                  {fmt$(estResult.predicted_price)}
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b", marginTop: 8 }}>
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
  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", color: "#0f172a", fontFamily: "'DM Sans', sans-serif", position: "relative" }}>
      <style>{sharedStyles}</style>
      {gridBg}

      {apiError && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #ef4444",
            color: "#991b1b",
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
          borderBottom: "1px solid #e2e8f0",
          background: "#f8fafcee",
          backdropFilter: "blur(12px)",
          padding: "0 32px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 60,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button onClick={() => { setView("home"); setMakeFilter(""); setModelFilter(""); setSizeFilter(""); setBodyFilter(""); setMinYear(""); setMaxYear(""); setMinMileage(""); setMaxMileage(""); setMinStars(1); }} style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: "0.1em", color: "#2563eb", lineHeight: 1, padding: 0 }}>
            CARINTEL
          </button>
          <div style={{ width: 1, height: 24, background: "#e2e8f0" }} />
          <div style={{ fontFamily: "monospace", fontSize: 11, color: "#475569", letterSpacing: "0.1em" }}>DEAL FINDER</div>
          <div style={{ width: 1, height: 24, background: "#e2e8f0" }} />
          <button onClick={() => setView("estimator")} style={{ background: "none", border: "none", fontFamily: "monospace", fontSize: 11, color: "#475569", cursor: "pointer", letterSpacing: "0.1em", padding: 0 }}
            onMouseEnter={(e) => e.currentTarget.style.color = "#2563eb"}
            onMouseLeave={(e) => e.currentTarget.style.color = "#475569"}>
            PRICE CHECK
          </button>
        </div>

        {currentTicker.make && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 4, padding: "6px 14px" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", animation: "pulse 2s infinite" }} />
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b" }}>BEST DEAL:</span>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#0f172a" }}>{currentTicker.year} {currentTicker.make} {currentTicker.model}</span>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#2563eb", fontWeight: 700 }}>{fmt$(currentTicker.price)}</span>
            {currentTicker.savings > 0 && (
              <span style={{ fontFamily: "monospace", fontSize: 10, color: "#22c55e" }}>↓{fmt$(currentTicker.savings)} below market</span>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          {[
            { label: "LISTINGS", value: isLoading ? "—" : fmtN(stats.active_listings) },
            { label: "MAKES", value: isLoading ? "—" : stats.makes },
            { label: "AVG PRICE", value: isLoading ? "—" : fmt$(stats.avg_price) },
          ].map((s) => (
            <div key={s.label} style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "monospace", fontSize: 9, color: "#475569", letterSpacing: "0.1em" }}>{s.label}</div>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, color: "#0f172a", fontWeight: 700 }}>{s.value}</div>
            </div>
          ))}
        </div>
      </header>

      <main style={{ position: "relative", zIndex: 1, padding: "28px 32px", maxWidth: 1400, margin: "0 auto" }}>
        <div style={{ animation: "fadeUp 0.3s ease" }}>
          {/* Filter bar */}
          <div style={{ marginBottom: 16, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 6, padding: "14px 16px" }}>
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
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", paddingBottom: 9 }}>–</span>
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
                <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", paddingBottom: 9 }}>–</span>
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
                  onClick={() => { setMakeFilter(""); setModelFilter(""); setSizeFilter(""); setBodyFilter(""); setMinYear(""); setMaxYear(""); setMinMileage(""); setMaxMileage(""); setMinStars(1); }}
                  style={{ background: "none", border: "1px solid #e2e8f0", color: "#64748b", borderRadius: 4, padding: "6px 12px", cursor: "pointer", fontFamily: "monospace", fontSize: 11, alignSelf: "flex-end" }}
                >
                  CLEAR ✕
                </button>
              )}
            </div>

            {/* Row 2: score + sort + count */}
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid #f1f5f9", flexWrap: "wrap" }}>
              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b" }}>MIN SCORE</span>
              <input type="range" min={1} max={5} step={1} value={minStars} onChange={(e) => setMinStars(+e.target.value)} style={{ accentColor: "#2563eb", width: 80 }} />
              <span style={{ fontSize: 13, color: "#2563eb", minWidth: 60 }}>{"★".repeat(minStars) + "☆".repeat(5 - minStars)}</span>

              <div style={{ width: 1, height: 16, background: "#e2e8f0", margin: "0 4px" }} />

              <span style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b" }}>SORT</span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value)}
                style={{ background: "transparent", border: "1px solid #e2e8f0", borderRadius: 4, color: "#0f172a", fontFamily: "monospace", fontSize: 11, outline: "none", cursor: "pointer", padding: "4px 8px" }}
              >
                <option value="score">Score</option>
                <option value="price">Price</option>
                <option value="savings">Savings</option>
                <option value="mileage">Mileage</option>
                <option value="year">Year</option>
              </select>
              <button
                onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                style={{ background: "none", border: "1px solid #e2e8f0", color: "#0f172a", borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontFamily: "monospace", fontSize: 12 }}
              >
                {sortDir === "asc" ? "↑ ASC" : "↓ DESC"}
              </button>

              <div style={{ flex: 1 }} />
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#475569" }}>{filteredDeals.length} RESULTS</div>
            </div>
          </div>

          <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 110px 110px 100px 80px 110px", padding: "10px 20px", borderBottom: "1px solid #e2e8f0", background: "#f1f5f9" }}>
              {["VEHICLE", "PRICE", "MARKET VALUE", "SAVINGS", "MILEAGE", "STATE", "SCORE"].map((h) => (
                <div key={h} style={{ fontFamily: "monospace", fontSize: 9, color: "#475569", letterSpacing: "0.1em" }}>{h}</div>
              ))}
            </div>

            {loading.deals ? (
              <Spinner />
            ) : filteredDeals.length === 0 ? (
              <div style={{ padding: 40, textAlign: "center", color: "#475569", fontFamily: "monospace", fontSize: 12 }}>
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
                    gridTemplateColumns: "1fr 90px 110px 110px 100px 80px 110px",
                    padding: "13px 20px",
                    borderBottom: selectedDeal?.listing_id === deal.listing_id ? "none" : "1px solid #f1f5f9",
                    background: selectedDeal?.listing_id === deal.listing_id ? "#f1f5f9" : "transparent",
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
                          style={{ fontSize: 13, fontWeight: 500, color: "#0f172a", textDecoration: "none" }}
                          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                        >
                          {deal.year} {deal.make} {deal.model}
                        </a>
                      ) : (
                        <div style={{ fontSize: 13, fontWeight: 500, color: "#0f172a" }}>
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
                            color: "#64748b",
                            textDecoration: "none",
                            border: "1px solid #e2e8f0",
                            padding: "1px 6px",
                            borderRadius: 4,
                          }}
                        >
                          ↗
                        </a>
                      )}
                    </div>

                    <div style={{ fontSize: 11, color: "#475569", marginTop: 2 }}>
                      {normalizeBodyType(deal.body_type)} · {deal.trim}
                    </div>
                  </div>

                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 13, fontWeight: 700, color: "#0f172a" }}>{fmt$(deal.price)}</div>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: "#64748b" }}>{fmt$(deal.predicted_price)}</div>
                  <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 12, color: deal.savings >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600 }}>
                    {deal.savings >= 0 ? "↓ " : "↑ "}
                    {fmt$(Math.abs(deal.savings))}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#64748b" }}>{fmtN(deal.mileage)} mi</div>
                  <div style={{ fontFamily: "monospace", fontSize: 12, color: "#94a3b8" }}>{deal.location_state}</div>
                  <div style={{ fontSize: 15, color: getDealColor(deal.deal_score), letterSpacing: "0.05em" }}>
                    {starsDisplay(deal.deal_score)}
                  </div>
                </div>

                {selectedDeal?.listing_id === deal.listing_id && (
                  <div style={{ background: "#f8fafc", border: "1px solid #2563eb33", borderTop: "2px solid #2563eb", borderBottom: "1px solid #f1f5f9", padding: "20px 24px", animation: "slideIn 0.15s ease" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 22, color: "#2563eb", letterSpacing: "0.05em" }}>
                          {selectedDeal.year} {selectedDeal.make} {selectedDeal.model} — {selectedDeal.trim}
                        </div>
                        <div style={{ display: "flex", gap: 28, marginTop: 12, flexWrap: "wrap" }}>
                          {[
                            { label: "Listed Price", value: fmt$(selectedDeal.price), color: "#0f172a" },
                            { label: "Market Value", value: fmt$(selectedDeal.predicted_price), color: "#64748b" },
                            { label: "You Save", value: fmt$(selectedDeal.savings), color: selectedDeal.savings >= 0 ? "#22c55e" : "#ef4444" },
                            { label: "Mileage", value: `${fmtN(selectedDeal.mileage)} mi`, color: "#94a3b8" },
                            { label: "Deal Score", value: starsDisplay(selectedDeal.deal_score), color: getDealColor(selectedDeal.deal_score) },
                            { label: "Location", value: `${selectedDeal.location_city || ""} ${selectedDeal.location_state || ""}`.trim(), color: "#94a3b8" },
                            { label: "Accidents", value: selectedDeal.accident_count ?? 0, color: selectedDeal.accident_count > 0 ? "#ef4444" : "#22c55e" },
                          ].map(({ label, value, color }) => (
                            <div key={label}>
                              <div style={{ fontFamily: "monospace", fontSize: 9, color: "#475569", letterSpacing: "0.1em", marginBottom: 4 }}>{label}</div>
                              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 15, fontWeight: 700, color }}>{value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {selectedDeal.url && !selectedDeal.url.includes("mock") && (
                          <a href={selectedDeal.url} target="_blank" rel="noreferrer"
                            style={{ background: "#2563eb", color: "#ffffff", borderRadius: 4, padding: "6px 14px", fontFamily: "monospace", fontSize: 11, fontWeight: 700, textDecoration: "none", letterSpacing: "0.05em" }}>
                            VIEW LISTING →
                          </a>
                        )}
                        <button onClick={() => setSelectedDeal(null)}
                          style={{ background: "none", border: "1px solid #e2e8f0", color: "#475569", borderRadius: 4, padding: "6px 12px", cursor: "pointer", fontFamily: "monospace", fontSize: 11 }}>
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

      <footer style={{ position: "relative", zIndex: 1, borderTop: "1px solid #e2e8f0", padding: "16px 32px", display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 40 }}>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "#cbd5e1" }}>CARINTEL — XGBOOST PRICE MODEL</div>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "#cbd5e1" }}>
          {stats.last_updated ? `LAST UPDATED: ${new Date(stats.last_updated).toLocaleTimeString()}` : ""}
        </div>
      </footer>
    </div>
  );
}