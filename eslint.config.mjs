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
  ]),
  {
    rules: {
      // Allow _ prefix convention for intentionally unused destructured vars
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Test files — relax strict rules that don't add safety value in tests.
    files: ["src/test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      // Route handlers require NextRequest but tests pass plain Request with
      // an `as unknown as NextRequest` cast. Allowing `any` here is simpler
      // and the cast site is visible and isolated.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
