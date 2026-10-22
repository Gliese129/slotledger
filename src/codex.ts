import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { CLI } from "./launch.js";

/** Merge the server into project config, preserving other servers and slotledger tool policies. */
export function codexConfig(root: string, command: string, args: string[]): string {
  const path = join(root, ".codex", "config.toml");
  const config = existsSync(path) ? parse(readFileSync(path, "utf8")) : {};
  const table = (value: unknown): Record<string, any> => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a TOML table in ${path}`);
    return value as Record<string, any>;
  };
  const { slotboard: legacy, ...servers } = table(config.mcp_servers);
  const previous = table(servers.slotledger ?? legacy);
  // Switching this named server to stdio must also remove incompatible HTTP settings.
  const { url, bearer_token_env_var, http_headers, env_http_headers, http_headers_helper, auth, oauth, ...settings } = previous;
  config.mcp_servers = {
    ...servers,
    slotledger: {
      ...settings,
      command,
      args,
      cwd: root,
      env: { ...table(previous.env), SLOTLEDGER_ROOT: root, SLOTLEDGER_CLIENT: "codex" },
      env_vars: [...new Set([...(Array.isArray(previous.env_vars) ? previous.env_vars : []), "CODEX_THREAD_ID"])],
      tool_timeout_sec: previous.tool_timeout_sec ?? 3600,
    },
  };
  return stringify(config);
}

export function installCodex(root: string, config: string): void {
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "config.toml"), config);
  installSkill(join(root, ".agents", "skills", "slotledger"));
}

/** Copy the bundled skill into a client's skills directory */
export function installSkill(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), readFileSync(join(CLI, "..", "..", "skill", "SKILL.md")));
}
