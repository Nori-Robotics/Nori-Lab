// NORI: Additive file. Typed client for Nori-Backend, reached *through* the LeLab
// Python server's `/nori/*` proxy routes (same origin as the rest of the app). The
// browser attaches the Supabase JWT as `X-Nori-JWT`; LeLab forwards it to Nori-Backend
// as `Authorization: Bearer ...`. See NORI_PLAN.md "Auth model".
//
// Response shapes come from `./types.ts`, auto-generated from Nori-Backend's openapi.json
// (regenerate with `npm run gen:types`).

import { apiRequest, type Fetcher, type ApiRequestOptions } from "@/lib/apiClient";
import { getAccessToken } from "@/nori/auth/session";
import type { components } from "@/nori/api/types";

export type CustomerProfile = components["schemas"]["CustomerProfile"];
/** GET /customers/me returns the profile, or this shape when not yet provisioned. */
export type NotProvisioned = { provisioned: false } & Record<string, unknown>;
export type CustomerMe = CustomerProfile | NotProvisioned;

export function isProvisioned(me: CustomerMe): me is CustomerProfile {
  return (me as NotProvisioned).provisioned !== false && "id" in me;
}

export interface NoriPublicConfig {
  noriBackendUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  configured: boolean;
}

/** Build the fetcher that injects the Nori JWT header on top of the base fetcher. */
function withNoriAuth(fetcher: Fetcher): Fetcher {
  return async (url, options = {}) => {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };
    if (token) headers["X-Nori-JWT"] = token;
    return fetcher(url, { ...options, headers });
  };
}

/**
 * Make an authenticated request to a LeLab `/nori/*` proxy route.
 * `baseUrl` is the LeLab server (from ApiContext), not Nori-Backend directly.
 */
export function noriRequest<T = unknown>(
  baseUrl: string,
  fetcher: Fetcher,
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  return apiRequest<T>(baseUrl, withNoriAuth(fetcher), path, options);
}

/** Public config bootstrap — does not require auth. */
export function getNoriConfig(baseUrl: string, fetcher: Fetcher): Promise<NoriPublicConfig> {
  return apiRequest<NoriPublicConfig>(baseUrl, fetcher, "/nori/config", {
    action: "Load Nori config",
  });
}

// -- customers / provisioning (Phase 2) ----------------------------------------

/** POST /nori/customers/me/provision — idempotent; safe on every sign-in. */
export function provisionCustomer(baseUrl: string, fetcher: Fetcher): Promise<CustomerProfile> {
  return noriRequest<CustomerProfile>(baseUrl, fetcher, "/nori/customers/me/provision", {
    method: "POST",
    action: "Provision account",
  });
}

/** GET /nori/customers/me — profile, or NotProvisioned if not yet provisioned. */
export function getCustomer(baseUrl: string, fetcher: Fetcher): Promise<CustomerMe> {
  return noriRequest<CustomerMe>(baseUrl, fetcher, "/nori/customers/me", {
    action: "Load account",
  });
}
