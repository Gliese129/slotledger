import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PKG, launcher, stablePath } from "../src/launch.js";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "slotledger-launch-"))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(path: string, text = "", mode = 0o644) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
  chmodSync(join(dir, path), mode);
  return join(dir, path);
}
function link(path: string, to: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  symlinkSync(to, join(dir, path));
  return join(dir, path);
}

/** Writes the launcher and runs it with no node on PATH and an empty HOME, as a hook or the MCP server sees it */
function start(script: string, args: string[], env: Record<string, string> = {}) {
  // This machine's own node installs would otherwise be found
  const isolated = script.replace("/opt/homebrew/bin/node /usr/local/bin/node /home/linuxbrew/.linuxbrew/bin/node", "");
  const path = file("project/.project/run/slotledger", isolated, 0o755);
  const result = spawnSync(path, args, { env: { HOME: join(dir, "home"), PATH: "/usr/bin:/bin", ...env }, input: "", encoding: "utf8", timeout: 10_000 });
  expect(result.signal).toBeNull();
  return result;
}

describe("launcher commands", () => {
  it("calls one sh script from hooks and the MCP server on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const run = launcher("/work/it's", { platform, node: "/usr/bin/node", cli: "/opt/slotledger/dist/cli.js", npx: false });
      expect(run.path).toBe("/work/it's/.project/run/slotledger");
      expect(run.mcp).toEqual({ command: run.path, args: [] });
      expect(run.hook(["hook", "stop", "--client", "codex"])).toBe(`'/work/it'\\''s/.project/run/slotledger' hook stop --client codex`);
      expect(run.script).toMatch(/^#!\/bin\/sh\n/);
      expect(run.script).toContain("recorded='/usr/bin/node'");
      expect(run.script).toContain(`exec "$node" "$cli" "$@"`);
    }
  });

  it("starts the pinned version through npm exec with npm's own node", () => {
    const { script } = launcher("/p", { platform: "linux", node: "/usr/bin/node", npx: true });
    expect(script).toContain(`--package=${PKG.name}@${PKG.version} --call "$call"`);
    expect(script).toContain(String.raw`exec \"\$npm_node_execpath\" \"\$bin\"`);
    expect(script).not.toContain("npm-cli.js");
  });

  it("writes a cmd script on Windows and starts it through cmd", () => {
    const run = launcher("C:\\Users\\me\\My Project", { platform: "win32", node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\g\\cli.js", npx: false });
    expect(run.path).toBe("C:\\Users\\me\\My Project\\.project\\run\\slotledger.cmd");
    expect(run.mcp).toEqual({ command: "cmd", args: ["/d", "/c", run.path] });
    expect(run.hook(["hook", "session-start", "--client", "claude-code"])).toBe(String.raw`"C:\Users\me\My Project\.project\run\slotledger.cmd" hook session-start --client claude-code`);
    expect(run.script.startsWith("@echo off\r\n")).toBe(true);
    expect(run.script.replace(/\r\n/g, "")).not.toContain("\n");
    expect(run.script).toContain(`if exist "C:\\Program Files\\nodejs\\node.exe" set "NODE=C:\\Program Files\\nodejs\\node.exe"`);
    expect(run.script).toContain("where node");
    expect(run.script).toContain(`"%NODE%" "%CLI%" %*`);
    expect(run.script).not.toMatch(/\/bin\/sh|\$\(/);
    const npx = launcher("C:\\p", { platform: "win32", node: "C:\\n\\node.exe", npx: true }).script;
    expect(npx).toContain(`call "%NPM%" exec --yes --loglevel=error --no-update-notifier --package=${PKG.name}@${PKG.version} -- ${PKG.name} %*`);
  });
});

describe("stablePath", () => {
  it("maps a Homebrew Cellar path to its opt link only when the link leads to the same file", () => {
    const node = file("brew/Cellar/node@22/22.23.0/bin/node", "", 0o755);
    expect(stablePath(node)).toBe(node);
    link("brew/opt/node@22", "../Cellar/node@22/22.23.0");
    expect(stablePath(node)).toBe(join(dir, "brew/opt/node@22/bin/node"));
    expect(stablePath(join(dir, "brew/Cellar/node@22/22.23.0/lib/node_modules/npm/bin/npm-cli.js"))).toBe(join(dir, "brew/Cellar/node@22/22.23.0/lib/node_modules/npm/bin/npm-cli.js"));

    const other = file("brew/Cellar/node/24.1.0/bin/node", "", 0o755);
    file("brew/Cellar/node/25.0.0/bin/node", "", 0o755);
    link("brew/opt/node", "../Cellar/node/25.0.0");
    expect(stablePath(other)).toBe(other);
    expect(stablePath("/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });
});

describe("launcher at run time", () => {
  const cli = () => file("cli.js", "console.log(JSON.stringify({ node: process.execPath, args: process.argv.slice(2) }))");

  it("uses the recorded node without node on PATH", () => {
    const { script } = launcher(join(dir, "project"), { platform: process.platform, node: process.execPath, cli: cli(), npx: false });
    const result = start(script, ["hook", "stop", "it's"]);
    expect(JSON.parse(result.stdout)).toEqual({ node: process.execPath, args: ["hook", "stop", "it's"] });
  });

  it("falls back to nvm's default alias when the recorded node is gone", () => {
    for (const v of ["v20.1.0", "v22.9.0", "v22.23.0", "v24.0.0"]) link(`home/.nvm/versions/node/${v}/bin/node`, process.execPath);
    file("home/.nvm/alias/default", "lts/jod\n");
    file("home/.nvm/alias/lts/jod", "v22\n");
    const { script } = launcher(join(dir, "project"), { platform: process.platform, node: join(dir, "gone/bin/node"), cli: cli(), npx: false });
    const which = file("which.js", "console.log(process.argv0)");
    const picked = start(script.replace(/cli='[^']*'/, `cli='${which}'`), []);
    expect(picked.stdout.trim()).toBe(join(dir, "home/.nvm/versions/node/v22.23.0/bin/node"));
  });

  it("reports a missing node through systemMessage for hooks and stderr for the MCP server", () => {
    const { script } = launcher(join(dir, "project"), { platform: process.platform, node: join(dir, "gone/bin/node"), cli: cli(), npx: false });
    const hook = start(script, ["hook", "session-start", "--client", "claude-code"]);
    expect(hook.status).toBe(0);
    expect(JSON.parse(hook.stdout).systemMessage).toMatch(/could not start: no node found .*npx slotledger@latest init/);
    const serve = start(script, []);
    expect(serve.status).toBe(1);
    expect(serve.stdout).toBe("");
    expect(serve.stderr).toMatch(/could not start: no node found .*npx slotledger@latest init/);
  });

  it("fails fast when npm exec provides no slotledger command", () => {
    // A stand-in npm that runs --call the way npm exec does
    const bin = join(dir, "node/bin");
    link("node/bin/node", process.execPath);
    file("node/bin/npm", `#!/bin/sh\nfor a; do last=$a; done\nnpm_node_execpath=${JSON.stringify(process.execPath)} exec sh -c "$last"\n`, 0o755);
    const { script } = launcher(join(dir, "project"), { platform: process.platform, node: join(bin, "node"), npx: true });
    const hook = start(script, ["hook", "stop"]);
    expect(hook.status).toBe(0);
    expect(JSON.parse(hook.stdout).systemMessage).toContain(`npm exec did not provide the slotledger command of slotledger@${PKG.version}`);
    const serve = start(script, []);
    expect(serve.status).toBe(1);
    expect(serve.stderr).toContain("npm exec did not provide");

    file("node/bin/slotledger", "console.log(JSON.stringify(process.argv.slice(2)))", 0o755);
    expect(JSON.parse(start(script, ["hook", "it's", "a b"]).stdout)).toEqual(["hook", "it's", "a b"]);
  });
});
