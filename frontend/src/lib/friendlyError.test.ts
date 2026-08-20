import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiError, friendlyErrorMessage } from "./apiClient";

const OUTAGE = "Sorry, our servers are experiencing interruptions. Please check back later.";

describe("friendlyErrorMessage", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("maps a dead network (fetch's TypeError) to the outage line", () => {
    expect(friendlyErrorMessage(new TypeError("Failed to fetch"))).toBe(OUTAGE);
  });

  it("maps 5xx to the outage line", () => {
    expect(friendlyErrorMessage(new ApiError("x", 503, "upstream gone"))).toBe(OUTAGE);
  });

  it("turns the local-token 401 into something the reader can act on", () => {
    const detail =
      "Missing or invalid local API token. Launch via `lelab` (or the desktop app) so the browser is opened with the token URL, or append ?token=<LELAB_TOKEN> once to set the auth cookie.";
    const msg = friendlyErrorMessage(new ApiError(`Load your library failed: ${detail}`, 401, detail));
    expect(msg).toBe(
      "Nori Lab can't reach the Nori app on your computer. Open (or restart) the desktop app, then try again."
    );
    expect(msg).not.toMatch(/token|lelab|cookie/i);
  });

  it("keeps a specific, actionable 4xx message from the server", () => {
    expect(friendlyErrorMessage(new ApiError("x", 409, "That robot is already paired."))).toBe(
      "That robot is already paired."
    );
  });

  it("never leaks a raw status code to the reader", () => {
    expect(friendlyErrorMessage(new ApiError("Load your library failed: 502", 502, null))).toBe(OUTAGE);
  });

  it("logs the original for support", () => {
    const err = new ApiError("x", 500, "boom");
    friendlyErrorMessage(err);
    expect(console.error).toHaveBeenCalledWith("[nori] request failed:", err);
  });
});
