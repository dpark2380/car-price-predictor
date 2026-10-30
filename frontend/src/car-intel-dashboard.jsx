import { useState, useEffect, useMemo } from "react";
import { fmt$, fmtN, normalizeBodyType } from "./utils/format";
import { dealTier } from "./utils/scoreColor.js";
import { BrandMark, CardSkeleton, DealPill, ListingCard, Photo, PriceBar, ThemeToggle, daysSinceSeen, vsMarket } from "./components/ui";

const API = process.env.REACT_APP_API_URL || "http://localhost:5001/api";

// Body types that support Small/Medium/Large sub-filtering (matched lowercase)
const SIZE_SUPPORTED = new Set(["suv", "truck", "sedan", "hatchback"]);

// Approximate size bands by predicted price (proxy for vehicle size within a category)
const SIZE_PRICE_BANDS = {
  Small: { max: 22000 },
  Medium: { min: 18000, max: 40000 },
  Large: { min: 35000 },
};

const PRICE_STEPS = [5000, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000];
const MILEAGE_STEPS = [10000, 25000, 50000, 75000, 100000, 150000, 200000];

// Lowest deal tier shown (scoreColor.js: 3 = Fair price, 4 = Good, 5 = Great).
const GRADE_CHOICES = [
  { tier: 1, label: "Any price" },
  { tier: 3, label: "Fair price or better" },
  { tier: 4, label: "Good deals" },
  { tier: 5, label: "Great deals only" },
];

const SORTS = [
  { value: "score:desc", label: "Best deal first" },
  { value: "savings:desc", label: "Most below market" },
  { value: "price:asc", label: "Price: low to high" },
  { value: "price:desc", label: "Price: high to low" },
  { value: "mileage:asc", label: "Mileage: lowest" },
  { value: "year:desc", label: "Year: newest" },
];

const GRADE_MEANINGS = [
  [95, "Well below what similar cars list for, far outside our estimate's usual margin of error."],
  [75, "Clearly below what similar cars list for."],
  [50, "Within the normal range for this car, mileage and year."],
  [25, "Above what similar cars list for."],
  [5, "Well above what similar cars list for."],
];

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fmtUpdated = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ── URLs ─────────────────────────────────────────────────────────────────────
// Each view has a path and its inputs live in the query string, so Back works
// and a filtered search or an estimate can be bookmarked or shared. Cloudflare
// Pages serves index.html for any path (the build has no 404.html). A single
// listing lives at /listings/<listing_id>.
const PATHS = { home: "/", results: "/listings", estimator: "/price-check", listing: "/listings/" };
const listingPath = (id) => `/listings/${encodeURIComponent(id)}`;

function fromUrl() {
  const q = new URLSearchParams(window.location.search);
  const path = window.location.pathname;
  if (path.startsWith("/listings/") && path.length > "/listings/".length) {
    return { ...fromUrlParams(new URLSearchParams(), "listing"), view: "listing", listingId: decodeURIComponent(path.slice("/listings/".length)) };
  }
  return fromUrlParams(q, Object.keys(PATHS).find((v) => PATHS[v] === path) || "home");
}

function fromUrlParams(q, view) {
  const get = (k, d = "") => (view === "home" ? d : q.get(k) ?? d);
  const grade = Number(get("grade", "1"));
  const sort = `${get("sort", "score")}:${get("dir", "desc")}`;
  return {
    view,
    listingId: "",
    make: get("make"), model: get("model"), trim: get("trim"),
    body: get("body"), size: get("size"),
    priceFrom: get("price_from"), priceTo: get("price_to"),
    yearFrom: get("year_from"), yearTo: get("year_to"),
    milesFrom: get("miles_from"), milesTo: get("miles_to"),
    grade: [1, 3, 4, 5].includes(grade) ? grade : 1,
    sort: SORTS.some((s) => s.value === sort) ? sort : "score:desc",
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

const PAGE_TITLES = {
  home: "Car Intel: used cars graded on price",
  results: "Used cars for sale, graded on price | Car Intel",
  estimator: "What is my car worth? Used car price check | Car Intel",
  listing: "Used car listing | Car Intel",
};

function Field({ label, value, onChange, disabled, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {children}
      </select>
    </label>
  );
}

export default function CarIntelDashboard() {
  const initial = useMemo(fromUrl, []);
  const [view, setView] = useState(initial.view); // "home" | "results" | "estimator" | "listing"
  const [listingId, setListingId] = useState(initial.listingId);

  const isRes = initial.view === "results";
  const [makeFilter, setMakeFilter] = useState(isRes ? initial.make : "");
  const [modelFilter, setModelFilter] = useState(isRes ? initial.model : "");
  const [sizeFilter, setSizeFilter] = useState(initial.size);
  const [bodyFilter, setBodyFilter] = useState(initial.body);
  const [minPrice, setMinPrice] = useState(initial.priceFrom);
  const [maxPrice, setMaxPrice] = useState(initial.priceTo);
  const [minYear, setMinYear] = useState(initial.yearFrom);
  const [maxYear, setMaxYear] = useState(initial.yearTo);
  const [minMileage, setMinMileage] = useState(initial.milesFrom);
  const [maxMileage, setMaxMileage] = useState(initial.milesTo);
  const [minStars, setMinStars] = useState(initial.grade);
  const [sort, setSort] = useState(initial.sort);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(60);

  const [deals, setDeals] = useState([]);
  const [preview, setPreview] = useState([]); // top deals, shown while the full list loads
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState({ deals: true, stats: true });
  const [apiError, setApiError] = useState(false);

  const isEst = initial.view === "estimator";
  const [estMake, setEstMake] = useState(isEst ? initial.make : "");
  const [estModel, setEstModel] = useState(isEst ? initial.model : "");
  const [estYear, setEstYear] = useState(isEst ? initial.year : "");
  const [estMileage, setEstMileage] = useState(isEst ? initial.mileage : "");
  const [estTrim, setEstTrim] = useState(isEst ? initial.trim : "");
  const [estResult, setEstResult] = useState(null);
  const [estLoading, setEstLoading] = useState(false);
  const [estError, setEstError] = useState(null);

  useEffect(() => {
    const load = async (key, url, setter) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status}`);
        setter(await res.json());
      } catch (e) {
        console.error(`Failed to load ${key}:`, e);
        setApiError(true);
      } finally {
        setLoading((l) => ({ ...l, [key]: false }));
      }
    };
    // Listing and photo URLs come from third-party data: only http(s) links
    // reach an href, and only https photos reach an <img>.
    const clean = (rows) =>
      rows.map((d) => ({
        ...d,
        url: /^https?:\/\//i.test(d.url || "") ? d.url : null,
        photo_url: /^https:\/\//i.test(d.photo_url || "") ? d.photo_url : null,
      }));
    // The top 100 deals arrive in a fraction of the full list's time, so the
    // first screen shows real listings while everything else downloads.
    fetch(`${API}/deals?limit=100`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setPreview(clean(rows)))
      .catch(() => {});
    load("deals", `${API}/deals?min_score=0`, (rows) => setDeals(clean(rows)));
    load("stats", `${API}/stats`, setStats);
  }, []);

  const optionsFor = (rows, key) => Array.from(new Set(rows.map((d) => d[key]?.toLowerCase()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const makeOptions = useMemo(() => optionsFor(deals, "make"), [deals]);
  const modelOptions = useMemo(() => (makeFilter ? optionsFor(deals.filter((d) => d.make?.toLowerCase() === makeFilter), "model") : []), [deals, makeFilter]);
  const estModelOptions = useMemo(() => (estMake ? optionsFor(deals.filter((d) => d.make?.toLowerCase() === estMake), "model") : []), [deals, estMake]);
  const estTrimOptions = useMemo(() => {
    if (!estMake || !estModel) return [];
    const set = new Set();
    deals.filter((d) => d.make?.toLowerCase() === estMake && d.model?.toLowerCase() === estModel).forEach((d) => d.trim && set.add(d.trim.trim()));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [deals, estMake, estModel]);
  const yearOptions = useMemo(() => Array.from(new Set(deals.map((d) => d.year).filter(Boolean))).sort((a, b) => a - b), [deals]);

  // Body types with how many listings each has, most common first.
  const bodyCounts = useMemo(() => {
    const counts = {};
    deals.forEach((d) => {
      const b = normalizeBodyType(d.body_type);
      counts[b] = (counts[b] || 0) + 1;
    });
    return Object.entries(counts).filter(([b]) => b !== "Unknown").sort((a, b) => b[1] - a[1]);
  }, [deals]);

  // The API already leaves out stale ads (unseen for 3 weeks, or on sale 6+ months).
  const topDeals = useMemo(() => (deals.length ? deals : preview).filter((d) => d.deal_score != null).sort((a, b) => b.deal_score - a.deal_score), [deals, preview]);

  const [sortKey, sortDir] = sort.split(":");
  const filteredDeals = useMemo(() => {
    const arr = deals
      .filter((d) => d.deal_score != null)
      .filter((d) => dealTier(d.deal_score) >= minStars)
      .filter((d) => !makeFilter || d.make?.toLowerCase() === makeFilter)
      .filter((d) => !modelFilter || d.model?.toLowerCase() === modelFilter)
      .filter((d) => !bodyFilter || normalizeBodyType(d.body_type).toLowerCase() === bodyFilter.toLowerCase())
      .filter((d) => {
        const band = SIZE_PRICE_BANDS[sizeFilter];
        if (!band) return true;
        const p = d.predicted_price ?? d.price;
        return !(band.min && p < band.min) && !(band.max && p > band.max);
      })
      .filter((d) => !minPrice || d.price >= Number(minPrice))
      .filter((d) => !maxPrice || d.price <= Number(maxPrice))
      .filter((d) => !minYear || d.year >= Number(minYear))
      .filter((d) => !maxYear || d.year <= Number(maxYear))
      .filter((d) => !minMileage || d.mileage >= Number(minMileage))
      .filter((d) => !maxMileage || d.mileage <= Number(maxMileage));

    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : -Infinity);
    const key = { score: "deal_score", price: "price", savings: "savings", mileage: "mileage", year: "year" }[sortKey] || "deal_score";
    const dir = sortDir === "asc" ? 1 : -1;
    return arr.sort((a, b) => (num(a[key]) === num(b[key]) ? num(b.deal_score) - num(a.deal_score) : (num(a[key]) - num(b[key])) * dir));
  }, [deals, minStars, makeFilter, modelFilter, sizeFilter, bodyFilter, minPrice, maxPrice, minYear, maxYear, minMileage, maxMileage, sortKey, sortDir]);

  // Thousands of cards at once would make the page sluggish: render a slice.
  useEffect(() => setVisibleCount(60), [minStars, makeFilter, modelFilter, sizeFilter, bodyFilter, minPrice, maxPrice, minYear, maxYear, minMileage, maxMileage, sort]);

  const anyFilter = makeFilter || modelFilter || sizeFilter || bodyFilter || minPrice || maxPrice || minYear || maxYear || minMileage || maxMileage || minStars > 1;
  const activeFilterCount = [makeFilter, modelFilter, sizeFilter, bodyFilter, minPrice || maxPrice, minYear || maxYear, minMileage || maxMileage, minStars > 1].filter(Boolean).length;

  // Keep the address bar in step with the view and its inputs. A new view is
  // a history entry (Back returns to it); input changes replace the current
  // entry so Back doesn't replay every dropdown change.
  useEffect(() => {
    const url =
      view === "results"
        ? toUrl(view, { make: makeFilter, model: modelFilter, body: bodyFilter, size: sizeFilter, price_from: minPrice, price_to: maxPrice, year_from: minYear, year_to: maxYear, miles_from: minMileage, miles_to: maxMileage, grade: minStars > 1 ? minStars : "", sort: sortKey !== "score" ? sortKey : "", dir: sortDir !== "desc" ? sortDir : "" })
        : view === "estimator"
        ? toUrl(view, { make: estMake, model: estModel, trim: estTrim, year: estYear, mileage: estMileage })
        : view === "listing"
        ? listingPath(listingId)
        : toUrl(view, {});
    if (url === window.location.pathname + window.location.search) return;
    if (url.split("?")[0] !== window.location.pathname) {
      window.history.pushState(null, "", url);
      window.scrollTo(0, 0);
    } else {
      window.history.replaceState(null, "", url);
    }
  }, [view, listingId, makeFilter, modelFilter, bodyFilter, sizeFilter, minPrice, maxPrice, minYear, maxYear, minMileage, maxMileage, minStars, sortKey, sortDir, estMake, estModel, estTrim, estYear, estMileage]);

  useEffect(() => {
    document.title = PAGE_TITLES[view];
  }, [view]);

  // Back/Forward: restore the view and inputs the URL describes.
  useEffect(() => {
    const onPop = () => {
      const u = fromUrl();
      setView(u.view);
      setListingId(u.listingId);
      if (u.view === "results") {
        setMakeFilter(u.make); setModelFilter(u.model); setBodyFilter(u.body); setSizeFilter(u.size);
        setMinPrice(u.priceFrom); setMaxPrice(u.priceTo); setMinYear(u.yearFrom); setMaxYear(u.yearTo);
        setMinMileage(u.milesFrom); setMaxMileage(u.milesTo); setMinStars(u.grade); setSort(u.sort);
      } else if (u.view === "estimator") {
        setEstMake(u.make); setEstModel(u.model); setEstTrim(u.trim); setEstYear(u.year); setEstMileage(u.mileage);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const runEstimate = async () => {
    if (!estMake || !estModel || !estYear || !estMileage) {
      setEstError("Choose a make and model, and enter the year and mileage.");
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

  const resetFilters = () => {
    setMakeFilter(""); setModelFilter(""); setSizeFilter(""); setBodyFilter("");
    setMinPrice(""); setMaxPrice(""); setMinYear(""); setMaxYear("");
    setMinMileage(""); setMaxMileage(""); setMinStars(1);
  };

  // Real links (middle-click and copy work) that switch views in place.
  const NavLink = ({ to, children, onNavigate, ...rest }) => (
    <a
      href={PATHS[to]}
      aria-current={view === to ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        (onNavigate || (() => setView(to)))();
      }}
      {...rest}
    >
      {children}
    </a>
  );

  const openListing = (deal) => {
    setListingId(deal.listing_id);
    setView("listing");
  };
  const cardProps = (d) => ({ deal: d, href: listingPath(d.listing_id), onOpen: openListing });

  const showListings = (apply) => {
    resetFilters();
    apply?.();
    setView("results");
  };

  const header = (
    <>
      {apiError && (
        <div className="banner" role="alert">
          Listings can't load right now. Check your connection, then refresh the page in a minute.
        </div>
      )}
      <header className="site-header">
        <div className="wrap">
          <NavLink to="home" className="brand">
            <BrandMark />
            Car Intel
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="results">Listings</NavLink>
            <NavLink to="estimator">Price check</NavLink>
          </nav>
          <ThemeToggle />
        </div>
      </header>
    </>
  );

  const footer = (
    <footer className="site-footer">
      <div className="wrap">
        <span>Grades compare each asking price with a market-value model trained on recent listings in the western US.</span>
        <span>{stats.last_updated ? `Listings updated ${fmtUpdated(stats.last_updated)}` : ""}</span>
      </div>
    </footer>
  );

  const total = loading.deals ? stats.graded_listings : deals.length;

  // ── HOME ────────────────────────────────────────────────────────────────────
  if (view === "home") {
    const homeCount = loading.deals ? null : filteredDeals.length;
    return (
      <>
        {header}
        <main className="wrap">
          <section className="search-panel" aria-labelledby="search-title">
            <h1 id="search-title">Search {total ? fmtN(total) : ""} used cars, each graded on price</h1>
            <div className="search-grid">
              <Field label="Make" value={makeFilter} onChange={(v) => { setMakeFilter(v); setModelFilter(""); }}>
                <option value="">All makes</option>
                {makeOptions.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
              </Field>
              <Field label="Model" value={modelFilter} onChange={setModelFilter} disabled={!makeFilter}>
                <option value="">All models</option>
                {modelOptions.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
              </Field>
              <Field label="Body type" value={bodyFilter} onChange={(v) => { setBodyFilter(v); setSizeFilter(""); }}>
                <option value="">All body types</option>
                {bodyCounts.map(([b]) => <option key={b} value={b}>{b}</option>)}
              </Field>
              <Field label="Max price" value={maxPrice} onChange={setMaxPrice}>
                <option value="">Any price</option>
                {PRICE_STEPS.map((p) => <option key={p} value={p}>{fmt$(p)}</option>)}
              </Field>
              <button className="btn btn-primary" style={{ height: 42 }} onClick={() => setView("results")}>
                {homeCount == null ? "Show cars" : `Show ${fmtN(homeCount)} cars`}
              </button>
            </div>
            <div className="quick-links">
              <button className="chip" onClick={() => showListings(() => setMinStars(4))}>Good deals</button>
              <button className="chip" onClick={() => showListings(() => setMaxPrice("15000"))}>Under $15,000</button>
              <button className="chip" onClick={() => showListings(() => setMaxMileage("50000"))}>Under 50,000 miles</button>
              <button className="chip" onClick={() => showListings(() => setMinYear(String(new Date().getFullYear() - 3)))}>3 years old or newer</button>
            </div>
          </section>

          <section className="section" aria-labelledby="best-title">
            <div className="section-head">
              <h2 id="best-title">Priced furthest below market</h2>
              <NavLink to="results" className="btn-link" onNavigate={() => showListings()}>
                See all deals
              </NavLink>
            </div>
            <div className="card-grid four">
              {topDeals.length
                ? topDeals.slice(0, 4).map((d) => <ListingCard key={d.listing_id} {...cardProps(d)} />)
                : [0, 1, 2, 3].map((i) => <CardSkeleton key={i} />)}
            </div>
          </section>

          {bodyCounts.length > 0 && (
            <section className="section" aria-labelledby="body-title">
              <div className="section-head">
                <h2 id="body-title">Shop by body type</h2>
              </div>
              <div className="body-tiles">
                {bodyCounts.slice(0, 8).map(([b, n]) => (
                  <button key={b} className="body-tile" onClick={() => showListings(() => setBodyFilter(b))}>
                    <strong>{b}</strong>
                    <span className="num">{fmtN(n)} listings</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="section" aria-labelledby="grades-title">
            <div className="section-head">
              <h2 id="grades-title">How prices are graded</h2>
            </div>
            <ul className="grade-scale">
              {GRADE_MEANINGS.map(([score, text]) => (
                <li key={score}>
                  <DealPill score={score} />
                  <div>{text}</div>
                </li>
              ))}
            </ul>
            <p className="note">
              Each listing is compared with what our model expects similar cars to list for, allowing for how accurate that estimate usually is at that price. It can't see condition, options or service history, so always check the car itself.
            </p>
          </section>
        </main>
        {footer}
      </>
    );
  }

  // ── ONE LISTING ─────────────────────────────────────────────────────────────
  if (view === "listing") {
    const deal = deals.find((d) => d.listing_id === listingId) || preview.find((d) => d.listing_id === listingId);
    const goBack = (e) => {
      e.preventDefault();
      // Came from inside the site: Back keeps the previous page's filters.
      if (window.history.length > 1 && document.referrer.startsWith(window.location.origin)) window.history.back();
      else setView("results");
    };
    if (!deal) {
      return (
        <>
          {header}
          <main className="wrap">
            <a className="back-link" href={PATHS.results} onClick={goBack}>‹ Back to listings</a>
            {loading.deals ? (
              <div className="detail" aria-hidden="true"><div className="detail-photo skeleton" /><div className="panel skeleton" style={{ height: 320 }} /></div>
            ) : (
              <div className="empty" style={{ marginTop: 12 }}>
                <p>This listing isn't in our current data. It may have sold or been taken down.</p>
                <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => setView("results")}>Browse listings</button>
              </div>
            )}
          </main>
          {footer}
        </>
      );
    }
    const name = `${deal.year} ${deal.make} ${deal.model}`;
    const vm = vsMarket(deal.savings);
    const seen = daysSinceSeen(deal);
    const similar = deals
      .filter((d) => d.listing_id !== deal.listing_id && d.make === deal.make && d.model === deal.model && Math.abs(d.year - deal.year) <= 1)
      .sort((a, b) => b.deal_score - a.deal_score)
      .slice(0, 3);
    return (
      <>
        {header}
        <main className="wrap">
          <a className="back-link" href={PATHS.results} onClick={goBack}>‹ Back to listings</a>
          <div className="detail">
            <div className="detail-photo">
              <Photo src={deal.photo_url} alt={name} />
            </div>
            <section className="panel" aria-labelledby="listing-title">
              <DealPill score={deal.deal_score} />
              <h1 id="listing-title" style={{ marginTop: 10 }}>{name}</h1>
              <div className="card-sub">{[deal.trim, normalizeBodyType(deal.body_type)].filter((v) => v && v !== "Unknown").join(", ")}</div>
              <div className="card-price num">{fmt$(deal.price)}</div>
              <div className={`card-market num ${vm.cls}`}>{vm.text}</div>
              <PriceBar score={deal.deal_score} />
              <dl className="facts">
                <dt>Market value</dt><dd className="num">{fmt$(deal.predicted_price)}</dd>
                <dt>Mileage</dt><dd className="num">{fmtN(deal.mileage)} mi</dd>
                <dt>Location</dt><dd>{[deal.location_city, deal.location_state].filter(Boolean).join(", ") || "—"}</dd>
                <dt>On sale for</dt>
                <dd className="num">{fmtN(deal.days_listed)} days</dd>
                <dt>Last seen</dt>
                <dd className={seen > 7 ? "caution" : ""}>{seen == null ? "—" : seen <= 1 ? "In the last day" : `${seen} days ago`}</dd>
              </dl>
              {deal.url && (
                <div style={{ marginTop: 18 }}>
                  <a className="btn btn-primary" href={deal.url} target="_blank" rel="noopener noreferrer">
                    View on the dealer's website<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </div>
              )}
            </section>
          </div>

          {similar.length > 0 && (
            <section className="section" aria-labelledby="similar-title">
              <div className="section-head"><h2 id="similar-title">Similar {deal.make} {deal.model}s</h2></div>
              <div className="card-grid">
                {similar.map((d) => <ListingCard key={d.listing_id} {...cardProps(d)} />)}
              </div>
            </section>
          )}
        </main>
        {footer}
      </>
    );
  }

  // ── PRICE CHECK ─────────────────────────────────────────────────────────────
  if (view === "estimator") {
    const maxYearInput = new Date().getFullYear() + 1;
    const matches = estResult
      ? deals.filter((d) => d.make?.toLowerCase() === estMake && d.model?.toLowerCase() === estModel && String(d.year) === String(estYear)).length
      : 0;
    const carName = `${estYear} ${cap(estMake)} ${cap(estModel)}`;
    return (
      <>
        {header}
        <main className="wrap">
          <div className="pc-layout">
            <section className="panel" aria-labelledby="pc-title">
              <h1 id="pc-title">Check a used car's price</h1>
              <form className="pc-form" onSubmit={(e) => { e.preventDefault(); runEstimate(); }}>
                <Field label="Make" value={estMake} onChange={(v) => { setEstMake(v); setEstModel(""); setEstTrim(""); setEstResult(null); }}>
                  <option value="">Choose a make</option>
                  {makeOptions.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
                </Field>
                <Field label="Model" value={estModel} onChange={(v) => { setEstModel(v); setEstTrim(""); setEstResult(null); }} disabled={!estMake}>
                  <option value="">Choose a model</option>
                  {estModelOptions.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
                </Field>
                {estTrimOptions.length > 0 && (
                  <Field label="Trim (optional)" value={estTrim} onChange={(v) => { setEstTrim(v); setEstResult(null); }}>
                    <option value="">Any trim</option>
                    {estTrimOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Field>
                )}
                <div className="pair">
                  <label className="field">
                    <span>Year</span>
                    <input type="number" inputMode="numeric" placeholder="e.g. 2019" min="1980" max={maxYearInput} value={estYear} onChange={(e) => setEstYear(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Mileage</span>
                    <input type="number" inputMode="numeric" placeholder="e.g. 45000" min="0" value={estMileage} onChange={(e) => setEstMileage(e.target.value)} />
                  </label>
                </div>
                {estError && <div className="alert" role="alert">{estError}</div>}
                <button className="btn btn-primary" type="submit" disabled={estLoading}>
                  {estLoading ? "Checking…" : "Check price"}
                </button>
              </form>
            </section>

            <section className="panel pc-result" aria-live="polite" aria-labelledby="pc-result-title">
              {estResult ? (
                <>
                  <h2 id="pc-result-title" className="label">
                    Typical asking price for a {carName}{estTrim ? ` ${estTrim}` : ""} with {fmtN(Number(estMileage))} miles
                  </h2>
                  <div className="value num">{fmt$(estResult.predicted_price)}</div>
                  {estResult.range_low != null && (
                    <div className="range">
                      <div className="range-track">
                        <div className="range-band" />
                        <div className="range-mid" />
                      </div>
                      <div className="range-ends num">
                        <span>{fmt$(estResult.range_low)}</span>
                        <span>{fmt$(estResult.range_high)}</span>
                      </div>
                      <p className="note">About half of similar cars are listed within this range.</p>
                    </div>
                  )}
                  <p className="note">
                    {estResult.comparables != null && estResult.comparables < 3 ? "We've seen very few of this car recently, so treat this as a rough guide. " : ""}
                    Condition, options and service history can move a real price either way.
                  </p>
                  {matches > 0 && (
                    <button
                      className="btn btn-secondary"
                      style={{ marginTop: 18 }}
                      onClick={() => showListings(() => { setMakeFilter(estMake); setModelFilter(estModel); setMinYear(String(estYear)); setMaxYear(String(estYear)); })}
                    >
                      See {fmtN(matches)} {carName} {matches === 1 ? "listing" : "listings"}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <h2 id="pc-result-title" className="label">Your estimate</h2>
                  <p className="note" style={{ marginTop: 8 }}>
                    Enter a car to see what similar ones are listed for and the range most of them fall in. Use it to judge an ad, or to price your own car.
                  </p>
                </>
              )}
            </section>
          </div>
        </main>
        {footer}
      </>
    );
  }

  // ── LISTINGS ────────────────────────────────────────────────────────────────
  // While the full list loads, the default view (best deals, no filters) can
  // already show the top-100 preview, which is the same rows.
  const cards = !loading.deals ? filteredDeals.slice(0, visibleCount) : !anyFilter && sort === "score:desc" ? preview.slice(0, visibleCount) : [];
  return (
    <>
      {header}
      <main className="wrap">
        <div className="listings-layout">
          <aside className={`filters-panel${filtersOpen ? " open" : ""}`} id="filters" aria-label="Filters">
            <h2>
              Filters
              {anyFilter && <button className="btn-link" onClick={resetFilters}>Clear all</button>}
            </h2>
            <Field label="Make" value={makeFilter} onChange={(v) => { setMakeFilter(v); setModelFilter(""); }}>
              <option value="">All makes</option>
              {makeOptions.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
            </Field>
            <Field label="Model" value={modelFilter} onChange={setModelFilter} disabled={!makeFilter}>
              <option value="">All models</option>
              {modelOptions.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
            </Field>
            <Field label="Body type" value={bodyFilter} onChange={(v) => { setBodyFilter(v); if (!SIZE_SUPPORTED.has(v.toLowerCase())) setSizeFilter(""); }}>
              <option value="">All body types</option>
              {bodyCounts.map(([b]) => <option key={b} value={b}>{b}</option>)}
            </Field>
            {SIZE_SUPPORTED.has(bodyFilter.toLowerCase()) && (
              <Field label="Size" value={sizeFilter} onChange={setSizeFilter}>
                <option value="">Any size</option>
                <option value="Small">Small</option>
                <option value="Medium">Medium</option>
                <option value="Large">Large</option>
              </Field>
            )}
            <div className="pair">
              <Field label="Min price" value={minPrice} onChange={setMinPrice}>
                <option value="">Any</option>
                {PRICE_STEPS.map((p) => <option key={p} value={p}>{fmt$(p)}</option>)}
              </Field>
              <Field label="Max price" value={maxPrice} onChange={setMaxPrice}>
                <option value="">Any</option>
                {PRICE_STEPS.map((p) => <option key={p} value={p}>{fmt$(p)}</option>)}
              </Field>
            </div>
            <div className="pair">
              <Field label="Year from" value={minYear} onChange={setMinYear}>
                <option value="">Any</option>
                {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
              </Field>
              <Field label="Year to" value={maxYear} onChange={setMaxYear}>
                <option value="">Any</option>
                {[...yearOptions].reverse().map((y) => <option key={y} value={y}>{y}</option>)}
              </Field>
            </div>
            <div className="pair">
              <Field label="Mileage from" value={minMileage} onChange={setMinMileage}>
                <option value="">Any</option>
                {MILEAGE_STEPS.map((m) => <option key={m} value={m}>{fmtN(m)}</option>)}
              </Field>
              <Field label="Mileage to" value={maxMileage} onChange={setMaxMileage}>
                <option value="">Any</option>
                {MILEAGE_STEPS.map((m) => <option key={m} value={m}>{fmtN(m)}</option>)}
              </Field>
            </div>
            <fieldset className="grade-options">
              <legend>Price grade</legend>
              {GRADE_CHOICES.map(({ tier, label }) => (
                <label key={tier}>
                  <input type="radio" name="grade" checked={minStars === tier} onChange={() => setMinStars(tier)} />
                  {label}
                </label>
              ))}
            </fieldset>
          </aside>

          <section aria-labelledby="results-title">
            <div className="results-bar">
              <h1 id="results-title">
                Used cars
                <span className="num" role="status">{loading.deals ? "Loading…" : `${fmtN(filteredDeals.length)} results`}</span>
              </h1>
              <div className="results-tools">
                <button className="btn btn-secondary filters-toggle" aria-expanded={filtersOpen} aria-controls="filters" onClick={() => setFiltersOpen((o) => !o)}>
                  Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
                </button>
                <label>
                  <span className="sr-only">Sort by</span>
                  <select value={sort} onChange={(e) => setSort(e.target.value)}>
                    {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
              </div>
            </div>

            {!cards.length && loading.deals ? (
              <div className="card-grid">{[0, 1, 2, 3, 4, 5].map((i) => <CardSkeleton key={i} />)}</div>
            ) : !cards.length ? (
              <div className="empty">
                <p>No cars match these filters.</p>
                {anyFilter && <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={resetFilters}>Clear filters</button>}
              </div>
            ) : (
              <div className="card-grid">
                {cards.map((d) => <ListingCard key={d.listing_id} {...cardProps(d)} />)}
              </div>
            )}

            {!loading.deals && visibleCount < filteredDeals.length && (
              <div style={{ textAlign: "center", marginTop: 20 }}>
                <button className="btn btn-secondary" onClick={() => setVisibleCount((v) => v + 60)}>
                  Show more cars <span className="num" style={{ fontWeight: 400, color: "var(--ink-3)" }}>({fmtN(filteredDeals.length - visibleCount)} more)</span>
                </button>
              </div>
            )}
          </section>
        </div>
      </main>
      {footer}
    </>
  );
}
