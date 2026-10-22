import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
export const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };

/** Running from npx's cache (~/.npm/_npx), which npm may clear at any time */
const fromNpx = CLI.split(/[\\/]/).includes("_npx");

export function shellQuote(value: string): string {
  return process.platform === "win32" ? JSON.stringify(value) : "'" + value.replace(/'/g, "'\\''") + "'";
}

/** The argv that starts this CLI with args, for hooks and the MCP server */
export function launch(args: string[] = []): string[] {
  // Use node by absolute path: hooks and the MCP server may not have node on PATH (e.g. nvm only applies in interactive shells)
  const node = process.execPath;
  if (!fromNpx) return [node, CLI, ...args];
  // Start this exact version through npm exec instead of the cache path. --call runs the bin with node by absolute path,
  // since the bin's `#!/usr/bin/env node` fails when node isn't on PATH.
  const npm = process.env.npm_execpath ?? join(dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const call = [shellQuote(node), `"$(command -v ${PKG.name})"`, ...args.map(shellQuote)].join(" ");
  return [node, npm, "exec", "--yes", "--loglevel=error", "--no-update-notifier", `--package=${PKG.name}@${PKG.version}`, "--call", call];
}

/** A command line for a person or the AI to run in their own shell */
export function commandLine(args: string): string {
  return fromNpx ? `npx -y ${PKG.name}@${PKG.version} ${args}` : `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args}`;
}
