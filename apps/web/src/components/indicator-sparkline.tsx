import type { IndicatorSeriesResponse } from "@worldtangle/shared";

type IndicatorSeries = IndicatorSeriesResponse["series"][number];

interface IndicatorSparklineProps {
  readonly series: IndicatorSeries;
  readonly label: string;
  readonly description: string;
  readonly tone: "teal" | "blue" | "rust" | "green";
}

const WIDTH = 320;
const HEIGHT = 112;
const PADDING = 8;

function integer(value: string | number): bigint {
  return BigInt(value);
}

export function formatIndicatorValue(
  value: string | number,
  unit: IndicatorSeries["unit"],
): string {
  if (unit === "bp") return `${(Number(value) / 100).toFixed(2)}%`;
  if (unit === "index" || unit === "count") return integer(value).toString();
  const cents = integer(value);
  const sign = cents < 0n ? "−" : "";
  const absolute = cents < 0n ? -cents : cents;
  const dollars = absolute / 100n;
  const remainder = String(absolute % 100n).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}

function sparklineScale(
  values: readonly bigint[],
  baseline: bigint,
): { readonly minimum: bigint; readonly maximum: bigint } {
  const observedMinimum = values.reduce(
    (minimum, value) => value < minimum ? value : minimum,
  );
  const observedMaximum = values.reduce(
    (maximum, value) => value > maximum ? value : maximum,
  );
  if (baseline === 0n && observedMinimum >= 0n) {
    return { minimum: 0n, maximum: observedMaximum === 0n ? 1n : observedMaximum };
  }
  const lowerDistance = baseline - observedMinimum;
  const upperDistance = observedMaximum - baseline;
  const extent = [lowerDistance, upperDistance, 1n].reduce(
    (maximum, value) => value > maximum ? value : maximum,
  );
  return { minimum: baseline - extent, maximum: baseline + extent };
}

function scaledY(value: bigint, minimum: bigint, maximum: bigint): number {
  const valueRange = maximum - minimum;
  const ratio = Number(((value - minimum) * 1_000_000n) / valueRange) / 1_000_000;
  return PADDING + ((1 - ratio) * (HEIGHT - (PADDING * 2)));
}

export function sparklinePoints(
  points: IndicatorSeries["points"],
  baseline: string | number = 0,
): string {
  if (points.length === 0) return "";
  const ordered = [...points].sort((left, right) => left[0] - right[0]);
  const ticks = ordered.map(([tick]) => tick);
  const values = ordered.map(([, value]) => integer(value));
  const minTick = Math.min(...ticks);
  const maxTick = Math.max(...ticks);
  const scale = sparklineScale(values, integer(baseline));
  const tickRange = Math.max(1, maxTick - minTick);
  const drawableWidth = WIDTH - (PADDING * 2);

  return ordered.map(([tick], index) => {
    const x = PADDING + (((tick - minTick) / tickRange) * drawableWidth);
    const value = values[index] ?? scale.minimum;
    const y = scaledY(value, scale.minimum, scale.maximum);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

export function sparklineBaselineY(
  points: IndicatorSeries["points"],
  baseline: string | number = 0,
): number {
  if (points.length === 0) return HEIGHT / 2;
  const values = points.map(([, value]) => integer(value));
  const baselineValue = integer(baseline);
  const scale = sparklineScale(values, baselineValue);
  return scaledY(baselineValue, scale.minimum, scale.maximum);
}

export function IndicatorSparkline({
  series,
  label,
  description,
  tone,
}: IndicatorSparklineProps) {
  const ordered = [...series.points].sort((left, right) => left[0] - right[0]);
  const latest = ordered.at(-1);
  const first = ordered[0];
  const firstTick = ordered[0]?.[0] ?? 0;
  const latestTick = latest?.[0] ?? firstTick;
  const baseline = series.unit === "index" ? 1_000 : 0;
  const geometry = sparklinePoints(ordered, baseline);
  const baselineY = sparklineBaselineY(ordered, baseline);
  const [latestX, latestY] = geometry.split(" ").at(-1)?.split(",") ?? [];
  let lastChangeTick: number | undefined;
  for (let index = 1; index < ordered.length; index += 1) {
    if (integer(ordered[index]?.[1] ?? 0) !== integer(ordered[index - 1]?.[1] ?? 0)) {
      lastChangeTick = ordered[index]?.[0];
    }
  }

  return (
    <article className={`sparkline-card sparkline-card--${tone}`}>
      <div className="sparkline-card__heading">
        <div>
          <h4>{label}</h4>
          <p>{description}</p>
        </div>
        <strong>{latest === undefined ? "—" : formatIndicatorValue(latest[1], series.unit)}</strong>
      </div>
      {ordered.length === 0 ? (
        <div className="sparkline-card__empty">No committed observations yet.</div>
      ) : (
        <>
          <svg
            className="sparkline"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label={`${label} from tick ${firstTick} through tick ${latestTick}`}
            preserveAspectRatio="none"
          >
            <line x1={PADDING} y1={baselineY} x2={WIDTH - PADDING} y2={baselineY} />
            <polyline points={geometry} />
            <circle
              cx={latestX}
              cy={latestY}
              r="4"
            />
          </svg>
          <div className="sparkline-card__range">
            <span>Tick {firstTick}</span>
            <span>Tick {latestTick}</span>
          </div>
          <div className="sparkline-card__context">
            <span>{first === undefined ? "" : `Started ${formatIndicatorValue(first[1], series.unit)}`}</span>
            <span>{lastChangeTick === undefined ? "No recorded change" : `Last change · tick ${lastChangeTick}`}</span>
          </div>
        </>
      )}
    </article>
  );
}
