import React, { createContext, useContext, ReactNode, useState, useCallback, useMemo } from "react";

import { getAccessToken } from "../nori/auth/session";
import { getLocalToken, LOCAL_TOKEN_HEADER } from "../lib/localAuth";

interface ApiContextType {
  baseUrl: string;
  wsBaseUrl: string;
  fetchWithHeaders: (url: string, options?: RequestInit) => Promise<Response>;
}

const ApiContext = createContext<ApiContextType | undefined>(undefined);

const STORAGE_KEY = "lelab.apiBaseUrl";
const DEFAULT_LOCALHOST = "http://localhost:8000";

/** Overwrite the persisted API base URL (used by the bootstrap self-heal when
 *  the stored value points at a dead server — see NoriContext). */
export const persistApiBaseUrl = (url: string): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, url.replace(/\/$/, ""));
  } catch {
    /* storage unavailable — the ?api= param still works */
  }
};

const httpToWs = (url: string): string => url.replace(/^http(s?):/, "ws$1:");

const resolveInitialBaseUrl = (): string => {
  if (typeof window === "undefined") return DEFAULT_LOCALHOST;

  const fromQuery = new URLSearchParams(window.location.search).get("api");
  if (fromQuery) {
    try {
      new URL(fromQuery);
      const clean = fromQuery.replace(/\/$/, "");
      window.localStorage.setItem(STORAGE_KEY, clean);
      return clean;
    } catch {
      console.warn("Invalid `api` query param, ignoring:", fromQuery);
    }
  }

  return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_LOCALHOST;
};

export const ApiProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [baseUrl] = useState<string>(resolveInitialBaseUrl);
  const wsBaseUrl = httpToWs(baseUrl);

  const fetchWithHeaders = useCallback(async (url: string, options: RequestInit = {}): Promise<Response> => {
    // Attach the Supabase JWT as X-Nori-JWT so LeLab can forward it to Nori-Backend
    // (auth + per-customer metering). Every fetchWithHeaders call targets the LeLab
    // backend, which ignores the header on routes that don't need it — so this is safe
    // for all callers and only present when signed in. Without it, authed routes like
    // the LLM proxy (/nori/llm/*) reach Nori-Backend with no Bearer token and 401.
    const token = await getAccessToken();
    // Local API token (see lib/localAuth.ts): only for requests that actually
    // target the LeLab base URL. In direct-backend mode noriRequest routes to
    // Nori-Backend through this same fetcher — the gate keeps the local
    // capability secret (and an unexpected CORS header) off that cross-site path.
    const localToken = url.startsWith(baseUrl) ? getLocalToken() : null;
    return fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Nori-JWT": token } : {}),
        ...(localToken ? { [LOCAL_TOKEN_HEADER]: localToken } : {}),
        ...options.headers,
      },
    });
  }, [baseUrl]);

  const value = useMemo(
    () => ({ baseUrl, wsBaseUrl, fetchWithHeaders }),
    [baseUrl, wsBaseUrl, fetchWithHeaders]
  );

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
};

export const useApi = (): ApiContextType => {
  const context = useContext(ApiContext);
  if (context === undefined) {
    throw new Error("useApi must be used within an ApiProvider");
  }
  return context;
};
