// Fixed API responses, so the tests don't depend on the live database.
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const deal = (id, over) => ({
  listing_id: id, url: `https://dealer.example/${id}`, photo_url: null,
  trim: "SE", body_type: "Sedan", mileage: 40000, location_city: "Denver", location_state: "CO",
  days_listed: 20, last_seen: day(0), first_seen: day(20), price_change_percent: null,
  dealer_name: "Test Motors", ...over,
});

const DEALS = [
  deal("a1", { year: 2020, make: "Honda", model: "Accord", price: 18000, predicted_price: 22000, savings: 4000, deal_score: 95, photo_url: "https://img.example/a1.jpg" }),
  deal("b2", { year: 2019, make: "Toyota", model: "Camry", price: 21000, predicted_price: 21500, savings: 500, deal_score: 55, photo_url: "https://img.example/b2.jpg" }),
  deal("c3", { year: 2018, make: "Toyota", model: "Corolla", price: 16000, predicted_price: 14000, savings: -2000, deal_score: 20, body_type: "Hatchback" }),
];

// A 1x1 PNG for every listing photo.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function mockApi(page) {
  await page.route("https://img.example/**", (r) => r.fulfill({ contentType: "image/png", body: PNG }));
  await page.route("http://localhost:5001/api/**", (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ json: body });
    switch (url.pathname) {
      case "/api/deals": return json(DEALS.slice(0, Number(url.searchParams.get("limit")) || DEALS.length));
      case "/api/stats": return json({ graded_listings: DEALS.length, last_updated: new Date().toISOString() });
      case "/api/specs": return json([{ group: "Engine", rows: [["Power", "192 hp"]] }]);
      case "/api/predict": return json({ predicted_price: 21300, range_low: 19800, range_high: 22900, comparables: 12 });
      default: return route.fulfill({ status: 404, json: { error: "not mocked" } });
    }
  });
}

module.exports = { DEALS, mockApi };
