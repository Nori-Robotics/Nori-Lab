// NORI: Additive. Vitest config for the app's unit tests (currently ScriptDriver's op->ExternalJog
// mapping — docs/llm_integration_plan.md A6). Kept separate from vite.config.ts so tests don't pull
// the React/SWC plugin chain. Node environment: the units under test (ScriptDriver + @nori/sdk core)
// are import-safe in Node — no DOM needed. Aliases mirror vite.config.ts (subpaths before the bare
// "@nori/sdk" prefix, which would otherwise swallow them).
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@nori/sdk/mock", replacement: path.resolve(__dirname, "./packages/nori-sdk/src/entry-mock.ts") },
      { find: "@nori/sdk/vr", replacement: path.resolve(__dirname, "./packages/nori-sdk/src/entry-vr.ts") },
      { find: "@nori/sdk/supabase", replacement: path.resolve(__dirname, "./packages/nori-sdk/src/signaling-supabase.ts") },
      { find: "@nori/sdk", replacement: path.resolve(__dirname, "./packages/nori-sdk/src/index.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
