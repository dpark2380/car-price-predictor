// The main paths through the site, on desktop and phone (see playwright.config.js).
const { test, expect } = require("@playwright/test");
const { mockApi } = require("./fixtures");

test.beforeEach(async ({ page }) => mockApi(page));

const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("home shows the top deals with photos and links to the listings", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Search 3 used cars/);
  await expect(page.locator(".card-grid.four .card")).toHaveCount(2); // the car without a photo is left out
  expect(await noSideScroll(page)).toBe(true);
  await page.getByRole("button", { name: "Show 3 cars" }).click();
  await expect(page).toHaveURL(/\/listings$/);
});

test("a filter picked from the dropdown narrows the results and the URL", async ({ page }) => {
  await page.goto("/listings");
  await expect(page.getByRole("status")).toHaveText("3 results");
  await page.getByRole("button", { name: "Make All makes" }).click();
  await page.getByRole("option", { name: "Toyota" }).click();
  await page.getByRole("button", { name: "Show 2 cars" }).click(); // the count follows the pending filters; the list changes on Show
  await expect(page.getByRole("status")).toHaveText("2 results");
  await expect(page).toHaveURL(/make=toyota/);
  expect(await noSideScroll(page)).toBe(true);
});

test("the sort dropdown works from the keyboard", async ({ page }) => {
  await page.goto("/listings");
  const sort = page.getByRole("button", { name: /^Sort by/ });
  await sort.focus();
  await page.keyboard.press("ArrowDown"); // opens the menu
  await expect(page.getByRole("listbox", { name: "Sort by" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter"); // fourth option: Price (after Featured, Deal score, Below market)
  await expect(sort).toHaveText("Price");
  await expect(sort).toBeFocused();
  await expect(page).toHaveURL(/sort=price/);
});

test("a listing opens from its card and shows the spec sheet", async ({ page }) => {
  await page.goto("/listings");
  await page.getByRole("link", { name: "2020 Honda Accord" }).click();
  await expect(page).toHaveURL(/\/listings\/a1$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2020 Honda Accord");
  await expect(page.getByText("$4,000 below market")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Specifications" })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
});

test("the listing gallery steps through its photos", async ({ page }) => {
  await page.goto("/listings/a1");
  await expect(page.locator(".gallery-count")).toHaveText("1 / 3");
  await page.getByRole("button", { name: "Next photo" }).click();
  await expect(page.locator(".gallery-count")).toHaveText("2 / 3");
  await page.getByRole("button", { name: "Previous photo" }).click();
  await page.getByRole("button", { name: "Previous photo" }).click(); // wraps to the last
  await expect(page.locator(".gallery-count")).toHaveText("3 / 3");
  await page.getByRole("button", { name: "Photo 1" }).click();
  await expect(page.getByRole("img", { name: /photo 1 of 3/ })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
});

test("price check shows an estimate and its range", async ({ page }) => {
  await page.goto("/price-check");
  await page.getByRole("button", { name: /^Make/ }).click();
  await page.getByRole("option", { name: "Honda" }).click();
  await page.getByRole("button", { name: /^Model/ }).click();
  await page.getByRole("option", { name: "Accord" }).click();
  await page.getByLabel("Year").fill("2020");
  await page.getByLabel("Mileage").fill("40000");
  await page.getByRole("button", { name: "Check price" }).click();
  await expect(page.locator(".pc-result .value")).toHaveText("$21,300");
  await expect(page.getByText("$19,800")).toBeVisible();
  await page.getByLabel("Year").fill("1850");
  await expect(page.getByText("Press Check price to update.")).toBeVisible();
  await expect(page.locator("#pc-result-title")).toContainText("2020 Honda Accord"); // the heading keeps the inputs the result is for
  expect(await noSideScroll(page)).toBe(true);
});

test("a home chip keeps the dropdown choices and the method link is in the nav", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Make/ }).click();
  await page.getByRole("option", { name: "Toyota" }).click();
  await page.getByRole("button", { name: "Under $15,000" }).click();
  await expect(page).toHaveURL(/make=toyota/);
  await expect(page).toHaveURL(/price_to=15000/);
  await page.goto("/market/method");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Method" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Market" })).not.toHaveAttribute("aria-current", "page");
});

test("the theme toggle switches to dark and survives a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Use light theme" })).toBeVisible();
});

test("cars without a photo get a short band, and the photo filter hides them", async ({ page }) => {
  await page.goto("/listings");
  const noPhoto = page.locator(".card").filter({ hasText: "2018 Toyota Corolla" });
  await expect(noPhoto.getByText("No photo available")).toBeVisible();
  const box = await noPhoto.locator(".card-photo").boundingBox();
  expect(box.height / box.width).toBeLessThan(0.45); // 16:6, not the 16:10 photo box
  await page.getByRole("button", { name: /^More filters/ }).click();
  await page.getByLabel("Only cars with a photo").check();
  await page.getByRole("button", { name: "Show 2 cars" }).click();
  await expect(page.getByRole("status")).toHaveText("2 results");
  await expect(page).toHaveURL(/photo=1/);
});

test("More filters is closed at first; a colour filter shows as a chip and narrows the list", async ({ page }) => {
  await page.goto("/listings");
  const more = page.getByRole("button", { name: /^More filters/ });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Black" })).toHaveCount(0);
  await more.click();
  await page.getByRole("button", { name: "Black" }).click();
  await page.getByRole("button", { name: "Show 1 car" }).click();
  await expect(page.getByRole("status")).toHaveText("1 results");
  await expect(page.getByRole("button", { name: "Remove filter: Colour: Black" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^More filters · 1/ })).toBeVisible();
  await expect(page).toHaveURL(/color=black/);
});

test("a shared price-check link shows its car and progress while data loads", async ({ page }) => {
  // Hold the full listings list so the dropdown options aren't there yet.
  await page.route("http://localhost:5001/api/deals?min_score=0", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fallback();
  });
  await page.goto("/price-check?make=honda&model=accord&year=2020&mileage=40000");
  // Before the listings arrive (1.5 s), the dropdowns already show the car from the link.
  await expect(page.getByRole("button", { name: /^Make/ })).toHaveText("Honda", { timeout: 1000 });
  await expect(page.getByRole("button", { name: /^Model/ })).toHaveText("Accord", { timeout: 1000 });
  await expect(page.locator(".pc-result .value")).toHaveText("$21,300");
});

test("the Market brand index links to a brand and a model, and the nav marks Market", async ({ page }) => {
  await page.goto("/market");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Brands");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Market" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Toyota" }).click();
  await expect(page).toHaveURL(/\/market\/Toyota$/);
  await page.getByRole("link", { name: "Camry" }).click();
  await expect(page).toHaveURL(/\/market\/Toyota\/Camry$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Toyota Camry");
  expect(await noSideScroll(page)).toBe(true);
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Toyota");
});

test("a model page loads on direct visit and a chart's figures open as a table", async ({ page }) => {
  await page.goto("/market/Toyota/Camry");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Toyota Camry");
  await expect(page.getByRole("img", { name: /^Histogram of Camry/ })).toBeVisible();
  const first = page.locator("details.tbl summary").first();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("details.tbl[open] table").first()).toBeVisible();
});

test("the car page shows its price points, and the load-full-history control reports an unavailable lookup", async ({ page }) => {
  await page.route("http://localhost:5001/api/history**", (r) => r.fulfill({ json: { available: false } }));
  await page.goto("/car/4T1B11HK5KU123456");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("2019 Toyota Camry SE");
  await expect(page.getByRole("img", { name: /^Step chart of asking price/ })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Load full history" }).click();
  await expect(page.getByRole("alert")).toContainText("Full history isn't available today");
  expect(await noSideScroll(page)).toBe(true);
});

test("the method page reads the model card, and a listing links to the Market pages", async ({ page }) => {
  await page.goto("/market/method");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("How the estimate works");
  await expect(page.getByText("Grades across 100 active listings")).toBeVisible();
  await page.goto("/listings/b2");
  await expect(page.getByRole("link", { name: "Price history" })).toHaveAttribute("href", "/car/4T1B11HK5KU123456");
  await expect(page.getByRole("link", { name: "All Toyota Camrys" })).toHaveAttribute("href", "/market/Toyota/Camry");
  await page.getByRole("link", { name: "How accurate is this?" }).click();
  await expect(page).toHaveURL(/\/market\/method$/);
});
