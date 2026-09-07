import { describe, it, expect } from "vitest";
import { prefersMobileDrive } from "./mobileRoute";

const probe = (o: Partial<Parameters<typeof prefersMobileDrive>[0]>) =>
  ({ width: 1440, coarsePointer: false, forceConsole: false, ...o });

describe("prefersMobileDrive", () => {
  it("sends a phone to the drive pad", () => {
    expect(prefersMobileDrive(probe({ width: 390, coarsePointer: true }))).toBe(true);
  });
  it("leaves a narrow DESKTOP window on the console — it has a keyboard", () => {
    expect(prefersMobileDrive(probe({ width: 390, coarsePointer: false }))).toBe(false);
  });
  it("leaves a big touchscreen (tablet landscape / touch laptop) on the console", () => {
    expect(prefersMobileDrive(probe({ width: 1024, coarsePointer: true }))).toBe(false);
  });
  it("honours the explicit full-console escape hatch", () => {
    expect(prefersMobileDrive(probe({ width: 390, coarsePointer: true, forceConsole: true }))).toBe(false);
  });
});
