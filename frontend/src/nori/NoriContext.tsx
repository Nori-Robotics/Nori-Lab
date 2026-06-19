// NORI: Additive file. Bootstraps Nori on app load: fetches `/nori/config` from the
// LeLab server, initializes the Supabase client, and exposes config + auth state to the
// Nori pages. Wrapping only the `/nori/*` routes keeps this out of the upstream LeLab UI.

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { useApi } from "@/contexts/ApiContext";
import { getNoriConfig, type NoriPublicConfig } from "@/nori/api/client";
import { initSupabase } from "@/nori/auth/supabase";
import { getSession, onAuthStateChange } from "@/nori/auth/session";

interface NoriContextType {
  config: NoriPublicConfig | null;
  /** True once config is loaded and Supabase is configured. */
  ready: boolean;
  /** Still fetching `/nori/config`. */
  loading: boolean;
  /** Set if bootstrap failed (backend unreachable or Supabase env missing). */
  error: string | null;
  session: Session | null;
}

const NoriContext = createContext<NoriContextType | undefined>(undefined);

export const NoriProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [config, setConfig] = useState<NoriPublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      try {
        const cfg = await getNoriConfig(baseUrl, fetchWithHeaders);
        if (cancelled) return;
        setConfig(cfg);
        if (cfg.configured) {
          initSupabase(cfg);
          setSession(await getSession());
          unsubscribe = onAuthStateChange(setSession);
        } else {
          setError(
            "Nori auth is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in the laptop environment."
          );
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [baseUrl, fetchWithHeaders]);

  const value = useMemo<NoriContextType>(
    () => ({
      config,
      ready: !!config?.configured && !error,
      loading,
      error,
      session,
    }),
    [config, loading, error, session]
  );

  return <NoriContext.Provider value={value}>{children}</NoriContext.Provider>;
};

export const useNori = (): NoriContextType => {
  const ctx = useContext(NoriContext);
  if (ctx === undefined) throw new Error("useNori must be used within a NoriProvider");
  return ctx;
};
