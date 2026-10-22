import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Non-app asset directories (also gitignored):
    "skills/**",
    "download/**",
    "upload/**",
    // Ops scripts (not app code — mirror Gen-1 convention):
    "tools/**",
    // One-off document generator scripts (CommonJS, not app code — Task 173):
    "scripts/gtp/**",
  ]),
]);

export default eslintConfig;
