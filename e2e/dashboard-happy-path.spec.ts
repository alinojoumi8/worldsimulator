import { expect, test } from "@playwright/test";

test("creates Riverbend and traces a shock from citizens and credit into CPI", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Guided causal test" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Simulation disclaimer" }))
    .toContainText("Simulated scenario");

  await page.getByLabel("Simulation name").fill("Guided WS-708 causal acceptance");
  await page.getByText("Advanced reproducibility and budget").click();
  await page.getByLabel("Seed").fill("42");
  await page.getByLabel("End tick").fill("31");
  await expect(page.getByLabel("Decision mode")).toHaveValue("mock");
  await page.getByRole("button", { name: "Start guided causal test" }).click();

  await expect(page).toHaveURL(/\/simulations\/sim_[0-9a-z]{8}\?guided=causal-shock-v1$/);
  await expect(page.getByRole("heading", { name: "Guided WS-708 causal acceptance" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Simulation progress" }))
    .toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByRole("link", { name: "Schedule the 30% fuel shock" })).toBeVisible();

  const injector = page.getByRole("region", { name: /Schedule the fuel-price shock/ });
  await expect(injector.getByLabel("World event")).toBeDisabled();
  await expect(injector.getByLabel("Fuel price change (%)")).toHaveValue("30");
  await expect(injector.getByLabel("Fuel price change (%)")).toHaveAttribute("readonly");
  await injector.getByRole("button", { name: "Schedule event" }).click();
  await expect(injector.getByRole("status"))
    .toContainText("energy.fuel_price_shock scheduled for tick");
  await page.reload();
  await expect(page.getByText("Intervention booked")).toBeVisible();
  await expect(page.getByRole("link", { name: "Start the deterministic run" })).toBeVisible();

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

  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("End tick reached")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("progressbar", { name: "Simulation progress" }))
    .toHaveAttribute("aria-valuenow", "31");

  const cpiCard = page.locator(".sparkline-card").filter({ hasText: "Consumer price index" });
  await expect(cpiCard.getByRole("img", {
    name: "Consumer price index from tick 0 through tick 31",
  })).toBeVisible();
  await expect(cpiCard.locator(".sparkline-card__heading > strong")).toHaveText(/^\d+$/);
  await expect(page.getByText("CPI observation booked")).toBeVisible();
  await page.getByRole("button", { name: "Copy reproducibility receipt" }).click();
  await expect(page.getByRole("status")).toContainText("Receipt copied.");
  await page.getByRole("link", { name: "Open the causal record" }).click();
  await expect(page).toHaveURL(/\/explorer\?correlation=world-event%3Awev_/);
  const evidencePath = page.getByRole("region", { name: "Selected record evidence" });
  await expect(evidencePath).toBeVisible();
  await expect(evidencePath.getByRole("heading", { name: "Origin event" })).toBeVisible();
  await expect(evidencePath.getByRole("heading", { name: "Booked state" })).toBeVisible();
  await expect(evidencePath.getByRole("heading", { name: "Downstream effect" })).toBeVisible();
  await expect(evidencePath).toContainText("A shared correlation is not treated as proof");
});

test("opens a negotiated investment close through exact cap-table evidence", async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Set up a custom simulation" }).click();
  await expect(page.getByRole("heading", { name: "Create a simulation" })).toBeVisible();
  await page.getByLabel("Simulation name").fill("WS-805 investment acceptance");
  await expect(page.getByLabel("Decision mode")).toHaveValue("mock");
  await page.getByRole("button", { name: "Create Riverbend run" }).click();

  await expect(page).toHaveURL(/\/simulations\/sim_[0-9a-z]{8}$/);
  const simulationId = new URL(page.url()).pathname.split("/").at(-1)!;
  await page.getByRole("button", { name: "Start run" }).click();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

  const statusResponse = await page.request.get(
    `/api/v1/simulations/${simulationId}/status`,
  );
  expect(statusResponse.ok()).toBe(true);
  const status = await statusResponse.json() as {
    readonly run: {
      readonly id: string;
      readonly currentTick: number;
      readonly endTick: number;
    };
  };
  let currentTick = status.run.currentTick;
  while (currentTick < status.run.endTick) {
    const ticks = Math.min(50, status.run.endTick - currentTick);
    const response = await page.request.post(
      `/api/v1/simulations/${simulationId}/advance`,
      {
        data: { runId: status.run.id, ticks },
        timeout: 60_000,
      },
    );
    expect(response.ok()).toBe(true);
    const advanced = await response.json() as {
      readonly run: { readonly currentTick: number };
    };
    currentTick = advanced.run.currentTick;
  }
  await expect(page.getByText("End tick reached")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Explore Riverbend" }).click();
  await page.getByRole("link", { name: "Investments", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Investment evidence" })).toBeVisible();
  const completedProposal = page.locator(".investment-record-card")
    .filter({ hasText: "completed" })
    .first();
  await expect(completedProposal).toBeVisible();
  await completedProposal.click();
  await expect(page.getByRole("link", { name: "Open booked investment" })).toBeVisible();
  await page.getByRole("link", { name: "Open booked investment" }).click();
  await expect(page.getByRole("heading", { name: "Before close" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "After close" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Proposal terms" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Close-to-ledger evidence" })).toBeVisible();
  await page.getByRole("link", { name: "Current cap table" }).click();
  await expect(page.getByRole("heading", { name: "Current ownership" })).toBeVisible();
});
