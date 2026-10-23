import { existsSync, readFileSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
export const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };

/** Running from npx's cache (~/.npm/_npx), which npm may clear at any time */
const fromNpx = CLI.split(/[\\/]/).includes("_npx");

export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `"${value}"` : "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * A path that survives upgrades of the same install: Homebrew's Cellar/<formula>/<version>/... becomes the
 * opt/<formula>/... link, when that link exists and leads to the same file
 */
export function stablePath(path: string): string {
  const m = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.*)$/.exec(path);
  if (!m) return path;
  const opt = `${m[1]}/opt/${m[2]}/${m[3]}`;
  try {
    return existsSync(opt) && realpathSync(opt) === realpathSync(path) ? opt : path;
  } catch {
    return path;
  }
}

export interface LaunchOptions {
  platform?: NodeJS.Platform;
  /** The node init ran with, tried first at run time */
  node?: string;
  cli?: string;
  /** Start PKG.version through npm exec instead of cli */
  npx?: boolean;
}

export interface Launcher {
  /** The script init writes, under .project/run/ */
  path: string;
  script: string;
  /** The MCP server's command and args */
  mcp: { command: string; args: string[] };
  /** A hook's command line */
  hook(args: string[]): string;
}

/**
 * Hooks and the MCP server start a launcher script that finds node at run time: they run without an interactive
 * shell, so node may not be on PATH (nvm), and a recorded versioned path goes away on upgrade (Homebrew, nvm)
 */
export function launcher(root: string, options: LaunchOptions = {}): Launcher {
  const platform = options.platform ?? process.platform;
  const node = platform === "win32" ? options.node ?? process.execPath : stablePath(options.node ?? process.execPath);
  const cli = platform === "win32" ? options.cli ?? CLI : stablePath(options.cli ?? CLI);
  const npx = options.npx ?? fromNpx;
  if (platform === "win32") {
    const path = win32.join(root, ".project", "run", "slotledger.cmd");
    return {
      path,
      script: cmdScript(node, cli, npx),
      // Windows can't spawn a .cmd directly without a shell
      mcp: { command: "cmd", args: ["/d", "/c", path] },
      hook: (args) => [shellQuote(path, platform), ...args].join(" "),
    };
  }
  const path = posix.join(root, ".project", "run", "slotledger");
  return { path, script: shScript(node, cli, npx), mcp: { command: path, args: [] }, hook: (args) => [shellQuote(path, platform), ...args].join(" ") };
}

const RERUN = `Run npx ${PKG.name}@latest init in this project to set it up again.`;

function shScript(node: string, cli: string, npx: boolean): string {
  const q = (s: string) => shellQuote(s, "linux");
  const pkg = `${PKG.name}@${PKG.version}`;
  const start = npx
    ? String.raw`# Put this node first on PATH for npm and the package's bin, then start this exact version through npm exec
dir=$(dirname "$node")
PATH="$dir:$PATH"; export PATH
npm="$dir/npm"
[ -x "$npm" ] || npm=$(command -v npm) || fail "no npm found next to $node"
call="hook=$hook; $fail_def; bin=\$(command -v ${PKG.name}) || fail 'npm exec did not provide the ${PKG.name} command of ${pkg}'; exec \"\$npm_node_execpath\" \"\$bin\""
for a in "$@"; do call="$call '$(printf '%s' "$a" | sed "s/'/'\\\\''/g")'"; done
exec "$npm" exec --yes --loglevel=error --no-update-notifier --package=${pkg} --call "$call"`
    : String.raw`cli=${q(cli)}
[ -f "$cli" ] || fail "$cli no longer exists"
exec "$node" "$cli" "$@"`;
  return String.raw`#!/bin/sh
# Starts ${PKG.name} for this project's hooks and MCP server. Written by ${PKG.name} init ${PKG.version}; rerun init to update it.
# These run without an interactive shell, so node may not be on PATH: look for it in places that survive upgrades.
recorded=${q(node)}
hook=; [ "$1" = hook ] && hook=1
# A hook reports through systemMessage and never blocks; the MCP server fails on stderr
fail_def='fail() {
  msg="${PKG.name} could not start: $1. ${RERUN}"
  if [ -n "$hook" ]; then printf "{\"systemMessage\":\"%s\"}\n" "$msg"; exit 0; fi
  printf "%s\n" "$msg" >&2; exit 1
}'
eval "$fail_def"

# nvm's default alias, followed to an installed version; else the newest installed one
nvm_default() {
  d=$NVM_DIR; [ -n "$d" ] || d=$HOME/.nvm
  [ -d "$d/versions/node" ] || return
  a=default; i=0
  while [ -f "$d/alias/$a" ] && [ $i -lt 5 ]; do a=$(sed 's/^v//' "$d/alias/$a"); i=$((i + 1)); done
  versions=$(ls "$d/versions/node" | sed 's/^v//' | sort -t. -k1,1nr -k2,2nr -k3,3nr)
  for v in $versions; do case "$v" in "$a" | "$a".*) echo "$d/versions/node/v$v/bin/node"; return ;; esac; done
  for v in $versions; do echo "$d/versions/node/v$v/bin/node"; return; done
}

find_node() {
  fnm=$FNM_DIR; [ -n "$fnm" ] || fnm=$HOME/.local/share/fnm
  mise=$MISE_DATA_DIR; [ -n "$mise" ] || mise=$HOME/.local/share/mise
  asdf=$ASDF_DATA_DIR; [ -n "$asdf" ] || asdf=$HOME/.asdf
  for n in "$recorded" "$(command -v node)" /opt/homebrew/bin/node /usr/local/bin/node /home/linuxbrew/.linuxbrew/bin/node \
    "$HOME/.volta/bin/node" "$fnm/aliases/default/bin/node" "$HOME/Library/Application Support/fnm/aliases/default/bin/node" \
    "$mise/shims/node" "$asdf/shims/node" "$(nvm_default)"; do
    [ -n "$n" ] && [ -x "$n" ] && [ ! -d "$n" ] && { echo "$n"; return 0; }
  done
  return 1
}
node=$(find_node) || fail "no node found ($recorded no longer exists and none is on PATH)"

${start}
`;
}

function cmdScript(node: string, cli: string, npx: boolean): string {
  const pkg = `${PKG.name}@${PKG.version}`;
  const start = npx
    ? `rem Put this node first on PATH for npm and the package's bin, then start this exact version through npm exec
for %%D in ("%NODE%") do set "NODEDIR=%%~dpD"
set "PATH=%NODEDIR%;%PATH%"
set "NPM=%NODEDIR%npm.cmd"
if not exist "%NPM%" set "NPM=npm"
call "%NPM%" exec --yes --loglevel=error --no-update-notifier --package=${pkg} -- ${PKG.name} %*
exit /b %errorlevel%`
    : `set "CLI=${cli}"
set "REASON=${PKG.name} is no longer installed where init found it"
if not exist "%CLI%" goto fail
"%NODE%" "%CLI%" %*
exit /b %errorlevel%`;
  return `@echo off
rem Starts ${PKG.name} for this project's hooks and MCP server. Written by ${PKG.name} init ${PKG.version}; rerun init to update it.
setlocal
set "HOOK="
if "%~1"=="hook" set "HOOK=1"
set "NODE="
if exist "${node}" set "NODE=${node}"
if not defined NODE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE=%ProgramFiles%\\nodejs\\node.exe"
if not defined NODE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\\node.exe" set "NODE=%NVM_SYMLINK%\\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\\Volta\\bin\\node.exe" set "NODE=%LOCALAPPDATA%\\Volta\\bin\\node.exe"
set "REASON=no node found"
if not defined NODE goto fail
${start}

rem A hook reports through systemMessage and never blocks; the MCP server fails on stderr
:fail
set "MSG=${PKG.name} could not start: %REASON%. ${RERUN}"
if defined HOOK echo {"systemMessage":"%MSG%"}
if defined HOOK exit /b 0
>&2 echo %MSG%
exit /b 1
`.replace(/\n/g, "\r\n");
}

/** A command line for a person or the AI to run in their own shell */
export function commandLine(args: string): string {
  return fromNpx ? `npx -y ${PKG.name}@${PKG.version} ${args}` : `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args}`;
}
