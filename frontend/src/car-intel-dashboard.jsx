import { Fragment, useState, useEffect, useMemo } from "react";
import { fmt$, fmtN, normalizeBodyType } from "./utils/format";
import { Select } from "./components/Select";
import Market from "./market/Market";
import { marketPath as marketUrl } from "./market/api";
import { carName, plural } from "./market/format";
import { dealTier } from "./utils/scoreColor";
import { BrandMark, CardSkeleton, Certified, DealPill, FUEL_LABELS, Gallery, ListingCard, NOT_RATED_WHY, PriceBar, ThemeToggle, STALE_DAYS, daysOnSale, driveFuel, showFees, vsMarket } from "./components/ui";

// Dealer colour names arrive in any case ("GRAY", "isle of man green"): title case them, small joining words lower.
const colourName = (s) => s.replace(/\*+$/, "").toLowerCase().replace(/(^|[\s/-])([a-z]+)/g, (m, sep, w, i) => sep + (i && /^(of|and|the|de|on|with|in)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)));
const API = process.env.REACT_APP_API_URL || "http://localhost:5001/api";

const PRICE_STEPS = [5000, 10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000];
const MILEAGE_STEPS = [10000, 25000, 50000, 75000, 100000, 150000, 200000];

// Lowest deal tier shown (scoreColor.js: 3 = Fair price, 4 = Good, 5 = Great).
// Lowest deal_score of each tier (the same cuts as utils/scoreColor.js), as the API's min_score.
const TIER_MIN_SCORE = { 3: 35, 4: 65, 5: 90 };
const DRIVETRAINS = ["AWD", "4WD", "FWD", "RWD"];
const COLORS = ["white", "black", "grey", "silver", "blue", "red", "green", "brown", "other"];
const GRADE_CHOICES = [
  { tier: 1, label: "Any grade" },
  { tier: 3, label: "Fair price or better" },
  { tier: 4, label: "Good deals" },
  { tier: 5, label: "Great deals only" },
];

// Sort fields: the direction each starts in when picked, and what each
// direction means in plain words (shown on the flip button).
const SORTS = {
  featured: { label: "Featured",   start: "desc", asc: "Best first",   desc: "Best first" },
  score:   { label: "Deal score",   start: "desc", asc: "Worst first",  desc: "Best first" },
  savings: { label: "Below market", start: "desc", asc: "Least first",  desc: "Most first" },
  price:   { label: "Price",        start: "asc",  asc: "Low to high",  desc: "High to low" },
  mileage: { label: "Mileage",      start: "asc",  asc: "Low to high",  desc: "High to low" },
  year:    { label: "Year",         start: "desc", asc: "Oldest first", desc: "Newest first" },
  found:   { label: "Date found",   start: "desc", asc: "Oldest first", desc: "Newest first" },
  mpg:     { label: "Fuel economy", start: "desc", asc: "Low to high",  desc: "High to low" },
};

// One shuffle order per visit, so a reload or a second page of cars doesn't reorder the list.
const SEED = (() => {
  try {
    const saved = sessionStorage.getItem("carintel-seed");
    if (saved) return saved;
    const fresh = String(Math.floor(Math.random() * 1e9));
    sessionStorage.setItem("carintel-seed", fresh);
    return fresh;
  } catch (e) {
    return "1";
  }
})();

// The API's query string for a set of filters (URL-named, see fromUrlParams).
const API_PARAMS = { make: "make", model: "model", body: "body", price_from: "min_price", price_to: "max_price", year_from: "min_year", year_to: "max_year", miles_from: "min_miles", miles_to: "max_miles", drivetrain: "drivetrain", fuel: "fuel", color: "color", photo: "has_photo", reduced: "reduced" };
const apiQuery = (f) => {
  const q = new URLSearchParams();
  Object.entries(API_PARAMS).forEach(([k, name]) => f[k] && q.set(name, f[k]));
  if (f.grade > 1) q.set("min_score", TIER_MIN_SCORE[f.grade]);
  return q.toString();
};

// Listing and photo URLs come from third-party data: only http(s) links
// reach an href, and only https photos reach an <img>.
const clean = (rows) =>
  rows.map((d) => ({
    ...d,
    url: /^https?:\/\//i.test(d.url || "") ? d.url : null,
    photo_url: /^https:\/\//i.test(d.photo_url || "") ? d.photo_url : null,
  }));

const GRADE_MEANINGS = [
  [95, "Well below what similar cars list for, far outside our estimate's usual margin of error."],
  [75, "Clearly below what similar cars list for."],
  [50, "Within the normal range for this car, mileage and year."],
  [25, "Above what similar cars list for."],
  [5, "Well above what similar cars list for."],
];

// A value from the URL stays selectable before the listings that supply its options arrive.
const keep = (opts, v) => (v && !opts.some((o) => String(o) === String(v)) ? [...opts, v] : opts);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const fmtUpdated = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ── URLs ─────────────────────────────────────────────────────────────────────
// Each view has a path and its inputs live in the query string, so Back works
// and a filtered search or an estimate can be bookmarked or shared. Cloudflare
// Pages serves index.html for any path (the build has no 404.html). A single
// listing lives at /listings/<listing_id>. The Market area is /market, /market/<make>,
// /market/<make>/<model>, /market/method and /car/<vin>; its own router reads the path.
const PATHS = { home: "/", results: "/listings", estimator: "/price-check", listing: "/listings/", market: "/market" };
const listingPath = (id) => `/listings/${encodeURIComponent(id)}`;

function fromUrl() {
  const q = new URLSearchParams(window.location.search);
  const path = window.location.pathname;
  if (path.startsWith("/listings/") && path.length > "/listings/".length) {
    return { ...fromUrlParams(new URLSearchParams(), "listing"), view: "listing", listingId: decodeURIComponent(path.slice("/listings/".length)) };
  }
  if (path === "/market" || path.startsWith("/market/") || path.startsWith("/car/")) {
    return { ...fromUrlParams(new URLSearchParams(), "market"), marketPath: path };
  }
  return fromUrlParams(q, Object.keys(PATHS).find((v) => PATHS[v] === path) || "home");
}

function fromUrlParams(q, view) {
  const get = (k, d = "") => (view === "home" ? d : q.get(k) ?? d);
  const grade = Number(get("grade", "1"));
  const sortKey = SORTS[get("sort")] ? get("sort") : "featured";
  const dir = get("dir").toLowerCase();
  return {
    view,
    listingId: "",
    marketPath: "",
    make: get("make"), model: get("model"), trim: get("trim"),
    body: get("body"),
    drivetrain: get("drivetrain"), fuel: get("fuel"), color: get("color"),
    priceFrom: get("price_from"), priceTo: get("price_to"),
    yearFrom: get("year_from"), yearTo: get("year_to"),
    milesFrom: get("miles_from"), milesTo: get("miles_to"),
    grade: [1, 3, 4, 5].includes(grade) ? grade : 1,
    photo: get("photo") === "1",
    reduced: get("reduced") === "1",
    sortKey, sortDir: dir === "asc" || dir === "desc" ? dir : SORTS[sortKey].start,
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
  market: "Used car market | Car Intel",
};

export default function CarIntelDashboard() {
  const initial = useMemo(fromUrl, []);
  const [view, setView] = useState(initial.view); // "home" | "results" | "estimator" | "listing"
  const [listingId, setListingId] = useState(initial.listingId);
  const [marketPath, setMarketPath] = useState(initial.marketPath);
  const [specs, setSpecs] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [options, setOptions] = useState(null);

  const isRes = initial.view === "results";
  const [makeFilter, setMakeFilter] = useState(isRes ? initial.make : "");
  const [modelFilter, setModelFilter] = useState(isRes ? initial.model : "");
  const [bodyFilter, setBodyFilter] = useState(initial.body);
  const [minPrice, setMinPrice] = useState(initial.priceFrom);
  const [maxPrice, setMaxPrice] = useState(initial.priceTo);
  const [minYear, setMinYear] = useState(initial.yearFrom);
  const [maxYear, setMaxYear] = useState(initial.yearTo);
  const [minMileage, setMinMileage] = useState(initial.milesFrom);
  const [maxMileage, setMaxMileage] = useState(initial.milesTo);
  const [minStars, setMinStars] = useState(initial.grade);
  const [photoOnly, setPhotoOnly] = useState(initial.photo);
  const [reducedOnly, setReducedOnly] = useState(initial.reduced);
  const [sortKey, setSortKey] = useState(initial.sortKey);
  const [sortDir, setSortDir] = useState(initial.sortDir);
  const [driveFilter, setDriveFilter] = useState(initial.drivetrain);
  const [fuelFilter, setFuelFilter] = useState(initial.fuel);
  const [colorFilter, setColorFilter] = useState(initial.color); // comma list of colour families
  const [moreOpen, setMoreOpen] = useState(false);
  // On a phone the secondary filters move into the More filters panel, so the results start sooner.
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 480px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 480px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const [count, setCount] = useState(null); // cars the filters being edited would show
  const [visibleCount, setVisibleCount] = useState(60);

  // Filters being edited, in URL names; "applied" is what the list on screen was fetched with (set by the Show button).
  const pending = {
    make: makeFilter, model: modelFilter, body: bodyFilter, price_from: minPrice, price_to: maxPrice, year_from: minYear, year_to: maxYear,
    miles_from: minMileage, miles_to: maxMileage, grade: minStars > 1 ? minStars : "", photo: photoOnly ? "1" : "", reduced: reducedOnly ? "1" : "",
    drivetrain: driveFilter, fuel: fuelFilter, color: colorFilter,
  };
  const [applied, setApplied] = useState(pending);
  const [commit, setCommit] = useState(0);
  const [results, setResults] = useState({ rows: [], state: "loading" }); // state: loading | ok | error

  const [deals, setDeals] = useState([]);
  const [preview, setPreview] = useState([]); // top deals, shown while the full list loads
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState({ deals: true, stats: true });
  const [apiError, setApiError] = useState(false);
  const [medianErr, setMedianErr] = useState(null); // the model card's median error, percent

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
    // The top 100 deals arrive in a fraction of the full list's time, so the
    // first screen shows real listings while everything else downloads.
    fetch(`${API}/deals?limit=100`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setPreview(clean(rows)))
      .catch(() => {});
    load("deals", `${API}/deals?min_score=0`, (rows) => setDeals(clean(rows)));
    load("stats", `${API}/stats`, setStats);
    fetch(`${API}/model-card`).then((r) => (r.ok ? r.json() : null)).then((d) => setMedianErr(d?.card?.test?.median_ape ?? null)).catch(() => {});
  }, []);

  // Entering the listings, or pressing Show, applies the filters being edited.
  useEffect(() => {
    if (view === "results") setApplied(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, commit]);

  // The list: filtered by the API; Featured is its seeded shuffle, the other sorts happen below.
  const featured = sortKey === "featured";
  const featuredQuery = featured ? `sort=featured&seed=${SEED}` : "";
  useEffect(() => {
    if (view !== "results") return undefined;
    const ctl = new AbortController();
    setResults((r) => ({ ...r, state: "loading" }));
    fetch(`${API}/deals?${[apiQuery(applied), featuredQuery].filter(Boolean).join("&")}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((rows) => setResults({ rows: clean(rows), state: "ok" }))
      .catch((e) => e.name !== "AbortError" && setResults({ rows: [], state: "error" }));
    return () => ctl.abort();
  }, [view, applied, featuredQuery]);

  // How many cars the filters being edited would show, asked a moment after the last change.
  const pendingQuery = apiQuery(pending);
  useEffect(() => {
    if (view !== "results" && view !== "home") return undefined;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`${API}/deals/count?${pendingQuery}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setCount(d ? d.count : null))
        .catch(() => {});
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [view, pendingQuery]);

  // Spec sheet and photo gallery for the open listing. Specs stay empty until the pipeline has fetched them.
  useEffect(() => {
    setSpecs([]);
    setPhotos([]);
    if (view !== "listing" || !listingId) return;
    let live = true;
    const load = (path, set) =>
      fetch(`${API}/${path}?id=${encodeURIComponent(listingId)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((v) => live && set(v))
        .catch(() => {});
    load("specs", setSpecs);
    load("photos", setPhotos);
    return () => { live = false; };
  }, [view, listingId]);

  // Factory options come from a paid lookup the API makes once per car, and only when it can: nothing shows until then.
  // Price history is no longer fetched here: the car page loads it on request.
  const openVin = view === "listing" ? (deals.find((d) => d.listing_id === listingId) || preview.find((d) => d.listing_id === listingId))?.vin : null;
  useEffect(() => {
    setOptions(null);
    if (!openVin) return;
    let live = true;
    const load = (path, set) =>
      fetch(`${API}/${path}?vin=${encodeURIComponent(openVin)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => live && v?.available && set(v))
        .catch(() => {});
    load("options", setOptions);
    return () => { live = false; };
  }, [openVin]);

  const optionsFor = (rows, key) => Array.from(new Set(rows.map((d) => d[key]?.toLowerCase()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  // Options are lowercased to merge "FORTE" and "Forte"; show each in its most common spelling, so "bmw" reads "BMW".
  const labels = useMemo(() => {
    const n = {};
    deals.forEach((d) => [d.make, d.model].forEach((s) => s && (n[s] = (n[s] || 0) + 1)));
    const out = {};
    Object.entries(n).sort((a, b) => b[1] - a[1]).forEach(([s]) => { out[s.toLowerCase()] ??= s; });
    return out;
  }, [deals]);
  const label = (s) => labels[s] ?? cap(s);
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
  // Home page: only cars with a photo; the full listings page still shows all.
  const topDeals = useMemo(() => (deals.length ? deals : preview).filter((d) => d.deal_score != null && !d.rating_basis && d.photo_url).sort((a, b) => b.deal_score - a.deal_score), [deals, preview]);

  // Featured keeps the API's order; every other sort is applied to the rows it returned.
  const sortedDeals = useMemo(() => {
    if (featured) return results.rows;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : -Infinity);
    const field = { score: "deal_score", price: "price", savings: "savings", mileage: "mileage", year: "year" }[sortKey];
    // null = unknown; sorted last in either direction rather than as 0.
    const val = (d) => {
      const m = [d.city_mpg, d.highway_mpg].filter(Boolean);
      const v = sortKey === "found" ? Date.parse(d.first_seen) : sortKey === "mpg" ? (m.length ? m.reduce((a, b) => a + b) / m.length : NaN) : d[field] == null ? NaN : Number(d[field]);
      return Number.isFinite(v) ? v : null;
    };
    const dir = sortDir === "asc" ? 1 : -1;
    return [...results.rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null || y === null) return (x === null) - (y === null);
      return x === y ? num(b.deal_score) - num(a.deal_score) : (x - y) * dir;
    });
  }, [results.rows, featured, sortKey, sortDir]);
  const hasMpg = useMemo(() => results.rows.filter((d) => d.city_mpg || d.highway_mpg).length >= 20, [results.rows]);

  // Thousands of cards at once would make the page sluggish: render a slice.
  useEffect(() => setVisibleCount(60), [results.rows, sortKey, sortDir]);

  const advanced = [driveFilter, fuelFilter, colorFilter, minMileage || maxMileage, maxYear, photoOnly, reducedOnly];
  const anyFilter = makeFilter || modelFilter || bodyFilter || minPrice || maxPrice || minYear || minStars > 1 || advanced.some(Boolean);
  // What the applied advanced filters say, each with the way to remove it.
  const chips = [
    applied.drivetrain && [`Drivetrain: ${applied.drivetrain.toUpperCase()}`, () => setDriveFilter("")],
    applied.fuel && [`Fuel: ${FUEL_LABELS[applied.fuel]}`, () => setFuelFilter("")],
    applied.color && [`Colour: ${applied.color.split(",").map(cap).join(", ")}`, () => setColorFilter("")],
    (applied.miles_from || applied.miles_to) && [applied.miles_from && applied.miles_to ? `${fmtN(applied.miles_from)} to ${fmtN(applied.miles_to)} miles` : applied.miles_from ? `Over ${fmtN(applied.miles_from)} miles` : `Under ${fmtN(applied.miles_to)} miles`, () => { setMinMileage(""); setMaxMileage(""); }],
    applied.year_to && [`${applied.year_to} or older`, () => setMaxYear("")],
    applied.photo && ["With a photo", () => setPhotoOnly(false)],
    applied.reduced && ["Recently reduced", () => setReducedOnly(false)],
  ].filter(Boolean);

  // Keep the address bar in step with the view and its inputs. A new view is
  // a history entry (Back returns to it); input changes replace the current
  // entry so Back doesn't replay every dropdown change.
  useEffect(() => {
    const url =
      view === "results"
        ? toUrl(view, { ...applied, sort: sortKey !== "featured" ? sortKey : "", dir: sortKey !== "featured" && sortDir !== SORTS[sortKey].start ? sortDir : "" })
        : view === "estimator"
        ? toUrl(view, { make: estMake, model: estModel, trim: estTrim, year: estYear, mileage: estMileage })
        : view === "listing"
        ? listingPath(listingId)
        : view === "market"
        ? marketPath
        : toUrl(view, {});
    if (url === window.location.pathname + window.location.search) return;
    if (url.split("?")[0] !== window.location.pathname) {
      window.history.pushState(null, "", url);
      window.scrollTo(0, 0);
    } else {
      window.history.replaceState(null, "", url);
    }
  }, [view, listingId, marketPath, applied, sortKey, sortDir, estMake, estModel, estTrim, estYear, estMileage]);

  useEffect(() => {
    if (view === "market") return; // the Market pages name themselves
    const d = view === "listing" && (deals.find((x) => x.listing_id === listingId) || preview.find((x) => x.listing_id === listingId));
    document.title = d ? `${d.year} ${carName(d.make, d.model)} for ${fmt$(d.price)} | Car Intel` : PAGE_TITLES[view];
  }, [view, listingId, deals, preview]);

  // Show the view and inputs the address bar describes (Back/Forward, and links that stay in the site).
  const applyUrl = () => {
    const u = fromUrl();
    setView(u.view);
    setListingId(u.listingId);
    setMarketPath(u.marketPath);
    if (u.view === "results") {
      setMakeFilter(u.make); setModelFilter(u.model); setBodyFilter(u.body); setDriveFilter(u.drivetrain); setFuelFilter(u.fuel); setColorFilter(u.color);
      setMinPrice(u.priceFrom); setMaxPrice(u.priceTo); setMinYear(u.yearFrom); setMaxYear(u.yearTo);
      setMinMileage(u.milesFrom); setMaxMileage(u.milesTo); setMinStars(u.grade); setPhotoOnly(u.photo); setReducedOnly(u.reduced); setSortKey(u.sortKey); setSortDir(u.sortDir); setCommit((c) => c + 1);
    } else if (u.view === "estimator") {
      setEstMake(u.make); setEstModel(u.model); setEstTrim(u.trim); setEstYear(u.year); setEstMileage(u.mileage);
    }
  };
  useEffect(() => {
    window.addEventListener("popstate", applyUrl);
    return () => window.removeEventListener("popstate", applyUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const goPath = (path) => {
    window.history.pushState(null, "", path);
    window.scrollTo(0, 0);
    applyUrl();
  };
  // An <a> that goes to a path inside the site without a reload.
  const pathLink = (to) => ({
    href: to,
    onClick: (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      goPath(to);
    },
  });

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
      setEstResult({ ...data, used: { make: estMake, model: estModel, year: estYear, mileage: estMileage, trim: estTrim } }); // the inputs this result is for
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
    setMakeFilter(""); setModelFilter(""); setBodyFilter(""); setDriveFilter(""); setFuelFilter(""); setColorFilter("");
    setMinPrice(""); setMaxPrice(""); setMinYear(""); setMaxYear("");
    setMinMileage(""); setMaxMileage(""); setMinStars(1); setPhotoOnly(false); setReducedOnly(false);
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

  const showListings = (apply, keepPending) => {
    if (!keepPending) resetFilters();
    apply?.();
    setView("results");
  };

  const showLabel = count == null ? "Show cars" : `Show ${fmtN(count)} ${count === 1 ? "car" : "cars"}`;
  // The four common filters and the Show button, as on the home page and above the list.
  const primaryRow = (onShow) => (
    <>
      <Select label="Make" value={makeFilter} onChange={(v) => { setMakeFilter(v); setModelFilter(""); }}>
        <option value="">All makes</option>
        {keep(makeOptions, makeFilter).map((m) => <option key={m} value={m}>{label(m)}</option>)}
      </Select>
      <Select label="Model" value={modelFilter} onChange={setModelFilter} disabled={!makeFilter}>
        <option value="">All models</option>
        {keep(modelOptions, modelFilter).map((m) => <option key={m} value={m}>{label(m)}</option>)}
      </Select>
      <Select label="Body type" value={bodyFilter} onChange={setBodyFilter}>
        <option value="">All body types</option>
        {bodyCounts.map(([b]) => <option key={b} value={b}>{b}</option>)}
      </Select>
      <Select label="Max price" value={maxPrice} onChange={setMaxPrice}>
        <option value="">Any price</option>
        {PRICE_STEPS.map((p) => <option key={p} value={p}>{fmt$(p)}</option>)}
      </Select>
      <button className="btn" onClick={onShow}>{showLabel}</button>
    </>
  );

  const secondary = (
    <>
      <Select label="Min price" value={minPrice} onChange={setMinPrice}>
        <option value="">Any</option>
        {PRICE_STEPS.map((p) => <option key={p} value={p}>{fmt$(p)}</option>)}
      </Select>
      <Select label="Year from" value={minYear} onChange={setMinYear}>
        <option value="">Any</option>
        {keep(yearOptions, minYear).map((y) => <option key={y} value={y}>{y}</option>)}
      </Select>
      <Select label="Price grade" value={String(minStars)} onChange={(v) => setMinStars(Number(v))}>
        {GRADE_CHOICES.map(({ tier, label }) => <option key={tier} value={tier}>{label}</option>)}
      </Select>
    </>
  );

  const wrap = view === "results" ? "wrap wide" : "wrap";
  const header = (
    <>
      {apiError && (
        <div className="banner" role="alert">
          Listings can't load right now. Check your connection, then refresh the page in a minute.
        </div>
      )}
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>
        Skip to content
      </a>
      <header className="site-header">
        <div className={wrap}>
          <NavLink to="home" className="brand">
            <BrandMark />
            <span className="brand-name">Car Intel</span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="results">Listings</NavLink>
            <NavLink to="estimator">Price check</NavLink>
            <NavLink to="market" onNavigate={() => goPath("/market")} aria-current={view === "market" && marketPath !== "/market/method" ? "page" : undefined}>Market</NavLink>
            <a {...pathLink("/market/method")} aria-current={view === "market" && marketPath === "/market/method" ? "page" : undefined}>Method</a>
          </nav>
          <ThemeToggle />
        </div>
      </header>
    </>
  );

  const footer = (
    <footer className="site-footer">
      <div className={wrap}>
        <span>Grades compare each asking price with a <a {...pathLink("/market/method")}>market-value model</a> trained on recent listings in the western US.</span>
        <span>{stats.last_updated ? `Listings updated ${fmtUpdated(stats.last_updated)}` : ""}</span>
      </div>
    </footer>
  );

  const total = loading.deals ? stats.graded_listings : deals.length;

  // ── MARKET ──────────────────────────────────────────────────────────────────
  if (view === "market") {
    return (
      <>
        {header}
        <main className="wrap" id="main" tabIndex={-1}>
          <Market path={marketPath} navigate={goPath} />
        </main>
        {footer}
      </>
    );
  }

  // ── HOME ────────────────────────────────────────────────────────────────────
  if (view === "home") {
    return (
      <>
        {header}
        <main className="wrap" id="main" tabIndex={-1}>
          <h1 id="search-title" className="page-title">Search {total ? fmtN(total) : ""} used cars</h1>
          {medianErr != null && (
            <p className="note" style={{ marginTop: -8, marginBottom: 20 }}>
              Grades come from a price model whose estimates are typically within {medianErr.toFixed(1)}% of the asking price. <a {...pathLink("/market/method")}>How the model works</a>
            </p>
          )}
          <section className="search-panel" aria-labelledby="search-title">
            <div className="search-grid">{primaryRow(() => setView("results"))}</div>
            <div className="quick-links">
              <button className="chip" onClick={() => showListings(() => setMinStars(4), true)}>Good deals</button>
              <button className="chip" onClick={() => showListings(() => setMaxPrice("15000"), true)}>Under $15,000</button>
              <button className="chip" onClick={() => showListings(() => setMaxMileage("50000"), true)}>Under 50,000 miles</button>
              <button className="chip" onClick={() => showListings(() => setMinYear(String(new Date().getFullYear() - 3)), true)}>3 years old or newer</button>
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
              <li>
                <DealPill score={null} />
                <div>We've seen no other dealer's car like this, or only one or two with a price far from this one, so there is nothing reliable to compare it with.</div>
              </li>
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
    // An older link for a relisted car falls back to its current listing (ids start with the VIN).
    const deal = deals.find((d) => d.listing_id === listingId) || preview.find((d) => d.listing_id === listingId) || deals.find((d) => d.vin && d.vin === listingId.split("-")[0]);
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
          <main className="wrap" id="main" tabIndex={-1}>
            <a className="back-link" href={PATHS.results} onClick={goBack}>← Listings</a>
            {loading.deals ? (
              <div className="detail" aria-hidden="true"><div className="detail-photo skeleton" /><div className="panel skeleton" style={{ height: 320 }} /></div>
            ) : (
              <div className="empty" style={{ marginTop: 12 }}>
                <p>This listing isn't in our current data. It may have sold or been taken down.</p>
                <p style={{ marginTop: 8 }}><button className="btn-link" onClick={() => setView("results")}>Browse current listings</button></p>
              </div>
            )}
          </main>
          {footer}
        </>
      );
    }
    const name = `${deal.year} ${carName(deal.make, deal.model)}`;
    const vm = vsMarket(deal.savings);
    const onSale = daysOnSale(deal);
    const atDealer = deal.dos_active != null && Math.abs(onSale - deal.dos_active) >= 7 ? deal.dos_active : null; // shown only when it differs clearly
    const color = deal.exterior_color || deal.base_ext_color;
    const dealerKind = { franchise: "Franchise dealer", independent: "Independent dealer" }[deal.dealer_type];
    const dealerLine = [dealerKind, deal.stock_no && `Stock ${deal.stock_no}`].filter(Boolean).join(" · ");
    const rated = deal.deal_score != null;
    const comps = deals
      .filter((d) => d.listing_id !== deal.listing_id && d.make === deal.make && d.model === deal.model && Math.abs(d.year - deal.year) <= 1 && d.mileage != null)
      .sort((a, b) => Math.abs(a.mileage - deal.mileage) - Math.abs(b.mileage - deal.mileage))
      .slice(0, 4);
    // The listing's own length wins over the NHTSA one.
    const lengthRow = deal.overall_length != null ? ["Length", `${Number(deal.overall_length).toFixed(1)} in`] : null;
    const specsWithLength = !lengthRow ? specs
      : specs.some((g) => g.group === "Dimensions & Weights")
        ? specs.map((g) => (g.group !== "Dimensions & Weights" ? g : { ...g, rows: g.rows.some(([l]) => l === "Length") ? g.rows.map((r) => (r[0] === "Length" ? lengthRow : r)) : [lengthRow, ...g.rows] }))
        : [...specs, { group: "Dimensions & Weights", rows: [lengthRow] }];
    const k = deal.comparables;
    const carTitle = `${deal.year} ${carName(deal.make, deal.model)}`;
    const err = deal.typical_error_pct;
    const mi = comps.map((d) => d.mileage).sort((a, b) => a - b);
    const milesOff = comps.length >= 3 ? Math.round((deal.mileage - (mi[(mi.length - 1) >> 1] + mi[mi.length >> 1]) / 2) / 1000) * 1000 : 0;
    return (
      <>
        {header}
        <main className="wrap" id="main" tabIndex={-1}>
          <a className="back-link" href={PATHS.results} onClick={goBack}>← Listings</a>
          <div className="detail">
            <Gallery key={deal.listing_id} photos={photos.length ? photos : [deal.photo_url].filter(Boolean)} alt={name} />
            <section className="panel" aria-labelledby="listing-title">
              <DealPill score={deal.deal_score} />
              {deal.is_certified === 1 && <Certified />}
              <h1 id="listing-title" style={{ marginTop: 10 }}>{name}</h1>
              <div className="card-sub">{[deal.trim, normalizeBodyType(deal.body_type)].filter((v) => v && v !== "Unknown").join(", ")}</div>
              {driveFuel(deal) && <div className="card-sub">{driveFuel(deal)}</div>}
              <div className="card-price num">{fmt$(deal.price)}</div>
              {showFees(deal) && <div className="fees num">Plus {fmt$(deal.fees)} dealer fees</div>}
              {rated ? <>
                <div className={`card-market num ${vm.cls}`}>{vm.text}</div>
                <PriceBar score={deal.deal_score} />
                {deal.rating_basis && <p className="note">Rough rating</p>}
                {dealTier(deal.deal_score) >= 4 && onSale >= STALE_DAYS && <p className="note caution">Note: For sale for {fmtN(onSale)} days</p>}
              </> : <p className="note">{NOT_RATED_WHY}</p>}
              <dl className="facts">
                {rated && <><dt>Market value</dt><dd className="num">{fmt$(deal.predicted_price)}</dd></>}
                <dt>Mileage</dt><dd className="num">{fmtN(deal.mileage)} mi</dd>
                <dt>Location</dt><dd>{[deal.location_city, deal.location_state].filter(Boolean).join(", ") || "—"}</dd>
                {color && <><dt>Colour</dt><dd>{deal.color_family && <i className="sw" style={{ "--sw": `var(--c-${deal.color_family})` }} />}{colourName(color)}</dd></>}
                {(deal.interior_color || deal.base_int_color) && <><dt>Interior</dt><dd>{colourName(deal.interior_color || deal.base_int_color)}</dd></>}
                <dt>{atDealer != null ? "On the market" : "On sale for"}</dt>
                <dd className={`num ${onSale >= STALE_DAYS ? "caution" : ""}`}>{fmtN(onSale)} days</dd>
                {atDealer != null && <><dt>At this dealer</dt><dd className="num">{fmtN(atDealer)} days</dd></>}
                {deal.reduced && <><dt>Reduced</dt><dd className="num">Was {fmt$(deal.reduced.was)}, now {fmt$(deal.price)} (−{Math.round(deal.reduced.pct)}%)</dd></>}
                {deal.dealer_name && (
                  <>
                    <dt>Dealer</dt>
                    <dd>
                      {deal.dealer_name}
                      {dealerLine && <span className="dealer-sub">{dealerLine}</span>}
                      {deal.dealer_street && <span className="dealer-sub">{[deal.dealer_street, deal.location_city, deal.location_state].filter(Boolean).join(", ")}</span>}
                    </dd>
                  </>
                )}
                {/* Many small dealers' sites block visitors they think are bots; a phone number is never blocked. */}
                {deal.dealer_phone && <><dt>Phone</dt><dd><a href={`tel:${deal.dealer_phone.replace(/[^\d+]/g, "")}`}>{deal.dealer_phone}</a></dd></>}
              </dl>
              {deal.url && (
                <div style={{ marginTop: 18 }}>
                  <a className="btn" href={deal.url} target="_blank" rel="noopener noreferrer">
                    View on the dealer's website<span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </div>
              )}
              <div className="linkrow">
                {deal.vin && <a className="btn-quiet" {...pathLink(`/car/${encodeURIComponent(deal.vin)}`)}>Price history</a>}
                <a className="btn-quiet" {...pathLink(marketUrl(deal.make, deal.model))}>All {plural(carName(deal.make, deal.model))}</a>
                <a className="btn-quiet" {...pathLink("/market/method")}>How accurate is this?</a>
              </div>
            </section>
          </div>

          <section className="section" aria-labelledby="why-title">
            <div className="section-head"><h2 id="why-title">{rated ? "Why this estimate" : "Why there's no rating"}</h2></div>
            <div className="panel why">
              {deal.rating_basis ? (
                <p>Rated against {fmtN(deal.market.count)} listed across the US (median {fmt$(deal.market.median)}), because our own data has too few of this car. Treat it as rough: it ignores mileage and region.</p>
              ) : rated ? (
                <p>
                  Estimated at {fmt$(deal.predicted_price)}.
                  {err != null && ` For cars like this the estimate is usually within ${err.toFixed(1)}% (so ${fmt$(Math.round(deal.predicted_price * (1 - err / 100) / 100) * 100)} to ${fmt$(Math.round(deal.predicted_price * (1 + err / 100) / 100) * 100)}).`}
                </p>
              ) : (
                k >= 1 ? (
                  <p>Our price model has only {k} other {k > 1 ? plural(carTitle) : carTitle} from other dealers to learn from, and this price is far from what {k === 1 ? "it suggests" : "they suggest"}. With so few to compare, we can't tell a bargain from a bad estimate.</p>
                ) : (
                  <p>Our price model has no other {carTitle} from other dealers to learn from, so we can't say what it should cost.</p>
                )
              )}
              {!rated && deal.market && (
                <p>Across the US, {fmtN(deal.market.count)} are listed by dealers, typically for {fmt$(deal.market.median)} (most between {fmt$(deal.market.p25)} and {fmt$(deal.market.p75)}).</p>
              )}
              {rated && !deal.rating_basis && k != null && deal.cohort_median_price != null && (
                <p>
                  Based on {fmtN(k)} other {k === 1 ? carTitle : plural(carTitle)} at other dealers, which typically {k === 1 ? "lists" : "list"} for {fmt$(deal.cohort_median_price)}.
                  {k <= 2 && " That's very few, so treat the rating as rough."}
                </p>
              )}
            </div>
            {comps.length > 0 && (
              <>
                <h3 className="why-similar">{rated ? `Similar ${plural(carName(deal.make, deal.model))}, nearest mileage first` : "Closest we have"}</h3>
                <div className="card-grid four">
                  {comps.map((d) => <ListingCard key={d.listing_id} level={4} {...cardProps(d)} />)}
                </div>
                {Math.abs(milesOff) > 2000 && <p className="note">This car has about {fmtN(Math.abs(milesOff))} {milesOff < 0 ? "fewer" : "more"} miles than these.</p>}
              </>
            )}
          </section>

          {options?.options?.length > 0 && (
            <section className="section" aria-labelledby="options-title">
              <div className="section-head"><h2 id="options-title">Factory options</h2></div>
              <div className="panel why">
                {options.combined_msrp != null && <p>Sticker price when new: {fmt$(options.combined_msrp)}</p>}
                <ul className="why-list">
                  {options.options.map((o, i) => (
                    <li key={`${o.code}-${i}`}>
                      <span>{o.name}</span>
                      <span className="num">{o.msrp != null ? fmt$(o.msrp) : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {specsWithLength.length > 0 && (
            <section className="section" aria-labelledby="specs-title">
              <div className="section-head"><h2 id="specs-title">Specifications</h2></div>
              <div className="panel specs">
                {specsWithLength.map((g, i) => (
                  <details key={g.group} open={i === 0}>
                    <summary>{g.group}</summary>
                    <dl className="facts">
                      {g.rows.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}
                    </dl>
                  </details>
                ))}
                <p className="specs-note">Specs from the dealer’s listing and NHTSA. Confirm details with the dealer.</p>
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
    const u = estResult?.used || {};
    const stale = estResult && (u.year !== estYear || u.mileage !== estMileage || u.trim !== estTrim);
    const matches = estResult
      ? deals.filter((d) => d.make?.toLowerCase() === u.make && d.model?.toLowerCase() === u.model && String(d.year) === String(u.year)).length
      : 0;
    const carTitle = `${u.year} ${carName(label(u.make), label(u.model))}`;
    return (
      <>
        {header}
        <main className="wrap" id="main" tabIndex={-1}>
          <h1 id="pc-title" className="page-title">Check a used car's price</h1>
          <div className="pc-layout">
            <section className="panel" aria-labelledby="pc-title">
              <form className="pc-form" onSubmit={(e) => { e.preventDefault(); runEstimate(); }}>
                <Select label="Make" value={estMake} onChange={(v) => { setEstMake(v); setEstModel(""); setEstTrim(""); setEstResult(null); }}>
                  <option value="">Choose a make</option>
                  {keep(makeOptions, estMake).map((m) => <option key={m} value={m}>{label(m)}</option>)}
                </Select>
                <Select label="Model" value={estModel} onChange={(v) => { setEstModel(v); setEstTrim(""); setEstResult(null); }} disabled={!estMake}>
                  <option value="">Choose a model</option>
                  {keep(estModelOptions, estModel).map((m) => <option key={m} value={m}>{label(m)}</option>)}
                </Select>
                {keep(estTrimOptions, estTrim).length > 0 && (
                  <Select label="Trim (optional)" value={estTrim} onChange={(v) => { setEstTrim(v); setEstResult(null); }}>
                    <option value="">Any trim</option>
                    {keep(estTrimOptions, estTrim).map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
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
                <button className="btn" type="submit" disabled={estLoading}>
                  {estLoading ? "Checking…" : "Check price"}
                </button>
              </form>
            </section>

            <section className="panel pc-result" aria-live="polite" aria-labelledby="pc-result-title">
              {estResult ? (
                <>
                {stale && <p className="note" style={{ margin: "0 0 10px" }}>Press Check price to update.</p>}
                <div style={stale ? { opacity: 0.5 } : undefined}>
                  <h2 id="pc-result-title" className="label">
                    Typical asking price for a {carTitle}{u.trim ? ` ${u.trim}` : ""} with {fmtN(Number(u.mileage))} miles
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
                      className="btn-quiet"
                      style={{ marginTop: 18 }}
                      onClick={() => showListings(() => { setMakeFilter(u.make); setModelFilter(u.model); setMinYear(String(u.year)); setMaxYear(String(u.year)); })}
                    >
                      See {fmtN(matches)} {carTitle} {matches === 1 ? "listing" : "listings"}
                    </button>
                  )}
                </div>
                </>
              ) : (
                <>
                  <h2 id="pc-result-title" className="label">Your estimate</h2>
                  <p className="note" style={{ marginTop: 8 }}>
                    {estLoading ? "Checking the price…" : <>
                    Enter a car to see what similar ones are listed for and the range most of them fall in. Use it to judge an ad, or to price your own car.
                  </>}
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
  const cards = sortedDeals.slice(0, visibleCount);
  const clearAll = () => { resetFilters(); setCommit((c) => c + 1); };
  const removeChip = (fn) => () => { fn(); setCommit((c) => c + 1); };
  const appliedMore = chips.length + (phone ? [minPrice, minYear, minStars > 1].filter(Boolean).length : 0);
  return (
    <>
      {header}
      <main className={wrap} id="main" tabIndex={-1}>
        <section className="search-panel" aria-label="Filters" style={{ marginTop: 28 }}>
          <div className="search-grid">{primaryRow(() => setCommit((c) => c + 1))}</div>
          <div className="filter-row">
            {!phone && secondary}
            <div className="btns">
              <button className="btn-quiet" aria-expanded={moreOpen} aria-controls="more-filters" onClick={() => setMoreOpen((o) => !o)}>
                More filters{appliedMore ? ` · ${appliedMore}` : ""}
              </button>
              {anyFilter && <button className="btn-link" onClick={clearAll}>Clear all</button>}
            </div>
          </div>
          {moreOpen && (
            <div className="more-panel" id="more-filters">
              {phone && secondary}
              <Select label="Drivetrain" value={driveFilter} onChange={setDriveFilter}>
                <option value="">Any drivetrain</option>
                {DRIVETRAINS.map((d) => <option key={d} value={d.toLowerCase()}>{d}</option>)}
              </Select>
              <Select label="Fuel" value={fuelFilter} onChange={setFuelFilter}>
                <option value="">Any fuel</option>
                {Object.entries(FUEL_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
              <Select label="Year to" value={maxYear} onChange={setMaxYear}>
                <option value="">Any</option>
                {[...keep(yearOptions, maxYear)].reverse().map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
              <fieldset className="wide">
                <legend>Colour</legend>
                <div className="swatches">
                  {COLORS.map((c) => {
                    const on = colorFilter.split(",").includes(c);
                    return (
                      <button key={c} type="button" className="chip" aria-pressed={on}
                        onClick={() => setColorFilter(COLORS.filter((x) => (x === c ? !on : colorFilter.split(",").includes(x))).join(","))}>
                        <i className="sw" style={{ "--sw": `var(--c-${c})` }} />{cap(c)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <Select label="Mileage from" value={minMileage} onChange={setMinMileage}>
                <option value="">Any</option>
                {MILEAGE_STEPS.map((m) => <option key={m} value={m}>{fmtN(m)}</option>)}
              </Select>
              <Select label="Mileage to" value={maxMileage} onChange={setMaxMileage}>
                <option value="">Any</option>
                {MILEAGE_STEPS.map((m) => <option key={m} value={m}>{fmtN(m)}</option>)}
              </Select>
              <div className="wide checks">
                <label className="check-option">
                  <input type="checkbox" checked={photoOnly} onChange={(e) => setPhotoOnly(e.target.checked)} />
                  Only cars with a photo
                </label>
                <label className="check-option">
                  <input type="checkbox" checked={reducedOnly} onChange={(e) => setReducedOnly(e.target.checked)} />
                  Recently reduced
                </label>
              </div>
              <p className="note wide">Cars with no drivetrain, fuel or colour listed are hidden while that filter is set.</p>
            </div>
          )}
          {chips.length > 0 && (
            <ul className="quick-links applied" aria-label="Applied filters" style={{ listStyle: "none", padding: 0 }}>
              {chips.map(([text, remove]) => (
                <li key={text}>
                  <button className="chip" aria-label={`Remove filter: ${text}`} onClick={removeChip(remove)}>{text} <span aria-hidden="true">×</span></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="results-title" style={{ marginTop: 28 }}>
          <div className="results-bar">
            <h1 id="results-title" className="page-title">
              Used cars{" "}
              <span className="num" role="status">{results.state === "loading" ? "Loading…" : results.state === "error" ? "" : `${fmtN(sortedDeals.length)} results`}</span>
            </h1>
            <div className="results-tools">
              <Select label="Sort by" hideLabel value={sortKey} onChange={(v) => { setSortKey(v); setSortDir(SORTS[v].start); }}>
                {Object.entries(SORTS).filter(([k]) => k !== "mpg" || hasMpg || sortKey === "mpg").map(([k, sort]) => <option key={k} value={k}>{sort.label}</option>)}
              </Select>
              {!featured && (
                <button className="btn-quiet" title="Flip the order" onClick={() => setSortDir(sortDir === "asc" ? "desc" : "asc")}>
                  <span aria-hidden="true">{sortDir === "asc" ? "↑" : "↓"}</span> {SORTS[sortKey][sortDir]}
                </button>
              )}
            </div>
          </div>

          {results.state === "error" ? (
            <div className="alert" role="alert">
              <p>The cars couldn't be loaded. Check your connection and try again.</p>
              <p style={{ marginTop: 10 }}><button type="button" className="btn-quiet" onClick={() => setApplied({ ...applied })}>Try again</button></p>
            </div>
          ) : results.state === "loading" && !cards.length ? (
            <div className="card-grid">{[0, 1, 2, 3, 4, 5].map((i) => <CardSkeleton key={i} />)}</div>
          ) : !cards.length ? (
            <div className="empty">
              <p>No cars match these filters.</p>
              <p style={{ marginTop: 8 }}>Widen the price or year range, or <button className="btn-link" onClick={clearAll}>clear all filters</button>.</p>
            </div>
          ) : (
            <div className="card-grid" aria-busy={results.state === "loading"}>
              {cards.map((d) => <ListingCard key={d.listing_id} level={2} {...cardProps(d)} />)}
            </div>
          )}

          {results.state === "ok" && visibleCount < sortedDeals.length && (
            <div style={{ textAlign: "center", marginTop: 20 }}>
              <button className="btn-quiet" onClick={() => setVisibleCount((v) => v + 60)}>
                Show more cars <span className="num" style={{ fontWeight: 400, color: "var(--muted)" }}>({fmtN(sortedDeals.length - visibleCount)} more)</span>
              </button>
            </div>
          )}
        </section>
      </main>
      {footer}
    </>
  );
}
