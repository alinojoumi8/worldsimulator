import { useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound, ShieldCheck, X } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAppSession } from "../app-session";
import { BrandMark } from "./brand-mark";

export function AppShell({ children }: { readonly children: ReactNode }) {
  const { token, setToken } = useAppSession();
  const queryClient = useQueryClient();
  const [tokenPanelOpen, setTokenPanelOpen] = useState(false);
  const [draftToken, setDraftToken] = useState(token);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (tokenPanelOpen) inputRef.current?.focus();
  }, [tokenPanelOpen]);

  const saveToken = (): void => {
    setToken(draftToken);
    setTokenPanelOpen(false);
    void queryClient.invalidateQueries();
  };

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="simulation-notice" aria-label="Simulation disclaimer">
        <span>Simulated scenario</span>
        <p>Exploratory model output — not financial, legal, or political advice.</p>
      </aside>
      <header className="site-header">
        <Link className="wordmark" to="/" aria-label="WorldTangle home">
          <BrandMark compact />
          <span>WorldTangle</span>
        </Link>
        <nav className="primary-nav" aria-label="Primary navigation">
          <NavLink to="/" end>Simulations</NavLink>
        </nav>
        <button
          className="token-button"
          type="button"
          aria-expanded={tokenPanelOpen}
          aria-controls="token-panel"
          onClick={() => {
            setDraftToken(token);
            setTokenPanelOpen((open) => !open);
          }}
        >
          {token.length > 0 ? <ShieldCheck size={17} /> : <KeyRound size={17} />}
          <span>{token.length > 0 ? "API secured" : "API token"}</span>
        </button>
        {tokenPanelOpen ? (
          <section className="token-panel" id="token-panel" aria-label="API token settings">
            <div className="token-panel__heading">
              <div>
                <strong>API access</strong>
                <p>Kept only in this tab’s session storage.</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close API token settings"
                onClick={() => setTokenPanelOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <label htmlFor="api-token">Bearer token</label>
            <input
              id="api-token"
              ref={inputRef}
              type="password"
              value={draftToken}
              autoComplete="off"
              placeholder="Optional on loopback"
              onChange={(event) => setDraftToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveToken();
                if (event.key === "Escape") setTokenPanelOpen(false);
              }}
            />
            <div className="token-panel__actions">
              {token.length > 0 ? (
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => {
                    setDraftToken("");
                    setToken("");
                    setTokenPanelOpen(false);
                    void queryClient.invalidateQueries();
                  }}
                >
                  Clear token
                </button>
              ) : null}
              <button className="button button--primary" type="button" onClick={saveToken}>
                Save for session
              </button>
            </div>
          </section>
        ) : null}
      </header>
      <main id="main-content">{children}</main>
      <footer className="site-footer">
        <BrandMark compact />
        <p>WorldTangle · deterministic systems, inspectable causes.</p>
        <p className="site-footer__version">Preview · API v1</p>
      </footer>
    </div>
  );
}
