// NORI: Additive file. Lazily-initialized Supabase client.
//
// Config (URL + anon key) comes from the LeLab server at `/nori/config`, so there is no
// build-time frontend .env to manage. The client is created once, on first use, after the
// config has been fetched. Call `initSupabase(config)` during app bootstrap, then
// `getSupabase()` everywhere else.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NoriPublicConfig } from "@/nori/api/client";

let client: SupabaseClient | null = null;

/** Initialize the singleton from fetched config. Idempotent. */
export function initSupabase(config: NoriPublicConfig): SupabaseClient {
  if (client) return client;
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in the laptop environment."
    );
  }
  client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // localhost, same-origin: localStorage is acceptable per NORI_PLAN.md "Auth model".
      storageKey: "nori.supabase.auth",
    },
  });
  return client;
}

/** Get the initialized client, or throw if `initSupabase` hasn't run yet. */
export function getSupabase(): SupabaseClient {
  if (!client) {
    throw new Error("Supabase client not initialized — call initSupabase(config) first.");
  }
  return client;
}

/** Whether the client has been initialized (config present + valid). */
export function isSupabaseReady(): boolean {
  return client !== null;
}

// ---------------------------------------------------------------------------
// Init gate — lets token lookups WAIT for bootstrap instead of failing.
//
// On a hard refresh, page components mount (and fire authenticated fetches)
// concurrently with NoriProvider's async bootstrap (fetch /nori/config →
// initSupabase). Without a gate, getAccessToken() sees an uninitialized
// client, returns null, and the request goes out with no auth header — the
// backend 401s ("Missing or malformed Authorization header") even though a
// valid session sits in localStorage. In-app navigation never hits this
// (client long since initialized), which is why it only shows on refresh.
//
// NoriProvider calls settleSupabaseGate() when bootstrap finishes EITHER way
// (initialized, unconfigured, or LeLab unreachable), so waiters never hang on
// the hosted/no-config paths. The timeout is a safety net only (e.g. a page
// rendered outside NoriProvider in a test).
// ---------------------------------------------------------------------------
let gateSettled = false;
let settleGate: () => void = () => {};
const gate = new Promise<void>((resolve) => {
  settleGate = () => {
    gateSettled = true;
    resolve();
  };
});

/** Mark auth bootstrap finished (successfully or not). Idempotent. */
export function settleSupabaseGate(): void {
  settleGate();
}

/** Resolves once auth bootstrap has finished (or after `timeoutMs`, as a
 * safety net so a missing provider degrades to today's behavior). */
export function whenSupabaseSettled(timeoutMs = 6000): Promise<void> {
  if (gateSettled) return Promise.resolve();
  return Promise.race([
    gate,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
