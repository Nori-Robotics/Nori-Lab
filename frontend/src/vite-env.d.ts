/// <reference types="vite/client" />

// Build-time public config for LeLab-free deploys (e.g. the hosted VR page). These are
// PUBLIC values only — the Supabase anon key is already served to every browser via
// `/nori/config`, so baking it into the bundle is not a secrets leak. Never put a
// service-role key or any server secret here; it would ship in the client bundle.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_NORI_BACKEND_URL?: string;
  // Public origin where the hosted VR page (`/nori/vr`) is served, e.g.
  // "https://app.nori.com". Used to build the laptop→headset handoff link. Falls back to
  // the current origin when unset (correct only when the app itself is hosted there).
  readonly VITE_VR_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
