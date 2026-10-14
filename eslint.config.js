import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "coverage",
      "screenshots",
      ".swarm",
      ".opencode",
      "playwright-report",
      "test-results",
      "docs",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
