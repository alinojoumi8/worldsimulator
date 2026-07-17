import { expect, test } from "@playwright/test";

test("creates Riverbend and traces a shock from citizens and credit into CPI", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create a simulation" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Simulation disclaimer" }))
    .toContainText("Simulated scenario");

  await page.getByLabel("Simulation name").fill("WS-708 causal acceptance");
  await page.getByLabel("Seed").fill("42");
  await page.getByLabel("End tick").fill("31");
  await page.getByRole("button", { name: "Create Riverbend run" }).click();

  await expect(page).toHaveURL(/\/simulations\/sim_[0-9a-z]{8}$/);
  await expect(page.getByRole("heading", { name: "WS-708 causal acceptance" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Simulation progress" }))
    .toHaveAttribute("aria-valuenow", "0");

  await page.getByRole("button", { name: "Start run" }).click();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

  await page.getByRole("link", { name: "Explore Riverbend" }).click();
  await page.getByRole("link", { name: "Citizens", exact: true }).click();
  const firstCitizen = page.locator(".explorer-list--agents .explorer-list-row").first();
  await expect(firstCitizen).toBeVisible();
  await firstCitizen.click();
  await expect(page.getByRole("heading", { name: "Citizen record", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Employment & finances" })).toBeVisible();

  await page.getByRole("link", { name: "Credit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Loan book" })).toBeVisible();
  const firstLoan = page.locator("table.credit-loan-table tbody a").first();
  await expect(firstLoan).toBeVisible();
  await firstLoan.click();
  await expect(page.getByRole("heading", { name: "Loan record", level: 1 })).toBeVisible();
  const whyPanel = page.getByRole("region", { name: "Loan why-panel" });
  await expect(whyPanel).toBeVisible();
  await expect(whyPanel.getByRole("heading", { name: /why-panel/ })).toBeVisible();
  await expect(whyPanel.getByRole("heading", { name: "Evidence" })).toBeVisible();

  await page.getByRole("link", { name: "Run cockpit" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  const injector = page.getByRole("region", { name: "Inject a world event" });
  await injector.getByLabel("World event").selectOption("energy.fuel_price_shock");
  await injector.getByLabel("Fuel price change (%)").fill("30");
  await injector.getByRole("button", { name: "Schedule event" }).click();
  await expect(injector.getByRole("status"))
    .toContainText("energy.fuel_price_shock scheduled for tick");

  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("End tick reached")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("progressbar", { name: "Simulation progress" }))
    .toHaveAttribute("aria-valuenow", "31");

  const cpiCard = page.locator(".sparkline-card").filter({ hasText: "Consumer price index" });
  await expect(cpiCard.getByRole("img", {
    name: "Consumer price index from tick 0 through tick 31",
  })).toBeVisible();
  await expect(cpiCard.locator(".sparkline-card__heading > strong")).toHaveText(/^\d+$/);
});
