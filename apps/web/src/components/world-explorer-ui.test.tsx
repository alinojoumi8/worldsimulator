// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentFinancesResponse, CompanyDetailResponse } from "@worldtangle/shared";
import {
  AgentFinancePanel,
  CompanyTimeline,
  formatCents,
  WorldExplorerHeader,
} from "./world-explorer-ui";

describe("WS-409 world explorer components", () => {
  it("formats integer cents without locale-dependent behavior", () => {
    expect(formatCents("1234567")).toBe("$12,345.67");
    expect(formatCents("-25")).toBe("−$0.25");
  });

  it("renders causal event evidence and explorer navigation", () => {
    const timeline: CompanyDetailResponse["timeline"] = [{
      id: "production:prod_00000001",
      tick: 7,
      type: "production.started",
      sourceEventId: "evt_00000001",
      referenceId: "prod_00000001",
      details: { unitsProduced: 10 },
    }];
    render(
      <MemoryRouter initialEntries={["/simulations/sim_00000001/world/companies"]}>
        <WorldExplorerHeader simulationId="sim_00000001" />
        <CompanyTimeline timeline={timeline} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("navigation", { name: "World explorer" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Companies" }).getAttribute("href"))
      .toBe("/simulations/sim_00000001/world/companies");
    expect(screen.getByText("production.started")).toBeTruthy();
    expect(screen.getByText("evt_00000001")).toBeTruthy();
  });

  it("renders current employment, balances, income, and expenses", () => {
    const finances: AgentFinancesResponse = {
      employment: {
        contractId: "emp_00000001",
        employer: { id: "co_00000001", name: "Riverbend Pantry" },
        title: "Pantry worker",
        wage: "4000000",
        since: "Y0001-M01-D07",
      },
      accounts: [{
        id: "acct_00000001",
        bank: "First Ledger Bank",
        type: "checking",
        balance: "12345",
      }],
      income: { last30Ticks: { salary: "150000", benefits: "0", other: "0" } },
      expenses: {
        last30Ticks: {
          subsistence: "50000",
          discretionary: "1000",
          rent: "30000",
          utilities: "10000",
        },
      },
      loans: [],
      meta: { simulated: true, apiVersion: 1 },
    };
    render(<AgentFinancePanel finances={finances} />);
    expect(screen.getByText("Riverbend Pantry")).toBeTruthy();
    expect(screen.getByText("$40,000.00")).toBeTruthy();
    expect(screen.getByText("$123.45")).toBeTruthy();
    expect(screen.getByText("$1,500.00")).toBeTruthy();
  });
});
