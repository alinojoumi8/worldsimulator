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

export function sparklinePoints(points: IndicatorSeries["points"]): string {
  if (points.length === 0) return "";
  const ordered = [...points].sort((left, right) => left[0] - right[0]);
  const ticks = ordered.map(([tick]) => tick);
  const values = ordered.map(([, value]) => integer(value));
  const minTick = Math.min(...ticks);
  const maxTick = Math.max(...ticks);
  const minValue = values.reduce((minimum, value) => value < minimum ? value : minimum);
  const maxValue = values.reduce((maximum, value) => value > maximum ? value : maximum);
  const tickRange = Math.max(1, maxTick - minTick);
  const valueRange = maxValue - minValue;
  const drawableWidth = WIDTH - (PADDING * 2);
  const drawableHeight = HEIGHT - (PADDING * 2);

  return ordered.map(([tick], index) => {
    const x = PADDING + (((tick - minTick) / tickRange) * drawableWidth);
    const value = values[index] ?? minValue;
    const ratio = valueRange === 0n
      ? 0.5
      : Number(((value - minValue) * 1_000_000n) / valueRange) / 1_000_000;
    const y = PADDING + ((1 - ratio) * drawableHeight);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

export function IndicatorSparkline({
  series,
  label,
  description,
  tone,
}: IndicatorSparklineProps) {
  const ordered = [...series.points].sort((left, right) => left[0] - right[0]);
  const latest = ordered.at(-1);
  const firstTick = ordered[0]?.[0] ?? 0;
  const latestTick = latest?.[0] ?? firstTick;
  const geometry = sparklinePoints(ordered);
  const [latestX, latestY] = geometry.split(" ").at(-1)?.split(",") ?? [];

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
            <line x1={PADDING} y1={HEIGHT / 2} x2={WIDTH - PADDING} y2={HEIGHT / 2} />
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
        </>
      )}
    </article>
  );
}
