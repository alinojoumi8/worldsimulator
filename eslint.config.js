import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "data/**"],
  },
  ...tseslint.configs.recommended,
  {
    // Determinism policy (ADR-0008): the simulation core must not read wall
    // clocks, ambient randomness, or locale-dependent collation. Time and
    // randomness are injected as ports.
    files: ["packages/engine/src/**/*.ts", "packages/shared/src/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message: "Nondeterministic in engine code — inject a wall-clock port (ADR-0008).",
        },
        {
          object: "Math",
          property: "random",
          message: "Use seeded RNG streams from @worldtangle/shared (ADR-0008).",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Argless new Date() is nondeterministic in engine code (ADR-0008).",
        },
        {
          selector: "CallExpression[callee.property.name='localeCompare']",
          message: "localeCompare is ICU/platform-dependent — use explicit comparators (ADR-0008).",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
