import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  CalendarDays,
  CircleDotDashed,
  GitBranch,
  Network,
  Play,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { CreateSimulationRequest } from "@worldtangle/shared";
import { useAppSession } from "../app-session";
import { ErrorNotice, LoadingPanel, StatusPill } from "../components/ui";
import { errorMessage } from "../lib/api-client";

interface CreateFormState {
  name: string;
  seed: string;
  endTick: string;
  llmMode: "live" | "mock";
  runCostCentsMax: string;
  perAgentDailyTokens: string;
}

const CREATE_DEFAULTS: CreateFormState = {
  name: "Riverbend baseline",
  seed: "42",
  endTick: "360",
  llmMode: "live",
  runCostCentsMax: "500",
  perAgentDailyTokens: "128000",
};

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function LibraryPage() {
  const { api, token } = useAppSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateFormState>(CREATE_DEFAULTS);

  const simulations = useQuery({
    queryKey: ["simulations", token],
    queryFn: ({ signal }) => api.listSimulations(signal),
  });
  const createSimulation = useMutation({
    mutationFn: (request: CreateSimulationRequest) => api.createSimulation(request),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["simulations"] });
      navigate(`/simulations/${created.simulation.id}`);
    },
  });

  const update = (field: keyof CreateFormState, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const request: CreateSimulationRequest = {
      name: form.name.trim(),
      scenario: {
        worldSpec: "riverbend-100@1",
        seed: Number(form.seed),
        llmMode: form.llmMode,
        budgets: {
          runCostCentsMax: form.runCostCentsMax,
          perAgentDailyTokens: Number(form.perAgentDailyTokens),
        },
        policyOverrides: { income_tax_rate_bp: 1_800 },
        endTick: Number(form.endTick),
      },
    };
    createSimulation.mutate(request);
  };

  return (
    <div className="library-page">
      <section className="library-hero" aria-labelledby="library-title">
        <div className="library-hero__image" aria-hidden="true">
          <picture>
            <source srcSet="/brand/riverbend-systems-1440.avif" type="image/avif" />
            <img
              src="/brand/riverbend-systems-1440.webp"
              alt=""
              onError={(event) => { event.currentTarget.hidden = true; }}
            />
          </picture>
        </div>
        <div className="library-hero__copy">
          <p className="eyebrow"><Network size={16} /> Civic systems workbench</p>
          <h1 id="library-title">See how one choice <em>tangles through a world.</em></h1>
          <p className="hero-lede">
            Run deterministic scenarios, follow every causal thread, and inspect the durable
            event record behind each change.
          </p>
          <div className="hero-principles" aria-label="WorldTangle principles">
            <span><CircleDotDashed size={16} /> Reproducible</span>
            <span><GitBranch size={16} /> Causal</span>
            <span><CalendarDays size={16} /> Time-aware</span>
          </div>
        </div>
        <form className="create-card" onSubmit={submit} aria-labelledby="create-heading">
          <div className="create-card__heading">
            <div>
              <p className="eyebrow">New weave</p>
              <h2 id="create-heading">Create a simulation</h2>
            </div>
            <span className="scenario-chip">Riverbend · 100 agents</span>
          </div>
          <label htmlFor="simulation-name">Simulation name</label>
          <input
            id="simulation-name"
            value={form.name}
            maxLength={120}
            required
            onChange={(event) => update("name", event.target.value)}
          />
          <div className="form-grid">
            <div>
              <label htmlFor="simulation-seed">Seed</label>
              <input
                id="simulation-seed"
                type="number"
                step="1"
                required
                value={form.seed}
                onChange={(event) => update("seed", event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="simulation-ticks">End tick</label>
              <input
                id="simulation-ticks"
                type="number"
                min="1"
                step="1"
                required
                value={form.endTick}
                onChange={(event) => update("endTick", event.target.value)}
              />
            </div>
          </div>
          <div className="llm-mode-field">
            <label htmlFor="simulation-llm-mode">LLM mode</label>
            <select
              id="simulation-llm-mode"
              value={form.llmMode}
              onChange={(event) => update("llmMode", event.target.value)}
            >
              <option value="live">Live · MiniMax M3</option>
              <option value="mock">Mock · deterministic</option>
            </select>
            <p>
              {form.llmMode === "live"
                ? "Tier-2 decisions call MiniMax M3 and count against the run budget."
                : "Deterministic responses make the run fully offline and repeatable."}
            </p>
          </div>
          <details className="budget-details">
            <summary>Budget guardrails</summary>
            <div className="form-grid">
              <div>
                <label htmlFor="run-budget">Run budget · cents</label>
                <input
                  id="run-budget"
                  inputMode="numeric"
                  pattern="[1-9][0-9]*"
                  required
                  value={form.runCostCentsMax}
                  onChange={(event) => update("runCostCentsMax", event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="token-budget">Agent tokens · daily</label>
                <input
                  id="token-budget"
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={form.perAgentDailyTokens}
                  onChange={(event) => update("perAgentDailyTokens", event.target.value)}
                />
              </div>
            </div>
          </details>
          {createSimulation.error === null ? null : (
            <ErrorNotice title="Could not create this simulation" message={errorMessage(createSimulation.error)} />
          )}
          <button className="button button--primary button--large" type="submit" disabled={createSimulation.isPending}>
            <Play size={18} fill="currentColor" />
            {createSimulation.isPending ? "Creating Riverbend…" : "Create Riverbend run"}
          </button>
          <p className="form-footnote">
            {form.llmMode === "live" ? "MiniMax M3 live" : "Mock LLM"}
            {" · income tax baseline 18% · 360-day calendar"}
          </p>
        </form>
      </section>

      <section className="simulation-library" aria-labelledby="simulations-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Your workbench</p>
            <h2 id="simulations-heading">Simulation library</h2>
          </div>
          {simulations.data === undefined ? null : (
            <p>{simulations.data.items.length} {simulations.data.items.length === 1 ? "world" : "worlds"}</p>
          )}
        </div>
        {simulations.isPending ? <LoadingPanel label="Opening the simulation ledger…" /> : null}
        {simulations.error === null ? null : (
          <ErrorNotice
            message={errorMessage(simulations.error)}
            onRetry={() => { void simulations.refetch(); }}
          />
        )}
        {simulations.data?.items.length === 0 ? (
          <div className="empty-library">
            <GitBranch size={28} />
            <div>
              <strong>No worlds on the ledger yet.</strong>
              <p>Create Riverbend above; its seed and manifest will make the run reproducible.</p>
            </div>
          </div>
        ) : null}
        <div className="simulation-grid">
          {simulations.data?.items.map((simulation) => (
            <Link className="simulation-card" to={`/simulations/${simulation.id}`} key={simulation.id}>
              <div className="simulation-card__art" aria-hidden="true">
                <img
                  src="/brand/scenario-riverbend-960.webp"
                  alt=""
                  onError={(event) => { event.currentTarget.hidden = true; }}
                />
              </div>
              <div className="simulation-card__body">
                <div className="simulation-card__topline">
                  <StatusPill status={simulation.latestRun.status} />
                  <ArrowUpRight size={18} />
                </div>
                <h3>{simulation.name}</h3>
                <p className="simulation-card__id">{simulation.id}</p>
                <div className="simulation-card__meta">
                  <span>Tick <strong>{simulation.latestRun.currentTick}</strong></span>
                  <span>{formatCreatedAt(simulation.createdAt)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
