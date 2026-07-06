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
import {
  getNoriConfig,
  provisionCustomer,
  type CustomerProfile,
  type NoriPublicConfig,
} from "@/nori/api/client";
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
  /** The provisioned customer profile, once signed in + provisioned. */
  customer: CustomerProfile | null;
  /** Provisioning round-trip is in flight. */
  provisioning: boolean;
  /** Set if provisioning failed (distinct from the bootstrap `error`). */
  customerError: string | null;
  /** Replace the cached customer (e.g. after pairing returns an updated profile). */
  setCustomer: (c: CustomerProfile) => void;
  /**
   * Serial of the robot the app connects to (the "active" robot). With multi-robot
   * pairing the customer can own several; this is the one teleop/remote targets. Defaults
   * to the profile's `robot_serial_number` and is overridable from the Pairing page.
   * Persisted per-user in localStorage so the choice survives reloads. Null when unpaired.
   */
  activeRobotSerial: string | null;
  /** Pick which paired robot is active. Pass null to clear. */
  setActiveRobotSerial: (serial: string | null) => void;
}

/** localStorage key for the active-robot choice, scoped per auth user. */
const activeRobotKey = (userId: string) => `nori:activeRobot:${userId}`;

const NoriContext = createContext<NoriContextType | undefined>(undefined);

export const NoriProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { baseUrl, fetchWithHeaders } = useApi();
  const [config, setConfig] = useState<NoriPublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [activeRobotSerial, setActiveRobotSerialState] = useState<string | null>(null);

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

  // Provision on sign-in. Idempotent backend call, so running it whenever a session
  // appears (fresh login or restored on reload) is safe and keeps `customer` populated.
  // Keyed on the user id so it re-runs on account switch but not on token refresh.
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      setCustomer(null);
      setCustomerError(null);
      return;
    }
    let cancelled = false;
    setProvisioning(true);
    setCustomerError(null);
    (async () => {
      try {
        const profile = await provisionCustomer(baseUrl, fetchWithHeaders);
        if (!cancelled) setCustomer(profile);
      } catch (e) {
        if (!cancelled) setCustomerError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setProvisioning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, baseUrl, fetchWithHeaders]);

  // Seed the active-robot choice when the customer (or account) changes: prefer a
  // previously-persisted selection for this user, else fall back to the profile's serial.
  // The Pairing page corrects a stale/removed selection once it has the full robot list.
  const pairedSerial = customer?.robot_serial_number ?? null;
  useEffect(() => {
    if (!userId) {
      setActiveRobotSerialState(null);
      return;
    }
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(activeRobotKey(userId));
    } catch {
      // localStorage may be unavailable (private mode); fall back to the profile serial.
    }
    setActiveRobotSerialState(stored ?? pairedSerial);
  }, [userId, pairedSerial]);

  const setActiveRobotSerial = React.useCallback(
    (serial: string | null) => {
      setActiveRobotSerialState(serial);
      if (!userId) return;
      try {
        if (serial) window.localStorage.setItem(activeRobotKey(userId), serial);
        else window.localStorage.removeItem(activeRobotKey(userId));
      } catch {
        // Non-fatal: the choice still applies for this session, just won't persist.
      }
    },
    [userId]
  );

  const value = useMemo<NoriContextType>(
    () => ({
      config,
      ready: !!config?.configured && !error,
      loading,
      error,
      session,
      customer,
      provisioning,
      customerError,
      setCustomer,
      activeRobotSerial,
      setActiveRobotSerial,
    }),
    [
      config,
      loading,
      error,
      session,
      customer,
      provisioning,
      customerError,
      activeRobotSerial,
      setActiveRobotSerial,
    ]
  );

  return <NoriContext.Provider value={value}>{children}</NoriContext.Provider>;
};

export const useNori = (): NoriContextType => {
  const ctx = useContext(NoriContext);
  if (ctx === undefined) throw new Error("useNori must be used within a NoriProvider");
  return ctx;
};
