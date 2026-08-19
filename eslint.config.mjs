import tseslint from "typescript-eslint";
export default tseslint.config({
  files: ["**/*.{ts,tsx}"],
  ignores: ["node_modules/**", "out/**", "TaskGantt/generated/**"],
  languageOptions: { parser: tseslint.parser },
  rules: {}
});
