import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "node_modules/pdfjs-dist");
const targetRoot = resolve(root, "public/pdfjs");
const assetDirectories = ["cmaps", "standard_fonts", "wasm", "iccs"];

await mkdir(targetRoot, { recursive: true });
await Promise.all(
  assetDirectories.map((directory) =>
    cp(resolve(sourceRoot, directory), resolve(targetRoot, directory), {
      recursive: true,
      force: true,
    }),
  ),
);
