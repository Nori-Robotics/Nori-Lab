import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(
    Boolean
  ),
  // Strip console.log / debug / info in production minification; keep
  // console.warn and console.error for observability of real problems.
  esbuild: {
    pure:
      mode === "production"
        ? ["console.log", "console.debug", "console.info"]
        : [],
  },
  preview: {
    allowedHosts: ["lerobot-lelab.hf.space"],
  },
  resolve: {
    // Array form: order matters — the @nori/sdk subpaths must precede the bare "@nori/sdk"
    // prefix (which would otherwise swallow "@nori/sdk/vr" etc). External devs resolve these
    // via the package's `exports` map; the app resolves them straight to source (no build step).
    alias: [
      { find: "@nori/sdk/vr", replacement: path.resolve(__dirname, "./packages/nori-sdk/src/entry-vr.ts") },
      { find: "@nori/sdk/supabase", replacement: path.resolve(__dirname, "./packages/nori-sdk/src/signaling-supabase.ts") },
      { find: "@nori/sdk", replacement: path.resolve(__dirname, "./packages/nori-sdk/src/index.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
}));
