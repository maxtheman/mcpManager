import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import sheriff from "@softarc/eslint-plugin-sheriff";
import importPlugin from "eslint-plugin-import";
import unusedImports from "eslint-plugin-unused-imports";
import promise from "eslint-plugin-promise";
import globals from "globals";

const sourceFiles = ["**/*.{ts,tsx,js,jsx}"];
const baseGlobals = {
  ...globals.node,
  ...globals.browser,
  Bun: "readonly",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
    ],
  },
  js.configs.recommended,
  {
    files: sourceFiles,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: baseGlobals,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "@softarc/sheriff": sheriff,
      import: importPlugin,
      "unused-imports": unusedImports,
      promise,
    },
    rules: {
      "no-undef": "off",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
      "import/order": "off",
      "promise/always-return": "error",
      "promise/catch-or-return": "error",
      "promise/no-return-wrap": "error",
      "promise/param-names": "error",
      "promise/no-nesting": "error",
      "promise/no-new-statics": "error",
      "promise/no-multiple-resolved": "error",
      "promise/no-return-in-finally": "error",
    },
  },
  {
    files: ["apps/gateway/src/**/*.{ts,tsx}"],
    rules: {
      "@softarc/sheriff/dependency-rule": "error",
      "@softarc/sheriff/encapsulation": "error",
    },
  },
  {
    files: ["apps/gateway/src/{core,infra,shared}/**/*.{ts,tsx}"],
    rules: {
      complexity: ["error", 18],
      "max-depth": ["error", 4],
      "max-nested-callbacks": ["error", 3],
      "max-params": ["error", 5],
      "max-statements": ["error", 40],
      "max-lines-per-function": [
        "error",
        { max: 120, skipBlankLines: true, skipComments: true },
      ],
      "no-else-return": "error",
      "no-implicit-coercion": "error",
      "no-lonely-if": "error",
      "no-nested-ternary": "error",
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    files: ["apps/gateway/src/entry/**/*.{ts,tsx}"],
    rules: {
      complexity: "off",
      "max-depth": "off",
      "max-statements": "off",
      "max-lines-per-function": "off",
      "no-nested-ternary": "off",
      "import/order": "off",
    },
  },
  {
    files: ["apps/gateway/scripts/**/*.ts", "scripts/reliability/**/*.ts"],
    rules: {
      complexity: "off",
      "max-depth": "off",
      "max-statements": "off",
      "max-lines-per-function": "off",
      "no-implicit-coercion": "off",
      "no-nested-ternary": "off",
      "import/order": "off",
      "promise/always-return": "off",
      "promise/no-nesting": "off",
    },
  },
  {
    files: ["eslint.config.js", "sheriff.config.ts"],
    rules: {
      "import/order": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
];
