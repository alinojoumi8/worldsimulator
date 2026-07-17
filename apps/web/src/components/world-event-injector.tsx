import { useState, type FormEvent } from "react";
import {
  PRODUCT_SKUS,
  type InjectWorldEventRequest,
  type InjectWorldEventResponse,
  type ProductSku,
  type WorldEventType,
} from "@worldtangle/shared";
import { AlertTriangle, Zap } from "lucide-react";

interface WorldEventInjectorProps {
  readonly runId?: string;
  readonly runStatus?: string;
  readonly pending: boolean;
  readonly failure?: string;
  readonly receipt?: InjectWorldEventResponse;
  readonly onInject: (request: InjectWorldEventRequest) => void;
}

export function WorldEventInjector({
  runId,
  runStatus,
  pending,
  failure,
  receipt,
  onInject,
}: WorldEventInjectorProps) {
  const [type, setType] = useState<WorldEventType>("energy.fuel_price_shock");
  const [sku, setSku] = useState<ProductSku>(PRODUCT_SKUS[0]);
  const [deltaPct, setDeltaPct] = useState("30");
  const [durationTicks, setDurationTicks] = useState("30");
  const [companyId, setCompanyId] = useState("cmp_00000001");
  const [capacityReductionPct, setCapacityReductionPct] = useState("50");
  const canInject = runId !== undefined && runStatus === "paused";

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const common = runId === undefined ? {} : { runId };
    switch (type) {
      case "energy.fuel_price_shock":
        onInject({ ...common, type, params: { deltaPct: Number(deltaPct) } });
        return;
      case "row.reference_price_shift":
        onInject({ ...common, type, params: { sku, deltaPct: Number(deltaPct) } });
        return;
      case "market.demand_shock":
        onInject({
          ...common,
          type,
          params: { sku, deltaPct: Number(deltaPct), durationTicks: Number(durationTicks) },
        });
        return;
      case "business.disaster":
        onInject({
          ...common,
          type,
          params: {
            companyId,
            capacityReductionPct: Number(capacityReductionPct),
            durationTicks: Number(durationTicks),
          },
        });
    }
  };

  return (
    <section className="world-event-injector" aria-labelledby="world-event-heading">
      <div className="world-event-injector__heading">
        <div>
          <p className="eyebrow"><Zap size={15} /> Bounded intervention</p>
          <h2 id="world-event-heading">Inject a world event</h2>
        </div>
        <span className="scenario-chip">Approved catalog only</span>
      </div>
      <p>
        Schedule a validated shock at the next tick boundary. The command, effect, and every
        downstream change remain in the causal ledger.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="world-event-type">World event</label>
        <select
          id="world-event-type"
          value={type}
          onChange={(event) => setType(event.target.value as WorldEventType)}
        >
          <option value="energy.fuel_price_shock">Energy · fuel price shock</option>
          <option value="row.reference_price_shift">Rest of world · reference price</option>
          <option value="market.demand_shock">Market · demand shock</option>
          <option value="business.disaster">Business · capacity disaster</option>
        </select>

        {type === "business.disaster" ? (
          <label>
            Company ID
            <input
              value={companyId}
              pattern="cmp_[0-9a-z]{8}"
              required
              onChange={(event) => setCompanyId(event.target.value)}
            />
          </label>
        ) : type === "energy.fuel_price_shock" ? null : (
          <label>
            Product
            <select value={sku} onChange={(event) => setSku(event.target.value as ProductSku)}>
              {PRODUCT_SKUS.map((product) => (
                <option value={product} key={product}>{product.replaceAll("_", " ")}</option>
              ))}
            </select>
          </label>
        )}

        {type === "business.disaster" ? (
          <label>
            Capacity reduction (%)
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              required
              value={capacityReductionPct}
              onChange={(event) => setCapacityReductionPct(event.target.value)}
            />
          </label>
        ) : (
          <label>
            {type === "energy.fuel_price_shock" ? "Fuel price change (%)" : "Change (%)"}
            <input
              type="number"
              min={type === "energy.fuel_price_shock" ? -99 : -90}
              max={type === "energy.fuel_price_shock" ? 1_000 : 500}
              step="1"
              required
              value={deltaPct}
              onChange={(event) => setDeltaPct(event.target.value)}
            />
          </label>
        )}

        {type === "market.demand_shock" || type === "business.disaster" ? (
          <label>
            Duration (ticks)
            <input
              type="number"
              min="1"
              max="360"
              step="1"
              required
              value={durationTicks}
              onChange={(event) => setDurationTicks(event.target.value)}
            />
          </label>
        ) : null}

        <button className="button button--secondary" type="submit" disabled={!canInject || pending}>
          <Zap size={16} /> {pending ? "Scheduling…" : "Schedule event"}
        </button>
      </form>
      <p className="world-event-injector__boundary" role="note">
        {canInject
          ? "Ready: the event will apply at the next committed tick boundary."
          : "Pause the run before scheduling an intervention."}
      </p>
      {failure === undefined ? null : (
        <p className="world-event-injector__failure" role="alert">
          <AlertTriangle size={16} /> {failure}
        </p>
      )}
      {receipt === undefined ? null : (
        <p className="world-event-injector__receipt" role="status">
          <Zap size={16} /> {receipt.worldEvent.type} scheduled for tick {receipt.worldEvent.scheduledTick}.
        </p>
      )}
    </section>
  );
}
