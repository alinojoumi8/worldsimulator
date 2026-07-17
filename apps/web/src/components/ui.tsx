import type { ReactNode } from "react";
import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";

export function StatusPill({ status }: { readonly status: string }) {
  return <span className={`status-pill status-pill--${status}`}>{status}</span>;
}

export function ErrorNotice({
  title = "That thread snagged",
  message,
  onRetry,
}: {
  readonly title?: string;
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="error-notice" role="alert">
      <AlertTriangle size={20} />
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {onRetry === undefined ? null : (
        <button className="button button--quiet" type="button" onClick={onRetry}>
          <RefreshCw size={16} /> Retry
        </button>
      )}
    </div>
  );
}

export function LoadingPanel({ label }: { readonly label: string }) {
  return (
    <div className="loading-panel" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon,
  accent,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly detail: string;
  readonly icon: ReactNode;
  readonly accent?: "teal" | "rust" | "blue" | "green";
}) {
  return (
    <article className={`metric-card${accent === undefined ? "" : ` metric-card--${accent}`}`}>
      <div className="metric-card__icon">{icon}</div>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}
