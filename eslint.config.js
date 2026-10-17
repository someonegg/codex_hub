import { tseslint, reactHooks, simpleImportSort } from "@codex-hub/client-lint";

export default tseslint.config(
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "scripts/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooks,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "simple-import-sort/imports": [
        "error",
        { groups: [["^\\u0000"], ["^react", "^@?\\w"], ["^.*shared/"], ["^\\."]] },
      ],
      "simple-import-sort/exports": "error",
    },
  },
  {
    files: ["src/client/**/*.{ts,tsx}", "tests/client/**/*.{ts,tsx}"],
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  {
    files: ["src/server/**/*.ts", "tests/server/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "simple-import-sort/imports": [
        "error",
        { groups: [["^\\u0000"], ["^node:"], ["^@?\\w"], ["^\\."]] },
      ],
    },
  },
);
