import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { AppSessionProvider } from "./app-session";
import { AppShell } from "./components/app-shell";
import { LibraryPage } from "./pages/library-page";
import { SimulationPage } from "./pages/simulation-page";
import { WorldExplorerPage } from "./pages/world-explorer-page";
import { ConversationDetailPage, ObservabilityPage } from "./pages/observability-page";
import { NewsExplorerPage } from "./pages/news-explorer-page";
import {
  InvestmentCapTablePage,
  InvestmentDetailPage,
  InvestmentDistributionDetailPage,
  InvestmentExplorerPage,
  InvestmentProposalDetailPage,
} from "./pages/investment-pages";
import {
  AgentDetailPage,
  BankDetailPage,
  CompanyDetailPage,
  ContractDetailPage,
  InstitutionDetailPage,
  JobDetailPage,
  LoanDetailPage,
} from "./pages/world-detail-pages";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1_000,
    },
    mutations: { retry: false },
  },
});

function NotFoundPage() {
  return (
    <div className="not-found-page">
      <p className="eyebrow">Loose thread · 404</p>
      <h1>This path is not part of the weave.</h1>
      <p>The simulation may have moved, or the address is incomplete.</p>
      <Link className="button button--primary" to="/"><ArrowLeft size={17} /> Return to simulations</Link>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppSessionProvider>
        <BrowserRouter>
          <AppShell>
            <Routes>
              <Route path="/" element={<LibraryPage />} />
              <Route path="/simulations/:simId" element={<SimulationPage />} />
              <Route path="/simulations/:simId/observability" element={<ObservabilityPage />} />
              <Route path="/simulations/:simId/explorer" element={<NewsExplorerPage />} />
              <Route path="/simulations/:simId/observability/conversations/:conversationId" element={<ConversationDetailPage />} />
              <Route path="/simulations/:simId/world" element={<Navigate to="companies" replace />} />
              <Route path="/simulations/:simId/world/companies" element={<WorldExplorerPage section="companies" />} />
              <Route path="/simulations/:simId/world/jobs" element={<WorldExplorerPage section="jobs" />} />
              <Route path="/simulations/:simId/world/contracts" element={<WorldExplorerPage section="contracts" />} />
              <Route path="/simulations/:simId/world/institutions" element={<WorldExplorerPage section="institutions" />} />
              <Route path="/simulations/:simId/world/investments" element={<InvestmentExplorerPage />} />
              <Route path="/simulations/:simId/world/market" element={<WorldExplorerPage section="market" />} />
              <Route path="/simulations/:simId/world/credit" element={<WorldExplorerPage section="credit" />} />
              <Route path="/simulations/:simId/world/agents" element={<WorldExplorerPage section="agents" />} />
              <Route path="/simulations/:simId/companies/:companyId" element={<CompanyDetailPage />} />
              <Route path="/simulations/:simId/companies/:companyId/cap-table" element={<InvestmentCapTablePage />} />
              <Route path="/simulations/:simId/investment-proposals/:proposalId" element={<InvestmentProposalDetailPage />} />
              <Route path="/simulations/:simId/investments/:investmentId" element={<InvestmentDetailPage />} />
              <Route path="/simulations/:simId/investment-distributions/:distributionId" element={<InvestmentDistributionDetailPage />} />
              <Route path="/simulations/:simId/contracts/:contractId" element={<ContractDetailPage />} />
              <Route path="/simulations/:simId/jobs/:jobId" element={<JobDetailPage />} />
              <Route path="/simulations/:simId/institutions/:institutionId" element={<InstitutionDetailPage />} />
              <Route path="/simulations/:simId/banks/:bankId" element={<BankDetailPage />} />
              <Route path="/simulations/:simId/loans/:loanId" element={<LoanDetailPage />} />
              <Route path="/simulations/:simId/agents/:agentId" element={<AgentDetailPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AppShell>
        </BrowserRouter>
      </AppSessionProvider>
    </QueryClientProvider>
  );
}
