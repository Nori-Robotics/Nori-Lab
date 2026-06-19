// NORI: Additive file. Session/JWT helpers on top of the Supabase client.
//
// The Supabase JS SDK owns token storage and auto-refresh; these helpers expose the
// pieces the rest of the app needs: the current access token (for the `X-Nori-JWT`
// header), sign-in/sign-out, and a subscription to auth changes.

import type { Session } from "@supabase/supabase-js";
import { getSupabase, isSupabaseReady } from "./supabase";

/**
 * Current Supabase access token (JWT), or null if signed out / not configured.
 * The SDK refreshes the token transparently, so reading it per-request is cheap and
 * always returns a valid (unexpired) token when a session exists.
 */
export async function getAccessToken(): Promise<string | null> {
  if (!isSupabaseReady()) return null;
  const { data } = await getSupabase().auth.getSession();
  return data.session?.access_token ?? null;
}

export async function getSession(): Promise<Session | null> {
  if (!isSupabaseReady()) return null;
  const { data } = await getSupabase().auth.getSession();
  return data.session;
}

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error("Sign-in succeeded but no session was returned.");
  return data.session;
}

export async function signOut(): Promise<void> {
  if (!isSupabaseReady()) return;
  await getSupabase().auth.signOut();
}

/** Subscribe to auth-state changes. Returns an unsubscribe function. */
export function onAuthStateChange(cb: (session: Session | null) => void): () => void {
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}
