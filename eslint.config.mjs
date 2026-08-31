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
      // Подчёркивание в начале имени — общепринятая пометка «параметр нужен типу, а не коду»:
      // в тестах так описываются сигнатуры моков (vi.fn((..._args) => …)). Ругаться на них —
      // значит заставлять либо ломать типы, либо привыкать к вечно жёлтому линтеру; привычка к
      // жёлтому и прячет настоящие предупреждения.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
]);

export default eslintConfig;
