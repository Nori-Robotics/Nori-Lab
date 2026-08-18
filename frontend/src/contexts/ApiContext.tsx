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

// Hosts the API base is allowed to point at. `fetchWithHeaders` attaches the
// Supabase JWT (and, for the local base, the lelab capability token) to every
// request to this base — so an attacker-chosen base is credential exfiltration.
// A single crafted link (`?api=https://attacker`) or a poisoned localStorage
// value must not be honored. Loopback covers the hosted-page→local-backend
// flow; the two prod hosts cover direct-backend mode. LAN-IP access, if ever
// needed, is a deliberate opt-in, not the default.
const ALLOWED_API_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
  "lab.norirobotics.com",
  "nori-backend-production.up.railway.app",
]);

/** True when `raw` parses and its host is allowlisted (any port, http/https). */
const isAllowedApiUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      ALLOWED_API_HOSTS.has(u.hostname)
    );
  } catch {
    return false;
  }
};

/** Overwrite the persisted API base URL (used by the bootstrap self-heal when
 *  the stored value points at a dead server — see NoriContext). Rejects any
 *  non-allowlisted host so the self-heal can't be steered to an attacker. */
export const persistApiBaseUrl = (url: string): void => {
  if (!isAllowedApiUrl(url)) {
    console.warn("Refusing to persist non-allowlisted API base:", url);
    return;
  }
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
    if (isAllowedApiUrl(fromQuery)) {
      const clean = fromQuery.replace(/\/$/, "");
      window.localStorage.setItem(STORAGE_KEY, clean);
      return clean;
    }
    console.warn("Ignoring non-allowlisted `api` query param:", fromQuery);
  }

  // Defense in depth: a value poisoned into storage before this check existed
  // (or by another tab) is discarded rather than trusted.
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && isAllowedApiUrl(stored)) return stored;
  return DEFAULT_LOCALHOST;
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
