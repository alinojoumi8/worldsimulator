import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { WorldTangleApi } from "./lib/api-client";
import { readApiToken, writeApiToken } from "./lib/token";

interface AppSession {
  readonly api: WorldTangleApi;
  readonly token: string;
  readonly setToken: (token: string) => void;
}

const AppSessionContext = createContext<AppSession | undefined>(undefined);

export function AppSessionProvider({ children }: { readonly children: ReactNode }) {
  const [token, setTokenState] = useState(readApiToken);
  const value = useMemo<AppSession>(
    () => ({
      api: new WorldTangleApi(token),
      token,
      setToken: (nextToken) => {
        const normalized = nextToken.trim();
        writeApiToken(normalized);
        setTokenState(normalized);
      },
    }),
    [token],
  );
  return <AppSessionContext.Provider value={value}>{children}</AppSessionContext.Provider>;
}

export function useAppSession(): AppSession {
  const session = useContext(AppSessionContext);
  if (session === undefined) throw new Error("useAppSession must be used inside AppSessionProvider");
  return session;
}
