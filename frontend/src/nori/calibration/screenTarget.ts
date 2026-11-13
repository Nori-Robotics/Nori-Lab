/** Physical geometry contract for nori_ws#52. Device estimates never count as verification. */
export const TARGET_PATH = "/nori/calibration-target";
export const PROFILE_STORAGE_KEY = "nori:screen-target-profile:v1";
export const REFERENCE_MM = 40;
export const INNER_COLUMNS = 9;
export const INNER_ROWS = 7;
export const SQUARE_COLUMNS = INNER_COLUMNS + 1;
export const SQUARE_ROWS = INNER_ROWS + 1;
export const BORDER_SQUARES = 1;

export const PHONE_PROFILES = [
  {
    id: "pixel-6", name: "Google Pixel 6", ppi: 411,
    source: "https://support.google.com/pixelphone/answer/7158570?hl=en",
  },
  { id: "other", name: "Another phone or tablet", ppi: null, source: null },
] as const;
export type PhoneProfileId = typeof PHONE_PROFILES[number]["id"];
export type CameraRole = "front" | "overhead";

export interface ScreenEnvironment {
  screenWidth: number;
  screenHeight: number;
  dpr: number;
  zoom: number;
  orientation: string;
}

export interface VerifiedScreenProfile {
  version: 1;
  phone: PhoneProfileId;
  cssPixelsPerMm: number;
  verifiedAt: string;
  environment: ScreenEnvironment;
}

export function isTargetPath(path: string): boolean {
  return path.replace(/\/+$/, "") === TARGET_PATH;
}

export function validEnvironment(e: ScreenEnvironment): boolean {
  return !!e && [e.screenWidth, e.screenHeight, e.dpr, e.zoom].every(n => Number.isFinite(n) && n > 0)
    && typeof e.orientation === "string" && e.orientation.length > 0;
}

export function sameEnvironment(a: ScreenEnvironment, b: ScreenEnvironment): boolean {
  return validEnvironment(a) && validEnvironment(b)
    && a.screenWidth === b.screenWidth && a.screenHeight === b.screenHeight
    && Math.abs(a.dpr - b.dpr) < 0.0001 && Math.abs(a.zoom - b.zoom) < 0.005
    && a.orientation === b.orientation;
}

/** Browser DPR is only an estimate of panel mapping; the ruler check is still mandatory. */
export function estimatedScale(phone: PhoneProfileId, dpr: number): number {
  const ppi = PHONE_PROFILES.find(p => p.id === phone)?.ppi;
  const estimate = ppi && Number.isFinite(dpr) && dpr > 0 ? ppi / 25.4 / dpr : 96 / 25.4;
  return Math.max(1, Math.min(30, estimate));
}

export function readSavedProfile(raw: string | null, environment: ScreenEnvironment): VerifiedScreenProfile | null {
  try {
    const p = JSON.parse(raw ?? "null") as VerifiedScreenProfile | null;
    if (!p || p.version !== 1 || !PHONE_PROFILES.some(item => item.id === p.phone)
      || !Number.isFinite(p.cssPixelsPerMm) || p.cssPixelsPerMm < 1 || p.cssPixelsPerMm > 30
      || typeof p.verifiedAt !== "string" || !Number.isFinite(Date.parse(p.verifiedAt))
      || !sameEnvironment(p.environment, environment)) return null;
    return p;
  } catch { return null; }
}

export function boardGeometry(requestedSquareMm: number, scale: number, dpr: number) {
  if (![requestedSquareMm, scale, dpr].every(n => Number.isFinite(n) && n > 0)
    || requestedSquareMm > 20 || scale > 30 || dpr > 16) throw new Error("Invalid screen target dimensions");
  // One whole number of backing pixels per cell, identical on X/Y. Never stretch to fit.
  const squareDevicePixels = Math.max(1, Math.round(requestedSquareMm * scale * dpr));
  const squareCssPixels = squareDevicePixels / dpr;
  const actualSquareMm = squareCssPixels / scale;
  const outerColumns = SQUARE_COLUMNS + 2 * BORDER_SQUARES;
  const outerRows = SQUARE_ROWS + 2 * BORDER_SQUARES;
  return {
    squareDevicePixels, squareCssPixels, actualSquareMm,
    widthDevicePixels: outerColumns * squareDevicePixels,
    heightDevicePixels: outerRows * squareDevicePixels,
    widthCssPixels: outerColumns * squareCssPixels,
    heightCssPixels: outerRows * squareCssPixels,
    outerWidthMm: outerColumns * actualSquareMm,
    outerHeightMm: outerRows * actualSquareMm,
  };
}
export type BoardGeometry = ReturnType<typeof boardGeometry>;

/** The coordinate is a backing-pixel cell, including the uninterrupted outer white border. */
export function blackCell(column: number, row: number): boolean {
  return column >= BORDER_SQUARES && column < BORDER_SQUARES + SQUARE_COLUMNS
    && row >= BORDER_SQUARES && row < BORDER_SQUARES + SQUARE_ROWS
    && (column + row) % 2 === 0;
}

export function boardFits(g: BoardGeometry, width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height)
    && g.widthCssPixels + 32 <= width && g.heightCssPixels + 32 <= height;
}

export function targetManifest(profile: VerifiedScreenProfile, requestedSquareMm: number, role: CameraRole,
  environment: ScreenEnvironment, targetId: string) {
  if (!readSavedProfile(JSON.stringify(profile), environment) || Math.abs(environment.zoom - 1) >= 0.005)
    throw new Error("Verify screen size at normal zoom before exporting a target");
  if (role !== "front" && role !== "overhead") throw new Error("Unsupported camera role");
  const g = boardGeometry(requestedSquareMm, profile.cssPixelsPerMm, environment.dpr);
  return {
    schema_version: 1,
    artifact_type: "nori_screen_checkerboard",
    target_id: targetId,
    camera_role: role,
    pattern: "checkerboard",
    inner_corners: { columns: INNER_COLUMNS, rows: INNER_ROWS },
    squares: { columns: SQUARE_COLUMNS, rows: SQUARE_ROWS },
    border_squares: BORDER_SQUARES,
    square_size_m: g.actualSquareMm / 1000,
    requested_square_size_m: requestedSquareMm / 1000,
    pattern_size_m: { width: SQUARE_COLUMNS * g.actualSquareMm / 1000, height: SQUARE_ROWS * g.actualSquareMm / 1000 },
    outer_size_m: { width: g.outerWidthMm / 1000, height: g.outerHeightMm / 1000 },
    render: { square_device_pixels: g.squareDevicePixels, canvas_width: g.widthDevicePixels, canvas_height: g.heightDevicePixels },
    screen: {
      phone_profile: profile.phone,
      css_pixels_per_mm: profile.cssPixelsPerMm,
      verified_at: profile.verifiedAt,
      verification: { method: "operator_ruler_check", horizontal_mm: REFERENCE_MM, vertical_mm: REFERENCE_MM },
      environment,
    },
    status: "target_only_camera_calibration_not_performed",
  };
}
