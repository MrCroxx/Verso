import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const standaloneRoot = resolve(projectRoot, ".next/standalone");
const serverPath = resolve(standaloneRoot, "server.js");

if (!existsSync(serverPath)) {
  throw new Error("Standalone build not found. Run `npm run build` before `npm start`.");
}

cpSync(resolve(projectRoot, ".next/static"), resolve(standaloneRoot, ".next/static"), { recursive: true });
cpSync(resolve(projectRoot, "public"), resolve(standaloneRoot, "public"), { recursive: true });

process.env.HOSTNAME ||= "0.0.0.0";
process.env.PORT ||= "3000";
process.env.VERSO_DATA_DIR = resolve(projectRoot, process.env.VERSO_DATA_DIR || ".data");

await import(pathToFileURL(serverPath).href);
