// Fixed API responses, so the tests don't depend on the live database.
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const deal = (id, over) => ({
  listing_id: id, url: `https://dealer.example/${id}`, photo_url: null,
  trim: "SE", body_type: "Sedan", mileage: 40000, location_city: "Denver", location_state: "CO",
  days_listed: 20, last_seen: day(0), first_seen: day(20), price_change_percent: null,
  dealer_name: "Test Motors", ...over,
});

const DEALS = [
  deal("a1", { year: 2020, make: "Honda", model: "Accord", price: 18000, predicted_price: 22000, savings: 4000, deal_score: 95, photo_url: "https://img.example/a1.jpg", drivetrain: "AWD", color_family: "black", exterior_color: "BLACK" }),
  deal("b2", { year: 2019, make: "Toyota", model: "Camry", vin: "4T1B11HK5KU123456", price: 21000, predicted_price: 21500, savings: 500, deal_score: 55, photo_url: "https://img.example/b2.jpg" }),
  deal("c3", { year: 2018, make: "Toyota", model: "Corolla", price: 16000, predicted_price: 14000, savings: -2000, deal_score: 20, body_type: "Hatchback" }),
];

// The API's filters as far as the specs use them; the order stays as listed (Featured is not shuffled here).
const filtered = (q) => DEALS.filter((d) =>
  (!q.get("make") || d.make.toLowerCase() === q.get("make")) &&
  (!q.get("model") || d.model.toLowerCase() === q.get("model")) &&
  (!q.get("body") || d.body_type.toLowerCase() === q.get("body")) &&
  (!q.get("min_score") || d.deal_score >= Number(q.get("min_score"))) &&
  (!q.get("has_photo") || d.photo_url) &&
  (!q.get("color") || q.get("color").split(",").includes(d.color_family)) &&
  (!q.get("drivetrain") || q.get("drivetrain").split(",").includes((d.drivetrain || "").toLowerCase())));

const MAKES = [{ make: "Toyota", n: 120, median_price: 21000, median_gap_pct: -0.4, median_dom: 60 }, { make: "Honda", n: 80, median_price: 18000, median_gap_pct: 0.2, median_dom: 70 }];
const CAMRY_MONTHS = [{ month: "2026-10", n: 60, p25: 15000, p50: 20000, p75: 25000 }, { month: "2026-11", n: 40, p25: 16000, p50: 21000, p75: 26000 }];
const MAKE_PAGE = {
  make: "Toyota", summary: { n: 120, models: 2, median_price: 21000, median_dom: 60 },
  models: [{ model: "Camry", n: 90, p25: 15000, p50: 21000, p75: 26000, median_gap_pct: -0.4, median_dom: 60, usual_error_pct: 6.1, unrated: 3, median_miles: 70000 }],
  monthly: [{ model: "Camry", months: CAMRY_MONTHS }],
};
const MODEL_PAGE = {
  make: "Toyota", model: "Camry",
  summary: { n: 90, price_p25: 15000, price_p50: 21000, price_p75: 26000, median_miles: 70000, dom_p25: 30, dom_p50: 60, dom_p75: 120 },
  by_year: [2017, 2018, 2019, 2020].map((year, i) => ({ year, n: 20 + i, p25: 14000 + i * 1000, p50: 18000 + i * 1000, p75: 22000 + i * 1000 })),
  histogram: [0, 5000, 10000, 15000, 20000, 25000].map((lo, i) => ({ lo, n: [2, 10, 25, 30, 18, 5][i] })),
  dom_bands: ["0-30", "31-60", "61-90", "91-180", "181-365", "365+"].map((band, i) => ({ band, n: 10 + i })),
  price_changes: { cut_n: 20, median_cut_pct: 3.2, raised_n: 4 },
  grades: { great: 5, good: 20, fair: 40, high: 15, over: 8, nr: 2 },
  monthly: CAMRY_MONTHS,
  points: Array.from({ length: 40 }, (_, i) => [2017 + (i % 4), 20000 + i * 3000, 26000 - i * 250, 3]), points_total: 90,
};
const CAR = {
  vin: "4T1B11HK5KU123456", listing_id: "b2", url: "https://dealer.example/b2", year: 2019, make: "Toyota", model: "Camry", trim: "SE",
  price: 21000, mileage: 40000, dealer_name: "Test Motors", location_city: "Denver", location_state: "CO", days_on_market: 20, days_in_listing: 20,
  first_seen: "2026-11-01", deal_score: 55, rating_basis: null, comparables: 12, typical_error_pct: 6, predicted_price: 21500, model_number: 21500, market: null,
  history: [{ date: "2026-10-01", price: 22000, miles: 40000, seller: "Test Motors", source: "scrape" }, { date: "2026-10-20", price: 21000, miles: 40000, seller: "Test Motors", source: "scrape" }],
  has_full_history: false,
  cohort: { n: 8, p25: 19000, p50: 21000, p75: 23000, prices: [18000, 19000, 20000, 21000, 21000, 22000, 23000, 25000] },
};
const BANDS = [{ lo: 0, hi: 20000 }, { lo: 20000, hi: null }];
const CARD = {
  card: {
    date: "2026-11-23", selected_model: "blend", rows: { pool: 1000, train: 640, val: 160, test: 200 },
    candidates: { linear: { test_mae: 4000, val_mae: 4100 }, blend: { test_mae: 2700, val_mae: 2800 } },
    test: { n: 200, median_ape: 7.7, ci95: [7.3, 8.0], bias_pct: -0.1, mae: 2700, within10: 59 },
    segment_errors: BANDS.map((b) => ({ ...b, error_pct: 9, n: 100, cells: [{ comparables_lo: 0, comparables_hi: 3, error_pct: 12, n: 40 }, { comparables_lo: 3, comparables_hi: null, error_pct: 7, n: 60 }] })),
    importance: { rows: 100, groups: [{ group: "Comparables", mae_added: 8000, relative: 1 }, { group: "Location", mae_added: 500, relative: 0.06 }] },
  },
  live: {
    cars_listed: 100, grades: { great: 5, good: 20, fair: 50, high: 15, over: 5, nr: 5 },
    not_rated: { no_comparables: 4, thin_extreme_score: 1, unknown: 0, rated_from_national: 0 },
    gap_by_comparables: [{ band: "0", n: 10, median_abs_gap_pct: 14 }, { band: "30+", n: 30, median_abs_gap_pct: 6 }],
  },
};

// A 1x1 PNG for every listing photo.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function mockApi(page) {
  await page.route("https://img.example/**", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("http://localhost:5001/api/**", (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ json: body });
    switch (url.pathname) {
      case "/api/deals": return json(filtered(url.searchParams).slice(0, Number(url.searchParams.get("limit")) || DEALS.length));
      case "/api/deals/count": return json({ count: filtered(url.searchParams).length });
      case "/api/stats": return json({ graded_listings: DEALS.length, last_updated: new Date().toISOString() });
      case "/api/specs": return json([{ group: "Engine", rows: [["Power", "192 hp"]] }]);
      case "/api/photos": return json(url.searchParams.get("id") === "a1" ? [1, 2, 3].map((n) => `https://img.example/a1-${n}.jpg`) : []);
      case "/api/market/makes": return json(MAKES);
      case "/api/market/make/Toyota": return json(MAKE_PAGE);
      case "/api/market/model/Toyota/Camry": return json(MODEL_PAGE);
      case "/api/car/4T1B11HK5KU123456": return json(CAR);
      case "/api/model-card": return json(CARD);
      case "/api/predict": return json({ predicted_price: 21300, range_low: 19800, range_high: 22900, comparables: 12 });
      default: return route.fulfill({ status: 404, json: { error: "not mocked" } });
    }
  });
}

module.exports = { DEALS, mockApi };
