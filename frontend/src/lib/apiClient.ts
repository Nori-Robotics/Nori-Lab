export type Fetcher = (
  url: string,
  options?: RequestInit
) => Promise<Response>;

export class ApiError extends Error {
  status: number;
  detail: string | null;
  constructor(message: string, status: number, detail: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Turn a thrown request error into something a customer should read.
 *
 * The raw text is written for whoever is debugging the request — it names
 * headers, tokens and launch flags. That is the right thing in a log and the
 * wrong thing in a red box on a customer's screen, so the surfacing layer maps
 * it here. Anything genuinely actionable by the reader keeps its own wording;
 * everything else becomes one calm sentence.
 *
 * The original is logged to the console here rather than left to each call
 * site: this deliberately discards detail, and support still needs it.
 */
export function friendlyErrorMessage(err: unknown): string {
  console.error("[nori] request failed:", err);
  const OUTAGE =
    "Sorry, our servers are experiencing interruptions. Please check back later.";

  // fetch() rejects with a TypeError when it never got a response at all:
  // offline, DNS failure, or the server not listening.
  if (err instanceof TypeError) return OUTAGE;

  if (err instanceof ApiError) {
    // The server is up but broken, or a proxy in front of it is.
    if (err.status >= 500) return OUTAGE;

    // Local-API auth. The customer cannot act on "token" wording, but they CAN
    // act on "reopen the app", which is the actual fix.
    if (
      (err.status === 401 || err.status === 403) &&
      /local API token/i.test(err.detail ?? "")
    ) {
      return "Nori Lab can't reach the Nori app on your computer. Open (or restart) the desktop app, then try again.";
    }

    // Remaining 4xx are usually specific and actionable ("already paired",
    // "over your robot limit"), so the server's own wording is kept.
    if (err.detail) return err.detail;
    return OUTAGE;
  }

  // Errors we raise ourselves are already written for a reader.
  if (err instanceof Error && err.message) return err.message;
  return OUTAGE;
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Human-readable label for the error message, e.g. "Start training". */
  action?: string;
}

/**
 * Performs a request against the lelab backend and parses the JSON response.
 * Throws ApiError with FastAPI's `detail` field on non-2xx, or on JSON parse
 * failure. Use this in place of ad-hoc `r.ok` / `r.json()` branching.
 */
export async function apiRequest<T = unknown>(
  baseUrl: string,
  fetcher: Fetcher,
  path: string,
  { method = "GET", body, signal, action }: ApiRequestOptions = {}
): Promise<T> {
  const init: RequestInit = { method, signal };
  if (body !== undefined) init.body = JSON.stringify(body);

  const url = `${baseUrl}${path}`;
  const r = await fetcher(url, init);
  if (!r.ok) {
    let detail: string | null = null;
    try {
      const errBody = await r.json();
      detail = errBody?.detail ?? errBody?.message ?? null;
    } catch {
      // body wasn't JSON
    }
    const label = action || `${method} ${path}`;
    throw new ApiError(
      `${label} failed: ${detail ?? r.status}`,
      r.status,
      detail
    );
  }
  // 204 No Content
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}
