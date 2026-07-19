// Flat ESLint config. Intentionally conservative: high-signal correctness rules as errors,
// stylistic/opinion rules as warnings, so the initial adoption does not block on a large backlog.
// Prettier owns formatting (eslint-config-prettier disables conflicting rules).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // build/ holds electron-builder packaging hooks (CommonJS, Node globals) outside the TS project.
    ignores: [
      "dist/**",
      "dist-desktop/**",
      "node_modules/**",
      "coverage/**",
      "**/*.d.ts",
      "build/**",
      "benchmarks/results/**",
      "benchmarks/scenarios/**/fixture-repo/**",
      "benchmarks/scenarios/**/fixtures/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "warn"
    }
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  }
);
