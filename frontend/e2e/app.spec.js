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
  if (await page.getByRole("button", { name: /^Filters/ }).isVisible()) {
    await page.getByRole("button", { name: /^Filters/ }).click(); // phone: filters start closed
  }
  await page.getByRole("button", { name: "Make All makes" }).click();
  await page.getByRole("option", { name: "Toyota" }).click();
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
  await page.keyboard.press("Enter"); // third option: Price
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
  expect(await noSideScroll(page)).toBe(true);
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
