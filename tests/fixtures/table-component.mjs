import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function loadTableComponent() {
  const source = await readFile(new URL("../../app/translation-table.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/"react\/jsx-runtime"/g, JSON.stringify(import.meta.resolve("react/jsx-runtime")));
  return (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`)).TranslationTable;
}
