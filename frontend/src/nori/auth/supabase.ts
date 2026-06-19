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
